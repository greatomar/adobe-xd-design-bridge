/**
 * Wire-protocol tests against a real bridge WebSocket server (no mock):
 * token auth, malformed input, hello timeout, duplicate connections,
 * and request timeout behavior.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { McpClient, TOKEN, BIN, NODE_EXE } from "./helpers.ts";
import { spawn } from "node:child_process";

const PORT = 27301;
let serverProc: ReturnType<typeof spawn> | null = null;

before(async () => {
  // one bridge (no mock, no plugin) serves the wire-level tests
  const env: Record<string, string> = { ...(process.env as Record<string, string>), XD_BRIDGE_PORT: String(PORT) };
  serverProc = spawn(NODE_EXE, [BIN], { env, stdio: ["pipe", "pipe", "pipe"] });
  await new Promise((r) => setTimeout(r, 1200));
});

after(() => {
  serverProc?.kill();
});

interface ConnResult {
  code: number;
  reason: string;
  ws: WebSocket;
  messages: string[];
}

/** Native WebSocket (Node 26). hello: string to send on open, or null to send nothing. */
function wsConnect(url: string, opts: { hello?: string | null } = {}): Promise<ConnResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages: string[] = [];
    let settled = false;
    const finish = (code: number, reason: string) => {
      if (settled) return;
      settled = true;
      resolve({ code, reason, ws, messages });
    };
    ws.addEventListener("message", (ev) => messages.push(String((ev as MessageEvent).data)));
    ws.addEventListener("open", () => {
      if (opts.hello !== undefined && opts.hello !== null) ws.send(opts.hello);
      // resolve immediately on open (code 0 = still open); close events update via close handler below
      finish(0, "open");
    });
    ws.addEventListener("close", (ev) => finish((ev as CloseEvent).code, (ev as CloseEvent).reason));
    ws.addEventListener("error", () => finish(-1, "socket error"));
  });
}

/** Wait for a close event on a connection that is currently open. */
function waitClose(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: 0, reason: "no-close-within-timeout" }), timeoutMs);
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      resolve({ code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason });
    }, { once: true });
  });
}

test("connection with invalid token is rejected with 4004", async () => {
  const conn = await wsConnect(`ws://127.0.0.1:${PORT}`, {
    hello: JSON.stringify({ type: "hello", token: "xdbr-wrong-wrong-wrong", version: "test", capabilities: [] }),
  });
  const close = conn.code === -1 || conn.code === 0 ? await waitClose(conn.ws) : { code: conn.code, reason: conn.reason };
  assert.equal(close.code, 4004);
});

test("non-hello first message is rejected with 4001", async () => {
  const conn = await wsConnect(`ws://127.0.0.1:${PORT}`, {
    hello: JSON.stringify({ type: "request", id: "x", op: "get_document_info", params: {} }),
  });
  const close = conn.code === 0 ? await waitClose(conn.ws) : conn;
  assert.equal(close.code, 4001);
});

test("invalid JSON is rejected with 4003", async () => {
  const conn = await wsConnect(`ws://127.0.0.1:${PORT}`, { hello: "this is not json {" });
  const close = conn.code === 0 ? await waitClose(conn.ws) : conn;
  assert.equal(close.code, 4003);
});

test("silence beyond auth window is rejected with 4001", async () => {
  const conn = await wsConnect(`ws://127.0.0.1:${PORT}`, { hello: null });
  const close = await waitClose(conn.ws, 6000);
  assert.equal(close.code, 4001);
});

test("valid token handshake completes; second connection is refused", async () => {
  const conn = await wsConnect(`ws://127.0.0.1:${PORT}`, {
    hello: JSON.stringify({ type: "hello", token: TOKEN, version: "test-plugin", capabilities: ["test"] }),
  });
  // server sends ready after auth
  await waitClose(conn.ws, 300).then(() => {}); // small grace wait
  assert.ok(conn.messages.some((m) => m.includes('"type":"ready"')), "ready message received");

  const second = await wsConnect(`ws://127.0.0.1:${PORT}`, {
    hello: JSON.stringify({ type: "hello", token: TOKEN, version: "intruder", capabilities: [] }),
  });
  const close = second.code === 0 ? await waitClose(second.ws) : second;
  assert.equal(close.code, 4002);
  conn.ws.close();
});

test("in-flight request times out when plugin never responds", async (t) => {
  const c = new McpClient(PORT + 9, { timeoutMs: 800 });
  t.after(() => c.kill());
  await c.initialize();

  const fake = await wsConnect(`ws://127.0.0.1:${PORT + 9}`, {
    hello: JSON.stringify({ type: "hello", token: TOKEN, version: "silent-plugin", capabilities: [] }),
  });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(fake.messages.some((m) => m.includes('"type":"ready"')), "silent plugin authenticated");

  const r = await c.callTool("xd_get_document_info", {}, 10_000);
  const payload = JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "timeout");
  fake.ws.close();
});

test("xd_not_connected returns structured error when no plugin present", async (t) => {
  const c = new McpClient(PORT + 20, {});
  t.after(() => c.kill());
  await c.initialize();
  const r = await c.callTool("xd_get_document_info", {}, 10_000);
  const payload = JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "xd_not_connected");
});
