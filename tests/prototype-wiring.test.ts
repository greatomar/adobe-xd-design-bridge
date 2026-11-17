/**
 * Prototype wiring assistant — bridge-level tests.
 *
 * Two layers:
 *   1. `validateFlowManifest` is pure, so it is tested directly.
 *   2. The MCP tools are driven end-to-end against the in-process mock plugin
 *      (deterministic 3-screen fixture with one pre-existing wire).
 *
 * The invariant under test everywhere: this feature prepares, focuses and
 * verifies. It never claims to author a wire, because XD's public API cannot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFlowManifest } from "../bridge/src/prototype.ts";
import { McpClient } from "./helpers.ts";

const PORT = 27241;

function payload(r: Record<string, unknown>): Record<string, any> {
  return JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text) as Record<string, any>;
}

const MANIFEST = {
  name: "Main",
  home: "Home",
  edges: [
    { source: "Home/PrimaryCTA", target: "Details", trigger: "tap", action: "goToArtboard" },
    { source: "Details/BookButton", target: "Booking", trigger: "tap", action: "goToArtboard" },
  ],
};

// --- manifest validation (pure) ---------------------------------------------

test("flow manifest accepts semantic names and preserves intent", () => {
  const v = validateFlowManifest(MANIFEST);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.manifest.name, "Main");
  assert.equal(v.manifest.home, "Home");
  assert.equal(v.manifest.edges.length, 2);
  assert.equal(v.manifest.edges[0].source, "Home/PrimaryCTA");
  assert.equal(v.manifest.edges[0].target, "Details");
  assert.equal(v.manifest.edges[0].trigger, "tap");
});

test("flow manifest accepts GUID sources and full transition/overlay detail", () => {
  const v = validateFlowManifest({
    edges: [{
      source: "49cf0a87-cfea-4b3d-9120-c522a4114ffe",
      target: "ab-details",
      sourceRole: "Home/PrimaryCTA",
      trigger: "drag",
      action: "overlay",
      transition: { type: "dissolve", duration: 0.25, easing: "ease-out" },
      overlay: { x: 24, y: 120 },
      preserveScrollPosition: true,
      note: "hero card",
    }],
  });
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.manifest.edges[0].transition?.duration, 0.25);
  assert.equal(v.manifest.edges[0].overlay?.x, 24);
  assert.equal(v.manifest.edges[0].preserveScrollPosition, true);
});

test("flow manifest rejects structurally invalid input", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /must be an object/],
    [{}, /edges must be a non-empty array/],
    [{ edges: [] }, /edges must be a non-empty array/],
    [{ edges: [{ target: "Details" }] }, /edges\[0\]\.source must be a string/],
    [{ edges: [{ source: "   ", target: "Details" }] }, /non-empty string/],
    [{ edges: [{ source: "A", target: "Details", trigger: "hover" }] }, /trigger must be one of/],
    [{ edges: [{ source: "A", target: "Details", action: "scrollTo" }] }, /action must be one of/],
    [{ edges: [{ source: "A", target: "Details", transition: { duration: 99 } }] }, /between 0 and 10/],
    [{ edges: [{ source: "A", target: "Details", overlay: { x: "left" } }] }, /overlay\.x must be a finite number/],
    [{ edges: [{ source: "A", target: "Details", preserveScrollPosition: "yes" }] }, /must be a boolean/],
  ];
  for (const [input, expected] of cases) {
    const v = validateFlowManifest(input);
    assert.equal(v.ok, false, `should reject ${JSON.stringify(input)}`);
    if (v.ok) continue;
    assert.match(v.error, expected);
  }
});

test("flow manifest rejects more than 500 edges", () => {
  const edges = Array.from({ length: 501 }, () => ({ source: "A", target: "B" }));
  const v = validateFlowManifest({ edges });
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.match(v.error, /500/);
});

// --- MCP: plan ---------------------------------------------------------------

test("xd_prototype_plan resolves semantic names to real GUIDs", async (t) => {
  const c = new McpClient(PORT, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const plan = payload(await c.callTool("xd_prototype_plan", { manifest: MANIFEST }));
  assert.equal(plan.ok, true);
  assert.equal(plan.authoringSupported, false);
  assert.equal(plan.wireCreated, false);
  assert.equal(plan.stats.edgeCount, 2);
  assert.equal(plan.stats.readyCount, 2);
  assert.equal(plan.stats.blockedCount, 0);
  assert.equal(plan.stats.artboardCount, 3);
  assert.equal(plan.home.guid, "ab-home");
  assert.equal(plan.edges[0].sourceNode.resolvedBy, "name");
  assert.equal(plan.edges[0].sourceNode.guid, "nd-home-cta");
  assert.equal(plan.edges[0].targetArtboard.guid, "ab-details");
  assert.equal(plan.edges[1].sourceNode.guid, "nd-details-book");
  assert.equal(plan.edges[1].targetArtboard.guid, "ab-booking");
  assert.match(plan.nextStep, /xd_prototype_prepare/);
});

test("xd_prototype_plan reports unknown nodes and artboards instead of guessing", async (t) => {
  const c = new McpClient(PORT + 1, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const plan = payload(await c.callTool("xd_prototype_plan", {
    manifest: { edges: [{ source: "Home/DoesNotExist", target: "Nope" }] },
  }));
  assert.equal(plan.ok, false);
  assert.equal(plan.stats.readyCount, 0);
  assert.equal(plan.stats.blockedCount, 1);
  const codes = plan.problems.map((p: { code: string }) => p.code);
  assert.ok(codes.includes("source-not-found"));
  assert.ok(codes.includes("target-not-found"));
  assert.equal(plan.edges[0].ready, false);
});

test("xd_prototype_plan rejects an invalid manifest before touching XD", async (t) => {
  const c = new McpClient(PORT + 2, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const r = await c.callTool("xd_prototype_plan", { manifest: { edges: [] } });
  assert.equal(r.result.isError, true);
  const body = payload(r);
  assert.equal(body.code, "invalid_manifest");
});

// --- MCP: focus / prepare / verify ------------------------------------------

test("xd_prototype_focus selects the source without authoring a wire", async (t) => {
  const c = new McpClient(PORT + 3, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const focus = payload(await c.callTool("xd_prototype_focus", { guid: "nd-home-cta", targetGuid: "ab-details" }));
  assert.equal(focus.ok, true);
  assert.equal(focus.createdWire, false);
  assert.equal(focus.authoringSupported, false);
  assert.equal(focus.source.name, "Home/PrimaryCTA");
  assert.equal(focus.artboard.guid, "ab-home");
  assert.equal(focus.target.guid, "ab-details");
  assert.equal(focus.focusState, "selection-assigned");
  assert.equal(focus.confirmationRequired, "read xd_get_selection after execution");
  assert.equal("focused" in focus, false, "the operation never claims focus; the post-commit read does");
});

test("xd_prototype_prepare returns instructions and never reports a written wire", async (t) => {
  const c = new McpClient(PORT + 4, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  // The mock already wires Home/PrimaryCTA → Details.
  const existing = payload(await c.callTool("xd_prototype_prepare", { sourceGuid: "nd-home-cta", targetGuid: "ab-details" }));
  assert.equal(existing.status, "already-wired");
  assert.equal(existing.createdWire, false);

  // Details/BookButton → Booking is not wired yet.
  const pending = payload(await c.callTool("xd_prototype_prepare", { sourceGuid: "nd-details-book", targetGuid: "ab-booking" }));
  assert.equal(pending.status, "ready");
  assert.equal(pending.createdWire, false);
  assert.equal(pending.authoringSupported, false);
  assert.equal(pending.focusState, "selection-assigned");
  assert.equal(pending.confirmationRequired, "read xd_get_selection after execution");
  assert.equal("focused" in pending, false);
  assert.match(pending.instruction, /Drag the blue connector/);
  assert.equal(pending.checklist.length, 4);

  // A wrong destination is surfaced, not silently accepted.
  const wrong = payload(await c.callTool("xd_prototype_prepare", { sourceGuid: "nd-home-cta", targetGuid: "ab-booking" }));
  assert.equal(wrong.verdict.status, "wrong-destination");
});

test("xd_prototype_verify distinguishes wired from unwired edges", async (t) => {
  const c = new McpClient(PORT + 5, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const wired = payload(await c.callTool("xd_prototype_verify", { sourceGuid: "nd-home-cta", targetGuid: "ab-details" }));
  assert.equal(wired.status, "ok");
  assert.equal(wired.verified, true);

  const unwired = payload(await c.callTool("xd_prototype_verify", { sourceGuid: "nd-details-book", targetGuid: "ab-booking" }));
  assert.equal(unwired.status, "missing");
  assert.equal(unwired.verified, false);
  assert.equal(unwired.createdWire, false);

  const wrongTrigger = payload(await c.callTool("xd_prototype_verify", { sourceGuid: "nd-home-cta", targetGuid: "ab-details", trigger: "drag" }));
  assert.equal(wrongTrigger.status, "wrong-trigger");
});

// --- MCP: validation report --------------------------------------------------

test("xd_validate_prototype produces a real pass/fail report", async (t) => {
  const c = new McpClient(PORT + 6, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const partial = payload(await c.callTool("xd_validate_prototype", {
    requiredConnections: [
      { fromGuid: "nd-home-cta", toGuid: "ab-details", trigger: "tap", action: "goToArtboard" },
      { fromGuid: "nd-details-book", toGuid: "ab-booking", trigger: "tap", action: "goToArtboard" },
    ],
  }));
  assert.equal(partial.verdict, "fail");
  assert.equal(partial.valid, false);
  assert.equal(partial.authoringSupported, false);
  assert.equal(partial.summary.expectedCount, 2);
  assert.equal(partial.summary.okCount, 1);
  assert.equal(partial.summary.missingCount, 1);
  assert.equal(partial.summary.coverage, 0.5);
  assert.equal(partial.missing[0].fromGuid, "nd-details-book");
  assert.equal(partial.expected[0].fromGuid, "nd-home-cta");

  const complete = payload(await c.callTool("xd_validate_prototype", {
    requiredConnections: [{ fromGuid: "nd-home-cta", toGuid: "ab-details", trigger: "tap", action: "goToArtboard" }],
  }));
  assert.equal(complete.verdict, "pass");
  assert.equal(complete.summary.detectedCount, 1);
  assert.deepEqual(complete.extra, []);
});

test("prototype tools are discoverable and advertise no authoring capability", async (t) => {
  const c = new McpClient(PORT + 7, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const list = await c.request("tools/list");
  const tools = (list.result as { tools: Array<{ name: string; description: string }> }).tools;
  const names = tools.map((x) => x.name);
  for (const expected of ["xd_prototype_plan", "xd_prototype_focus", "xd_prototype_prepare", "xd_prototype_verify"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  const prepare = tools.find((x) => x.name === "xd_prototype_prepare");
  assert.ok(prepare);
  assert.match(prepare.description, /Never creates the wire/i);

  const caps = payload(await c.callTool("xd_get_capabilities"));
  assert.match(caps.note, /read-only/i);
  assert.match(caps.note, /manual per-edge guidance/i);
  assert.equal(caps.prototypeAuthoring.pluginApi.startsWith("unsupported"), true);
});
