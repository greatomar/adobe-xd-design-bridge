/**
 * Test helpers: spawn the bridge as a child process and speak MCP stdio to it,
 * plus a raw WS client helper for protocol-level tests.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BRIDGE_DIR = join(process.env.LOCALAPPDATA ?? "", "OpenCode", "AdobeXD-DesignBridge", "bridge");
export const NODE_EXE = "C:\\Users\\Omar\\AppData\\Local\\mise\\installs\\node\\26.13.0\\node.exe";
export const BIN = join(BRIDGE_DIR, "bin", "bridge.ts");
export const TOKEN = readFileSync(join(BRIDGE_DIR, ".bridge-token"), "utf8").trim();

export class McpClient {
  private proc: ChildProcess;
  private buffer = "";
  private waiters: Array<{ test: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  readonly stderr = "";
  private opts: { mock?: boolean; timeoutMs?: number };

  constructor(port: number, opts: { mock?: boolean; timeoutMs?: number } = {}) {
    this.opts = opts;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      XD_BRIDGE_PORT: String(port),
    };
    if (opts.timeoutMs) env.XD_BRIDGE_REQUEST_TIMEOUT_MS = String(opts.timeoutMs);
    const args = [BIN];
    if (opts.mock) args.push("--mock");
    this.proc = spawn(NODE_EXE, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (c: string) => {
      this.buffer += c;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const w = this.waiters.find((x) => x.test(msg));
        if (w) {
          this.waiters = this.waiters.filter((x) => x !== w);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });
    this.proc.stderr!.on("data", (c: string) => {
      (this as unknown as { _stderr: string })._stderr = ((this as unknown as { _stderr?: string })._stderr ?? "") + c;
    });
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const id = Math.floor(Math.random() * 1e9);
    return this.expect(
      (m) => m.id === id && (m.result !== undefined || m.error !== undefined),
      timeoutMs,
      () => JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n",
    );
  }

  expect(test: (m: Record<string, unknown>) => boolean, timeoutMs: number, write: () => void): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timeout waiting for message after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ test, resolve, reject, timer });
      this.proc.stdin!.write(write());
    });
  }

  callTool(name: string, args?: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    return this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
  }

  async initialize(): Promise<Record<string, unknown>> {
    const r = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bridge-tests", version: "1.0.0" },
    });
    await this.notify("notifications/initialized");
    return r;
  }

  async notify(method: string): Promise<void> {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    await new Promise((r) => setTimeout(r, 150));
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}

export { spawn };
