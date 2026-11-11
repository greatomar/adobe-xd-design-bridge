/**
 * XD link: local WebSocket server (127.0.0.1 only) that the XD plugin connects
 * to. UXP supports WebSocket clients only, so the bridge hosts the server.
 * Handles: token auth, single-flight request queue with timeouts, events.
 */
import { WebSocketServer, WebSocket } from "ws";
import { newId, log } from "./util.ts";
import { OPERATIONS, validateOperation, type OpResult, type OpParams } from "./operations.ts";

export interface LinkOptions {
  port: number;
  token: string;
  /** per-request timeout ms (default 30s, exports may pass more) */
  requestTimeoutMs?: number;
}

type Pending = {
  resolve: (r: OpResult) => void;
  timer: ReturnType<typeof setTimeout>;
  op: string;
};

export class XdLink {
  private wss: WebSocketServer | null = null;
  private plugin: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private queue: Array<{ id: string; op: string; params: OpParams; resolve: (r: OpResult) => void }> = [];
  private inFlight = false;
  private timeoutMs: number;
  private opts: LinkOptions;
  lastEvent: { name: string; data: unknown; at: number } | null = null;
  pluginInfo: { version?: string; capabilities?: string[]; connectedAt?: number } = {};

  constructor(opts: LinkOptions) {
    this.opts = opts;
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer(
          {
            host: "127.0.0.1",
            port: this.opts.port,
            maxPayload: 64 * 1024 * 1024,
          },
          () => resolve(),
        );
      } catch (e) {
        reject(e);
        return;
      }
      this.wss.on("error", (e) => {
        log("error", "ws server error", String(e));
        reject(e);
      });
      this.wss.on("connection", (ws) => this.onConnection(ws));
      log("info", `ws server listening on 127.0.0.1:${this.opts.port}`);
    });
  }

  stop(): void {
    try {
      this.plugin?.close(1001);
      this.wss?.close();
    } catch {
      /* ignore */
    }
    this.wss = null;
    this.plugin = null;
  }

  get status() {
    return {
      listening: this.wss !== null,
      port: this.opts.port,
      xdConnected: this.plugin !== null && this.plugin.readyState === WebSocket.OPEN,
      pendingRequests: this.pending.size + this.queue.length,
      pluginInfo: this.pluginInfo,
      lastEvent: this.lastEvent,
    };
  }

  private onConnection(ws: WebSocket) {
    // Only one plugin connection at a time; reject extra connections early.
    if (this.plugin && this.plugin.readyState === WebSocket.OPEN) {
      log("warn", "second plugin connection rejected");
      ws.close(4002, "bridge already has an authenticated plugin connection");
      return;
    }
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) {
        log("warn", "connection closed: no hello within 3s");
        ws.close(4001, "authentication timeout");
      }
    }, 3000);

    ws.on("message", (buf) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(buf)) as Record<string, unknown>;
      } catch {
        ws.close(4003, "invalid JSON");
        return;
      }
      if (!authed) {
        if (msg.type !== "hello") {
          ws.close(4001, "expected hello");
          return;
        }
        if (typeof msg.token !== "string" || !safeEqual(msg.token, this.opts.token)) {
          log("warn", "plugin authentication failed");
          ws.close(4004, "invalid token");
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        this.plugin = ws;
        this.pluginInfo = {
          version: typeof msg.version === "string" ? msg.version : undefined,
          capabilities: Array.isArray(msg.capabilities) ? (msg.capabilities as string[]) : [],
          connectedAt: Date.now(),
        };
        ws.send(JSON.stringify({ type: "ready", serverVersion: "1.0.0" }));
        log("info", "plugin connected", this.pluginInfo);
        this.pump();
        return;
      }
      this.onPluginMessage(msg);
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (this.plugin === ws) {
        this.plugin = null;
        this.pluginInfo = {};
        log("info", "plugin disconnected");
        // fail all pending/queued requests so callers get fast, structured errors
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, error: "XD plugin disconnected while request was in flight", code: "xd_disconnected" });
          this.pending.delete(id);
        }
        for (const q of this.queue.splice(0)) {
          q.resolve({ ok: false, error: "XD plugin disconnected before execution", code: "xd_disconnected" });
        }
        this.inFlight = false;
      }
    });
    ws.on("error", (e) => log("warn", "plugin socket error", String(e)));
  }

  private onPluginMessage(msg: Record<string, unknown>) {
    if (msg.type === "response" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      this.inFlight = false;
      const ok = msg.ok === true;
      p.resolve({
        ok,
        result: ok ? msg.result : undefined,
        error: ok ? undefined : typeof msg.error === "string" ? msg.error : "plugin reported failure",
        code: ok ? undefined : typeof msg.code === "string" ? msg.code : "plugin_error",
      });
      this.pump();
    } else if (msg.type === "event" && typeof msg.name === "string") {
      this.lastEvent = { name: msg.name, data: msg.data, at: Date.now() };
      log("debug", `plugin event: ${msg.name}`);
    } else if (msg.type === "pong") {
      /* keepalive */
    }
  }

  private pump() {
    if (this.inFlight || !this.isConnected()) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = true;
    const { id, op, params, resolve } = next;
    const pickerOps = new Set(["import_asset", "create_image", "replace_image"]);
    const batchHasUserPicker = op === "execute_batch" && Array.isArray(params.operations)
      && (params.operations as Array<{ op?: string }>).some((entry) => pickerOps.has(entry?.op || ""));
    const timeout = pickerOps.has(op) || batchHasUserPicker
      ? Math.max(this.timeoutMs, 300_000)
      : OPERATIONS[op]?.op === "export_artboard" || op === "export_selection"
        ? Math.max(this.timeoutMs, 60_000)
        : this.timeoutMs;
    const timer = setTimeout(() => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        this.inFlight = false;
        resolve({ ok: false, error: `XD operation timed out after ${timeout}ms`, code: "timeout" });
        this.pump();
      }
    }, timeout);
    this.pending.set(id, { resolve, timer, op });
    try {
      this.plugin!.send(JSON.stringify({ type: "request", id, op, params }));
    } catch (e) {
      clearTimeout(timer);
      this.pending.delete(id);
      this.inFlight = false;
      resolve({ ok: false, error: `failed to send to plugin: ${String(e)}`, code: "send_failed" });
    }
  }

  isConnected(): boolean {
    return this.plugin !== null && this.plugin.readyState === WebSocket.OPEN;
  }

  /**
   * Execute an operation. Validates first; dryRun returns a preview without
   * touching XD. Requests are queued serially — XD edits run one at a time.
   */
  execute(op: string, params: OpParams, dryRun = false): Promise<OpResult> {
    const spec = OPERATIONS[op];
    if (!spec) return Promise.resolve({ ok: false, error: `unknown operation "${op}"`, code: "unknown_op" });
    const v = validateOperation({ op, ...params });
    if (!v.ok) return Promise.resolve({ ok: false, error: v.error, code: "invalid_params" });
    if (dryRun) {
      return Promise.resolve({
        ok: true,
        result: { dryRun: true, op, validatedParams: v.params, mutating: spec.mutating, preview: spec.preview(v.params) },
      });
    }
    if (!this.isConnected()) {
      return Promise.resolve({
        ok: false,
        error: "Adobe XD plugin is not connected. Open XD, load the Design Bridge plugin panel, and connect (see bridge INSTALLATION.md).",
        code: "xd_not_connected",
      });
    }
    return new Promise((resolve) => {
      this.queue.push({ id: newId("req"), op, params: v.params, resolve });
      this.pump();
    });
  }
}

/** constant-time-ish string compare */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
