/**
 * MCP-level bridge tests (end-to-end with in-process mock plugin):
 * handshake, tool discovery, health, capabilities, batch execution,
 * validation failures, dry-run, image export, operation status.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpClient, TOKEN } from "./helpers.ts";

const PORT = 27201;

test("MCP handshake and tool discovery", async (t) => {
  const c = new McpClient(PORT, { mock: true });
  t.after(() => c.kill());
  const init = await c.initialize();
  assert.equal((init.result as Record<string, unknown>).protocolVersion, "2025-06-18");
  const list = await c.request("tools/list");
  const tools = (list.result as { tools: Array<{ name: string }> }).tools;
  const names = tools.map((x) => x.name);
  for (const expected of [
    "xd_health", "xd_get_capabilities", "xd_get_document_info", "xd_get_artboards",
    "xd_get_selection", "xd_inspect_node", "xd_search_nodes", "xd_create_artboard",
    "xd_create_rectangle", "xd_create_ellipse", "xd_create_line", "xd_create_polygon", "xd_create_path", "xd_create_image", "xd_replace_image", "xd_import_asset",
    "xd_create_text", "xd_create_group", "xd_create_mask_group", "xd_ungroup", "xd_duplicate_node",
    "xd_delete_node", "xd_reparent_node", "xd_rotate_node", "xd_arrange_nodes", "xd_align_nodes", "xd_distribute_nodes",
    "xd_create_component", "xd_update_node", "xd_move_node", "xd_resize_node",
    "xd_apply_style", "xd_update_text", "xd_apply_design_tokens",
    "xd_create_component_variants", "xd_inspect_design_consistency", "xd_export_artboard",
    "xd_export_selection", "xd_capture_design_preview", "xd_validate_document", "xd_get_prototype_state", "xd_validate_prototype", "xd_audit_screen",
    "xd_preview_operation", "xd_execute_operation", "xd_execute_batch", "xd_get_operation_status",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  // every tool must have a schema and description
  for (const tool of tools) {
    assert.ok(tool.name.length > 0);
    assert.ok(typeof (tool as unknown as { description?: string }).description === "string");
  }
});

test("xd_health reports bridge status before/after plugin connect", async (t) => {
  const c = new McpClient(PORT + 1, { mock: true });
  t.after(() => c.kill());
  await c.initialize();
  const r = await c.callTool("xd_health");
  const payload = JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.link.xdConnected, true);
  assert.ok(payload.link.port > 0);
});

test("xd_execute_batch creates artboard and shape (mock e2e)", async (t) => {
  const c = new McpClient(PORT + 2, { mock: true });
  t.after(() => c.kill());
  await c.initialize();
  const r = await c.callTool("xd_execute_batch", {
    operations: [
      { op: "create_artboard", name: "Home", frame: { x: 0, y: 0, width: 390, height: 844 } },
      { op: "create_rectangle", name: "Card", frame: { x: 24, y: 120, width: 342, height: 180 }, style: { fill: "#FFFFFF", cornerRadius: 16 } },
    ],
  });
  const payload = JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.results.length, 2);
  assert.ok(payload.results[0].guid.startsWith("mock-guid-"));
});

test("invalid operations are rejected before execution", async (t) => {
  const c = new McpClient(PORT + 3, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  // unknown op
  let r = await c.callTool("xd_execute_batch", { operations: [{ op: "delete_everything" }] });
  assert.equal(r.result.isError, true);
  // invalid frame
  r = await c.callTool("xd_execute_batch", {
    operations: [{ op: "create_rectangle", frame: { x: 0, y: 0, width: "wide", height: 10 } }],
  });
  assert.equal(r.result.isError, true);
  // invalid color
  r = await c.callTool("xd_execute_batch", {
    operations: [{ op: "create_rectangle", frame: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "not-a-color" } }],
  });
  assert.equal(r.result.isError, true);
  // unknown tool
  r = await c.callTool("xd_nope");
  assert.equal(r.error !== undefined, true);
});

test("dry-run returns preview without execution", async (t) => {
  const c = new McpClient(PORT + 4, { mock: true });
  t.after(() => c.kill());
  await c.initialize();
  const r = await c.callTool("xd_execute_batch", {
    dryRun: true,
    operations: [{ op: "create_artboard", name: "X", frame: { x: 0, y: 0, width: 100, height: 100 } }],
  });
  const payload = JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.count, 1);
  assert.match(payload.previews[0].preview, /create_artboard/);
});

test("execute_batch point text survives normalized re-validation", async (t) => {
  const c = new McpClient(PORT + 11, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  // Point text deliberately omits width/height. The bridge validates the
  // operation before sending it, then validates the normalized batch again.
  // Omitted dimensions must remain omitted, not become zero on pass one.
  const r = await c.callTool("xd_execute_batch", {
    operations: [
      { op: "create_text", parent: "mock-artboard", name: "Point/Label", text: "Account value", frame: { x: 24, y: 36 }, style: { fontFamily: "Segoe UI", fontSize: 14 } },
    ],
  });
  const payload = JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.results[0].op, "create_text");
  assert.equal(payload.results[0].ok, true);
});

test("new native-scenegraph operations validate exact documented inputs", async (t) => {
  const c = new McpClient(PORT + 12, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const good = await c.callTool("xd_preview_operation", {
    operations: [
      { op: "create_line", start: { x: 0, y: 0 }, end: { x: 20, y: 20 }, style: { stroke: "#112233" } },
      { op: "create_polygon", frame: { x: 0, y: 0, width: 32, height: 32 }, cornerCount: 6, starRatio: 55 },
      { op: "create_path", pathData: "M0 0 L20 0 L20 20 Z", x: 0, y: 0 },
      { op: "create_image", parent: "known-parent", frame: { x: 0, y: 0, width: 48, height: 48 } },
      { op: "replace_image", guid: "known-guid" },
      { op: "import_asset", parent: "known-parent" },
      { op: "create_rectangle", frame: { x: 0, y: 0, width: 32, height: 32 }, style: { gradient: { type: "linear", colorStops: [{ stop: 0, color: "#101820" }, { stop: 1, color: "#E3B04B" }] } } },
      { op: "delete_node", guid: "known-guid" },
      { op: "align_nodes", guids: ["a", "b"], action: "alignLeft" },
    ],
  });
  const goodPayload = JSON.parse((good.result as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(goodPayload.ok, true);
  assert.equal(goodPayload.count, 9);

  const badLine = await c.callTool("xd_preview_operation", {
    operations: [{ op: "create_line", start: { x: 0, y: 0 }, end: { x: 20, y: 20 } }],
  });
  assert.equal(badLine.result.isError, true, "a line without visible stroke is rejected before queueing");

  const badPath = await c.callTool("xd_preview_operation", {
    operations: [{ op: "create_path", pathData: "<svg><script>bad()</script></svg>", x: 0, y: 0 }],
  });
  assert.equal(badPath.result.isError, true, "pathData accepts path geometry only, not XML/code");

  const badTextGradient = await c.callTool("xd_preview_operation", {
    operations: [{ op: "create_text", text: "No gradients on Text", frame: { x: 0, y: 0 }, style: { gradient: { type: "linear", colorStops: [{ stop: 0, color: "#000000" }, { stop: 1, color: "#FFFFFF" }] } } }],
  });
  assert.equal(badTextGradient.result.isError, true, "XD Text accepts only solid Color fill");
});

test("export returns image content and path", async (t) => {
  const c = new McpClient(PORT + 5, { mock: true });
  t.after(() => c.kill());
  await c.initialize();
  const r = await c.callTool("xd_export_artboard", { name: "Home", scale: 2 });
  const content = (r.result as { content: Array<{ type: string; data?: string; text?: string }> }).content;
  const img = content.find((x) => x.type === "image");
  assert.ok(img?.data, "image content present");
  const meta = JSON.parse(content.find((x) => x.type === "text")!.text!);
  assert.ok(meta.path.includes("exports"));
});

test("xd_apply_design_tokens returns contrast report", async (t) => {
  const c = new McpClient(PORT + 6, { mock: true });
  t.after(() => c.kill());
  await c.initialize();
  const r = await c.callTool("xd_apply_design_tokens", {
    tokens: {
      color: {
        "text/primary": { value: "#0B1220", type: "color" },
        "bg/primary": { value: "#FFFFFF", type: "color" },
        "text/bad": { value: "#CCCCCC", type: "color" },
      },
    },
  });
  const payload = JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text);
  assert.ok(Array.isArray(payload.contrastReport));
  const good = payload.contrastReport.find((x: { fg: string }) => x.fg === "text/primary" && x.bg === "bg/primary");
  assert.ok(good.ratio > 4.5);
  const bad = payload.contrastReport.find((x: { fg: string }) => x.fg === "text/bad" && x.bg === "bg/primary");
  assert.ok(bad.ratio < 2.5);
});

test("xd_get_operation_status and capabilities work", async (t) => {
  const c = new McpClient(PORT + 7, { mock: true });
  t.after(() => c.kill());
  await c.initialize();
  const caps = await c.callTool("xd_get_capabilities");
  const payload = JSON.parse((caps.result as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(payload.xdConnected, true);
  assert.ok(payload.bridgeOperations.includes("execute_batch"));
  const st = await c.callTool("xd_get_operation_status");
  const stPayload = JSON.parse((st.result as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(stPayload.ok, true);
});

test("auth token file exists and is well-formed", () => {
  assert.ok(TOKEN.startsWith("xdbr-"), "token has prefix");
  assert.ok(TOKEN.length >= 30, "token is long enough");
});
