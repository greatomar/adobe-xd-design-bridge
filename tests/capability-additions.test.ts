/**
 * Bridge-side regression tests for the v1.0.5 documented-API additions.
 *
 * These assert the operation registry contract only: every new op must be
 * whitelisted with strict validation, and invalid input must be rejected before
 * anything reaches the plugin queue. Live XD behaviour is verified separately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATIONS, OP_KEYS, BLEND_MODES, validateOperation } from "../bridge/src/operations.ts";
import { buildTools } from "../bridge/src/tools.ts";

const NEW_OPS = [
  "update_path",
  "convert_to_path",
  "outline_stroke",
  "align_to_pixel_grid",
  "reset_3d_transforms",
  "make_background",
  "replace_background",
  "set_layout",
  "set_constraints",
];

test("all v1.0.5 operations are registered", () => {
  for (const op of NEW_OPS) {
    assert.ok(OP_KEYS.includes(op), "missing operation " + op);
    assert.equal(OPERATIONS[op].mutating, true, op + " must require an edit context");
  }
  assert.equal(OP_KEYS.length, 54);
});

test("new operations are exposed as MCP tools with schemas", () => {
  const link = {
    execute: async () => ({ ok: true, result: { ok: true } }),
    isConnected: () => true,
    status: { listening: true, port: 27183, xdConnected: true, pendingRequests: 0, pluginInfo: {}, lastEvent: null },
    pluginInfo: {},
    lastEvent: null,
  };
  const tools = buildTools(link as any);
  for (const op of NEW_OPS) {
    const tool = `xd_${op}`;
    assert.ok(tools[tool], "missing tool " + tool);
    assert.equal(tools[tool].inputSchema.type, "object");
  }
  assert.equal(Object.keys(tools).length, 80, "69 xd_* tools (automation, graph, preflight, grammar, pending) + 11 design_asset_* / design_context_* tools");
});

test("prototype focus/prepare require the edit gate; verification stays read-only", () => {
  for (const op of ["prototype_focus", "prototype_prepare_connection", "prototype_verify_connection"]) {
    assert.ok(OP_KEYS.includes(op), "missing operation " + op);
  }
  // XD rejects `scenegraph.selection.items = [...]` outside editDocument, so the
  // operations that select a node must travel through the panel queue.
  assert.equal(OPERATIONS.prototype_focus.mutating, true, "focus selects a node, so it needs editDocument");
  assert.equal(OPERATIONS.prototype_prepare_connection.mutating, true, "prepare selects a node, so it needs editDocument");
  assert.equal(OPERATIONS.prototype_verify_connection.mutating, false, "verification only reads");
  assert.deepEqual(
    validateOperation({ op: "prototype_prepare_connection", sourceGuid: "a", targetGuid: "b" }).ok,
    true,
  );
  assert.equal(validateOperation({ op: "prototype_prepare_connection", sourceGuid: "a" }).ok, false);
  assert.equal(validateOperation({ op: "prototype_verify_connection", sourceGuid: "a", targetGuid: "b", trigger: "hover" }).ok, false);
  assert.equal(validateOperation({ op: "prototype_focus", targetGuid: "b" }).ok, false);
});

test("update_path requires SVG path data starting with a move or close command", () => {
  assert.equal(validateOperation({ op: "update_path", guid: "g", pathData: "M0,0 L10,10" }).ok, true);
  assert.equal(validateOperation({ op: "update_path", guid: "g", pathData: "0,0 10,10" }).ok, false);
  assert.equal(validateOperation({ op: "update_path", guid: "g" }).ok, false);
});

test("set_layout rejects a stack without a stack definition", () => {
  assert.equal(validateOperation({ op: "set_layout", guid: "g", layout: { type: "stack" } }).ok, false);
  assert.equal(validateOperation({ op: "set_layout", guid: "g", layout: { type: "none" } }).ok, true);
  assert.equal(
    validateOperation({ op: "set_layout", guid: "g", layout: { type: "stack", stack: { orientation: "diagonal" } } }).ok,
    false,
  );
});

test("set_constraints needs at least one axis or reset", () => {
  assert.equal(validateOperation({ op: "set_constraints", guid: "g" }).ok, false);
  assert.equal(validateOperation({ op: "set_constraints", guid: "g", reset: true }).ok, true);
  assert.equal(
    validateOperation({ op: "set_constraints", guid: "g", horizontal: { position: "middle", size: "fixed" } }).ok,
    false,
  );
});

test("update_node validates blend modes against the documented list", () => {
  assert.equal(BLEND_MODES.includes("BLEND_MODE_MULTIPLY"), true);
  assert.equal(validateOperation({ op: "update_node", guid: "g", blendMode: "BLEND_MODE_MULTIPLY" }).ok, true);
  assert.equal(validateOperation({ op: "update_node", guid: "g", blendMode: "multiply" }).ok, false);
  assert.equal(validateOperation({ op: "update_node", guid: "g", markedForExport: "yes" }).ok, false);
});

test("text style accepts the extended typography keys and rejects bad enums", () => {
  const ok = validateOperation({
    op: "create_text",
    text: "Hi",
    frame: { x: 0, y: 0, width: 200, height: 40 },
    style: { paragraphSpacing: 8, textTransform: "uppercase", underline: true, strikethrough: false, flipY: false, textScript: "superscript" },
  });
  assert.equal(ok.ok, true);
  const bad = validateOperation({ op: "create_text", text: "Hi", frame: { x: 0, y: 0, width: 200, height: 40 }, style: { textTransform: "shout" } });
  assert.equal(bad.ok, false);
  const badScript = validateOperation({ op: "create_text", text: "Hi", frame: { x: 0, y: 0, width: 200, height: 40 }, style: { textScript: "tiny" } });
  assert.equal(badScript.ok, false);
});

test("selection-command ops require at least one guid", () => {
  for (const op of ["convert_to_path", "outline_stroke", "align_to_pixel_grid", "reset_3d_transforms"]) {
    assert.equal(validateOperation({ op, guids: [] }).ok, false, op + " must reject an empty guid list");
    assert.equal(validateOperation({ op, guids: ["a"] }).ok, true, op + " must accept one guid");
  }
});




// --- stage 9.1 strict mutation contracts --------------------------------------

test("update_node rejects geometry instead of silently ignoring it", () => {
  const frame = validateOperation({ op: "update_node", guid: "g", frame: { x: 1, y: 2, width: 3, height: 4 } });
  assert.equal(frame.ok, false);
  assert.match((frame as { error: string }).error, /UNSUPPORTED_PROPERTY: frame/);
  assert.match((frame as { error: string }).error, /move_node/);

  for (const key of ["x", "y", "width", "height"]) {
    const r = validateOperation({ op: "update_node", guid: "g", [key]: 10 });
    assert.equal(r.ok, false, "update_node must reject " + key);
    assert.match((r as { error: string }).error, new RegExp("UNSUPPORTED_PROPERTY: " + key));
  }

  // Mixed supported/unsupported payloads are rejected whole: nothing is queued.
  const mixed = validateOperation({ op: "update_node", guid: "g", name: "Renamed", frame: { x: 0, y: 0, width: 1, height: 1 } });
  assert.equal(mixed.ok, false);
});

test("update_node rejects unknown properties and still accepts its documented set", () => {
  const unknown = validateOperation({ op: "update_node", guid: "g", color: "#fff" });
  assert.equal(unknown.ok, false);
  assert.match((unknown as { error: string }).error, /UNKNOWN_PROPERTY: color/);

  const ok = validateOperation({ op: "update_node", guid: "g", name: "n", visible: false, locked: true, markedForExport: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys((ok as { params: Record<string, unknown> }).params).sort(), ["guid", "locked", "markedForExport", "name", "visible"]);
});

test("a rejected update_node never reaches the plugin queue", async () => {
  // XdLink validates before it queues, so this uses the real link with no
  // plugin attached: the refusal must come from validation, not connectivity.
  const { XdLink } = await import("../bridge/src/xd-link.ts");
  const link = new (XdLink as any)({ port: 0, token: "test-token" });
  const tools = buildTools(link);
  const result = await (tools.xd_update_node.handler as any)({ guid: "g", frame: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal((link as any).queue.length, 0, "no operation may be queued");
  const text = JSON.stringify(result);
  assert.match(text, /UNSUPPORTED_PROPERTY/);
  assert.match(text, /invalid_params/);
});

test("inspect_node validates its pagination window", () => {
  assert.equal(validateOperation({ op: "inspect_node", guid: "g" }).ok, true);
  assert.equal(validateOperation({ op: "inspect_node", guid: "g", limit: 1, offset: 0 }).ok, true);
  assert.equal(validateOperation({ op: "inspect_node", guid: "g", limit: 500, offset: 25 }).ok, true);

  const zero = validateOperation({ op: "inspect_node", guid: "g", limit: 0 });
  assert.equal(zero.ok, false);
  assert.match((zero as { error: string }).error, /limit/);

  assert.equal(validateOperation({ op: "inspect_node", guid: "g", limit: 501 }).ok, false);
  assert.equal(validateOperation({ op: "inspect_node", guid: "g", limit: 1.5 }).ok, false);
  assert.equal(validateOperation({ op: "inspect_node", guid: "g", offset: -1 }).ok, false);

  const params = validateOperation({ op: "inspect_node", guid: "g", limit: 30, offset: 60 });
  assert.deepEqual((params as { params: Record<string, unknown> }).params, { guid: "g", limit: 30, offset: 60 });
});

test("move_node requires both coordinates and states the artboard-relative contract", () => {
  assert.equal(validateOperation({ op: "move_node", guid: "g" }).ok, false);
  assert.equal(validateOperation({ op: "move_node", guid: "g", x: 10 }).ok, false);
  assert.equal(validateOperation({ op: "move_node", guid: "g", x: 10, y: 20 }).ok, true);
  assert.equal(validateOperation({ op: "move_node", guid: "g", x: 1, y: 2, relative: true }).ok, true);
  assert.match(OPERATIONS.move_node.description, /ARTBOARD-RELATIVE/);
  assert.match(OPERATIONS.update_node.description, /move_node/);
});

test("resize_node refuses non-positive dimensions and keeps relative scale factors usable", () => {
  assert.equal(validateOperation({ op: "resize_node", guid: "g", width: 0, height: 10 }).ok, false);
  assert.equal(validateOperation({ op: "resize_node", guid: "g", width: -5, height: 10 }).ok, false);
  assert.equal(validateOperation({ op: "resize_node", guid: "g", relative: true, width: 0, height: 0.5 }).ok, false);
  assert.equal(validateOperation({ op: "resize_node", guid: "g", relative: true, width: 0.5, height: 0.5 }).ok, true);
  assert.equal(validateOperation({ op: "resize_node", guid: "g", relative: true, width: 1, height: 1 }).ok, true);
});
