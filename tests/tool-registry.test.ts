/**
 * Bridge tool-registry tests.
 *
 * Regression for the closure bug: `createShapeTool` referenced `link` without
 * receiving it, so direct xd_create_rectangle / xd_create_ellipse calls threw
 * `ReferenceError: link is not defined` before reaching the plugin queue.
 * These tests import the real registry and drive the real tool handlers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools } from "../bridge/src/tools.ts";

interface Call {
  op: string;
  params: Record<string, unknown>;
}

function fakeLink(calls: Call[]) {
  return {
    execute: async (op: string, params: Record<string, unknown>) => {
      calls.push({ op, params });
      return { ok: true, result: { ok: true, queued: true, op, pending: 1 } };
    },
    isConnected: () => true,
    status: { listening: true, port: 27183, xdConnected: true, pendingRequests: 0, pluginInfo: {}, lastEvent: null },
    pluginInfo: {},
    lastEvent: null,
  };
}

function payloadOf(result: any) {
  assert.ok(result && Array.isArray(result.content), "tool result has content");
  const block = result.content.find((c: any) => c.type === "text");
  assert.ok(block, "tool result has a text block");
  return JSON.parse(block.text);
}

const RECT = {
  parent: "6fa8f9fb-6f23-493c-9949-85ceab3e628b",
  name: "TEST / Acceptance Rectangle",
  frame: { x: 32, y: 32, width: 180, height: 96 },
  style: { fill: "#FF00A8", cornerRadius: 8 },
};

const ELLIPSE = {
  parent: "19d1076b-a648-4d5c-9c99-df8b01513dfa",
  name: "TEST / Acceptance Ellipse",
  frame: { x: 40, y: 40, width: 120, height: 120 },
  style: { fill: "#3ED598" },
};

test("direct xd_create_rectangle reaches the link and queues one operation", async () => {
  const calls: Call[] = [];
  const tools = buildTools(fakeLink(calls) as any);

  const result = await tools.xd_create_rectangle.handler(RECT);
  const payload = payloadOf(result);

  assert.equal(result.isError === true, false, "direct rectangle call must not fail");
  assert.equal(payload.ok, true);
  assert.equal(payload.queued, true);
  assert.equal(payload.op, "create_rectangle");
  assert.equal(payload.pending, 1);
  assert.equal(calls.length, 1, "exactly one plugin request");
  assert.equal(calls[0].op, "create_rectangle");
  assert.deepEqual(calls[0].params, RECT, "arguments pass through unchanged");
});

test("direct xd_create_ellipse reaches the link and queues one operation", async () => {
  const calls: Call[] = [];
  const tools = buildTools(fakeLink(calls) as any);

  const result = await tools.xd_create_ellipse.handler(ELLIPSE);
  const payload = payloadOf(result);

  assert.equal(result.isError === true, false, "direct ellipse call must not fail");
  assert.equal(payload.ok, true);
  assert.equal(payload.queued, true);
  assert.equal(payload.op, "create_ellipse");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "create_ellipse");
  assert.deepEqual(calls[0].params, ELLIPSE);
});

test("direct shape handlers propagate a plugin failure as a structured error", async () => {
  const calls: Call[] = [];
  const link = fakeLink(calls);
  link.execute = async () => ({ ok: false, code: "xd_not_connected", error: "not connected" } as any);
  const tools = buildTools(link as any);

  const result = await tools.xd_create_rectangle.handler(RECT);
  const payload = payloadOf(result);
  assert.equal(result.isError, true);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "xd_not_connected");
});

test("two different links do not share captured state", async () => {
  const a: Call[] = [];
  const b: Call[] = [];
  const toolsA = buildTools(fakeLink(a) as any);
  const toolsB = buildTools(fakeLink(b) as any);

  await toolsA.xd_create_rectangle.handler(RECT);
  await toolsB.xd_create_ellipse.handler(ELLIPSE);

  assert.deepEqual(a.map((c) => c.op), ["create_rectangle"]);
  assert.deepEqual(b.map((c) => c.op), ["create_ellipse"]);
});
