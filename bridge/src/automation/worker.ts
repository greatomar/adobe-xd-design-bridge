/**
 * Thin transport to the Windows UI Automation worker
 * (automation/PrototypeAutomation/uia-worker.ps1).
 *
 * One process per command. The worker is stateless — XD itself is the state —
 * so this keeps timeouts, stderr capture and cleanup trivial and avoids a
 * long-lived child that can wedge if XD restarts.
 *
 * Nothing in this module clicks. The worker only uses UI Automation patterns;
 * a control that cannot be driven that way produces a structured error.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_DIR, log } from "../util.ts";

export interface WorkerResultOk {
  ok: true;
  cmd: string;
  result: Record<string, unknown>;
}
export interface WorkerResultErr {
  ok: false;
  cmd: string;
  error: { code: string; message: string; stage?: string };
}
export type WorkerResult = WorkerResultOk | WorkerResultErr;

export interface AutomationRunner {
  run(cmd: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<WorkerResult>;
}

export interface PowerShellRunnerOptions {
  /** absolute path to uia-worker.ps1 (defaults to automation/PrototypeAutomation/) */
  scriptPath?: string;
  /** powershell executable (defaults to powershell.exe = Windows PowerShell 5.1) */
  powershellPath?: string;
  /** default per-command timeout */
  timeoutMs?: number;
}

export function defaultWorkerScript(): string {
  return process.env.XD_UIA_WORKER
    || join(BRIDGE_DIR, "automation", "PrototypeAutomation", "uia-worker.ps1");
}

export class PowerShellUiaRunner implements AutomationRunner {
  private scriptPath: string;
  private powershellPath: string;
  private timeoutMs: number;

  constructor(opts: PowerShellRunnerOptions = {}) {
    this.scriptPath = opts.scriptPath ?? defaultWorkerScript();
    // Windows PowerShell 5.1: System.Windows.Automation lives in the .NET
    // Framework GAC, which PowerShell 7 (pwsh) does not expose.
    this.powershellPath = opts.powershellPath ?? process.env.XD_UIA_POWERSHELL ?? "powershell.exe";
    this.timeoutMs = opts.timeoutMs ?? 45_000;
  }

  run(cmd: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<WorkerResult> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    if (!existsSync(this.scriptPath)) {
      return Promise.resolve({
        ok: false,
        cmd,
        error: { code: "WORKER_UNAVAILABLE", message: `UI Automation worker not found: ${this.scriptPath}`, stage: cmd },
      });
    }

    const payload = Buffer.from(JSON.stringify({ cmd, args }), "utf8").toString("base64");
    const child = spawn(this.powershellPath, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", this.scriptPath,
      "-Base64", payload,
    ], { windowsHide: true });

