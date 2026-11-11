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
  assert.equal(OP_KEYS.length, 50);
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
  assert.equal(Object.keys(tools).length, 67, "56 xd_* tools + 11 design_asset_* / design_context_* tools");
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