    return new Promise<WorkerResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: WorkerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({
          ok: false,
          cmd,
          error: { code: "AUTOMATION_TIMEOUT", message: `UIA worker '${cmd}' did not finish within ${timeoutMs}ms`, stage: cmd },
        });
      }, timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => { stdout += c; });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (c: string) => { stderr += c; });

      child.on("error", (e: NodeJS.ErrnoException) => {
        const code = e.code === "ENOENT" ? "WORKER_UNAVAILABLE" : "UNSUPPORTED_XD_UI";
        finish({ ok: false, cmd, error: { code, message: String(e.message), stage: cmd } });
      });

      child.on("close", () => {
        const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
        if (!line) {
          finish({
            ok: false,
            cmd,
            error: {
              code: "WORKER_UNAVAILABLE",
              message: `UIA worker produced no JSON. stderr: ${stderr.trim().slice(0, 800) || "(empty)"}`,
              stage: cmd,
            },
          });
          return;
        }
        try {
          // XD element names can contain raw control characters, which are
          // illegal inside a JSON string. Control characters are valid only as
          // structural whitespace, so folding them to spaces keeps the document
          // valid and only ever affects cosmetic text.
          const cleaned = line.replace(/[\u0000-\u001F]/g, " ");
          const parsed = JSON.parse(cleaned) as WorkerResult;
          if (typeof parsed.ok !== "boolean") throw new Error("missing ok flag");
          log("debug", `uia worker ${cmd}`, parsed.ok ? { ok: true } : parsed.error);
          finish(parsed);
        } catch (e) {
          finish({
            ok: false,
            cmd,
            error: { code: "WORKER_UNAVAILABLE", message: `unparseable worker output: ${line.slice(0, 400)} (${String(e)})`, stage: cmd },
          });
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Persistent worker (same script, -Serve mode: one JSON request per line)
//
// Why: a cold edge currently costs ~33 s, of which ~8 s is process startup and
// UIA type loading repeated for every command. One long-lived process removes
// that. Correctness is unchanged: requests are still answered one at a time,
// and the adapter still verifies every mutation through UXP.
// ---------------------------------------------------------------------------

interface QueuedRequest {
  id: string;
  line: string;
  resolve: (r: WorkerResult) => void;
  timeoutMs: number;
  cmd: string;
}

export interface PersistentRunnerOptions extends PowerShellRunnerOptions {
  /** consecutive spawn failures before the caller should fall back */
  maxFailures?: number;
}

export class PersistentPowerShellRunner implements AutomationRunner {
  private scriptPath: string;
  private powershellPath: string;
  private timeoutMs: number;
  private maxFailures: number;
  private child: import("node:child_process").ChildProcess | null = null;
  private buffer = "";
  private queue: QueuedRequest[] = [];
  private pending = new Map<string, { resolve: (r: WorkerResult) => void; timer: ReturnType<typeof setTimeout>; cmd: string }>();
  private busy = false;
  private seq = 0;
  private consecutiveFailures = 0;

  constructor(opts: PersistentRunnerOptions = {}) {
    this.scriptPath = opts.scriptPath ?? defaultWorkerScript();
    this.powershellPath = opts.powershellPath ?? process.env.XD_UIA_POWERSHELL ?? "powershell.exe";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxFailures = opts.maxFailures ?? 3;
  }

  get spawnFailures(): number {
    return this.consecutiveFailures;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  private ensureChild(): boolean {
    if (this.child) return true;
    if (!existsSync(this.scriptPath)) return false;
    try {
      const child = spawn(this.powershellPath, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", this.scriptPath,
        "-Serve",
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => this.onData(chunk));
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", () => { /* structured errors arrive on stdout */ });
      child.on("error", () => this.onExit("worker process error"));
      child.on("close", () => this.onExit("worker process exited"));
      this.child = child;
      this.consecutiveFailures = 0;
      return true;
    } catch {
      this.consecutiveFailures++;
      return false;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const entry = [...this.pending.entries()][0];
    if (!entry) return;
    const [id, slot] = entry;
    clearTimeout(slot.timer);
    this.pending.delete(id);
    this.busy = false;
    const cleaned = line.replace(/[\u0000-\u001F]/g, " ");
    try {
      const parsed = JSON.parse(cleaned) as WorkerResult;
      if (typeof parsed.ok !== "boolean") throw new Error("missing ok flag");
      slot.resolve(parsed);
    } catch (e) {
      slot.resolve({
        ok: false,
        cmd: slot.cmd,
        error: { code: "WORKER_UNAVAILABLE", message: `unparseable worker output: ${line.slice(0, 300)} (${String(e)})`, stage: slot.cmd },
      });
    }
    this.pump();
  }

  private onExit(reason: string): void {
    this.child = null;
    this.buffer = "";
    const slots = [...this.pending.values()];
    this.pending.clear();
    this.busy = false;
    for (const slot of slots) {
      clearTimeout(slot.timer);
      slot.resolve({ ok: false, cmd: slot.cmd, error: { code: "WORKER_UNAVAILABLE", message: `persistent worker lost: ${reason}`, stage: slot.cmd } });
    }
    for (const q of this.queue.splice(0)) {
      q.resolve({ ok: false, cmd: q.cmd, error: { code: "WORKER_UNAVAILABLE", message: `persistent worker lost: ${reason}`, stage: q.cmd } });
    }
  }

  private pump(): void {
    if (this.busy || this.pending.size > 0) return;
    const next = this.queue.shift();
    if (!next) return;
    if (!this.ensureChild()) {
      this.consecutiveFailures++;
      next.resolve({ ok: false, cmd: next.cmd, error: { code: "WORKER_UNAVAILABLE", message: "could not start the persistent worker", stage: next.cmd } });
      queueMicrotask(() => this.pump());
      return;
    }
    this.busy = true;
    const timer = setTimeout(() => {
      if (!this.pending.has(next.id)) return;
      this.pending.delete(next.id);
      this.busy = false;
      // A hung command means the process state is unknown: kill and respawn.
      try { this.child?.kill(); } catch { /* already gone */ }
      this.child = null;
      next.resolve({ ok: false, cmd: next.cmd, error: { code: "AUTOMATION_TIMEOUT", message: `UIA worker '${next.cmd}' did not answer within ${next.timeoutMs}ms`, stage: next.cmd } });
    }, next.timeoutMs);
    this.pending.set(next.id, { resolve: next.resolve, timer, cmd: next.cmd });
    try {
      this.child!.stdin!.write(next.line + "\n");
    } catch (e) {
      clearTimeout(timer);
      this.pending.delete(next.id);
      this.busy = false;
      next.resolve({ ok: false, cmd: next.cmd, error: { code: "WORKER_UNAVAILABLE", message: `failed to write to worker: ${String(e)}`, stage: next.cmd } });
    }
  }

  run(cmd: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<WorkerResult> {
    const id = `w${++this.seq}`;
    const line = JSON.stringify({ id, cmd, args });
    return new Promise<WorkerResult>((resolve) => {
      this.queue.push({ id, line, resolve, timeoutMs: opts.timeoutMs ?? this.timeoutMs, cmd });
      this.pump();
    });
  }

  close(): void {
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = null;
  }
}

/**
 * Persistent worker with the one-shot worker as fallback. If the persistent
 * process cannot start (or dies repeatedly), the caller still gets an answer.
 */
export class HybridRunner implements AutomationRunner {
  private persistent: PersistentPowerShellRunner;
  private oneShot: PowerShellUiaRunner;

  constructor(opts: PowerShellRunnerOptions = {}) {
    this.persistent = new PersistentPowerShellRunner(opts);
    this.oneShot = new PowerShellUiaRunner(opts);
  }

  async run(cmd: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<WorkerResult> {
    if (process.env.XD_UIA_PERSISTENT === "0") return this.oneShot.run(cmd, args, opts);
    const first = await this.persistent.run(cmd, args, opts);
    if (first.ok || first.error.code !== "WORKER_UNAVAILABLE") return first;
    // After repeated spawn failures, or a lost process, retry once one-shot.
    return this.oneShot.run(cmd, args, opts);
  }

  close(): void {
    this.persistent.close();
  }
}

let sharedRunner: HybridRunner | null = null;

/** Process-wide runner so the worker spawn cost is paid once per bridge. */
export function defaultRunner(): AutomationRunner {
  if (!sharedRunner) sharedRunner = new HybridRunner();
  return sharedRunner;
}

export function closeDefaultRunner(): void {
  sharedRunner?.close();
  sharedRunner = null;
}
