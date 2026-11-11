/**
 * Agent workflow tests: the failure surface the handler tests never covered —
 * queueing, waiting for the panel, verifying execution, read-back, recovery,
 * evidence levels and multi-screen continuation.
 *
 * These exercise `workflow-harness.ts` (the executable form of the agent
 * contract). They do NOT prove live XD compatibility; see TESTING.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Bridge,
  EvidenceError,
  ExecutionController,
  FakeXd,
  PanelQueue,
  evaluateScreen,
  mapTextStyle,
} from "./workflow-harness.ts";

function setup(expectedScreens = 1) {
  const xd = new FakeXd();
  const panel = new PanelQueue(xd);
  const bridge = new Bridge(panel);
  const ctrl = new ExecutionController(panel, bridge, xd, expectedScreens);
  ctrl.discover();
  ctrl.inspect();
  ctrl.plan(); // -> PREPARE
  return { xd, panel, bridge, ctrl };
}

const AB_FRAME = { x: 0, y: 0, width: 375, height: 812 };
const CARD_FRAME = { x: 24, y: 120, width: 327, height: 180 };

function makeArtboard(env: ReturnType<typeof setup>, name = "Screen/A") {
  env.ctrl.queueBatch([{ op: "create_artboard", name, frame: AB_FRAME }]);
  env.ctrl.userClicksExecute();
  env.ctrl.verifyExecution();
  env.ctrl.readBack([{ name, parent: "root", frame: AB_FRAME }]);
  return env.ctrl.guids.get(name)!;
}

function addCard(env: ReturnType<typeof setup>, parent: string, name = "Card/Base") {
  env.ctrl.queueBatch([
    { op: "create_rectangle", parent, name, frame: CARD_FRAME, style: { fill: "#14171D" } },
  ]);
  env.ctrl.userClicksExecute();
  env.ctrl.verifyExecution();
  env.ctrl.readBack([{ name, parent, frame: CARD_FRAME, fill: "#14171D" }]);
}

// 1
test("agent stops after artboard creation: no rendering evidence, no level-5 claim", () => {
  const env = setup();
  const abGuid = makeArtboard(env);
  assert.equal(env.ctrl.level, 4, "artboard read-back is LEVEL 4");
  assert.throws(() => env.ctrl.claim(5), (e: any) => e instanceof EvidenceError && e.code === "premature_claim");
  assert.throws(() => env.ctrl.exportAndRender(abGuid), (e: any) => e.code === "empty_export");
  assert.equal(env.ctrl.state, "RECOVER");
});

// 2
test("agent queues but does not wait: cannot verify or read back", () => {
  const env = setup();
  env.ctrl.queueBatch([{ op: "create_artboard", name: "Screen/A", frame: AB_FRAME }]);
  assert.equal(env.ctrl.state, "WAIT_FOR_PANEL_EXECUTION");
  assert.throws(() => env.ctrl.verifyExecution(), (e: any) => e.code === "illegal_transition");
  assert.throws(() => env.ctrl.readBack([{ name: "Screen/A", parent: "root", frame: AB_FRAME }]), (e: any) => e.code === "illegal_transition");
});

// 3
test("user has not clicked Execute pending: work stays queued and blocks new batches", () => {
  const env = setup();
  env.ctrl.queueBatch([{ op: "create_artboard", name: "Screen/A", frame: AB_FRAME }]);
  assert.equal(env.panel.depth(), 1);
  assert.equal(env.bridge.status().lastEvent, null, "no execution event before the click");
  assert.throws(() => env.ctrl.queueBatch([{ op: "create_artboard", name: "Screen/B", frame: AB_FRAME }]), (e: any) => e.code === "illegal_transition");
  assert.equal(env.xd.byName("Screen/A"), undefined, "queued is not created");
});

// 4
test("queue execution fails: transitions to recovery, never to success", () => {
  const env = setup();
  const ab = makeArtboard(env);
  const levelBefore = env.ctrl.level;
  env.xd.failOps.add("create_rectangle");
  env.ctrl.queueBatch([{ op: "create_rectangle", parent: ab, name: "Card/Base", frame: CARD_FRAME }]);
  env.ctrl.userClicksExecute();
  assert.throws(() => env.ctrl.verifyExecution(), (e: any) => e.code === "execution_failed");
  assert.equal(env.ctrl.state, "RECOVER");
  assert.equal(env.ctrl.level, levelBefore, "a failed batch never raises the evidenced level");
  assert.equal(env.ctrl.batches.at(-1)!.result!.ok, false);
});

// 5
test("panel reload with pending writes: unknown state, no blind retry", () => {
  const env = setup();
  const ab = makeArtboard(env);
  env.ctrl.queueBatch([{ op: "create_rectangle", parent: ab, name: "Card/Base", frame: CARD_FRAME }]);

  assert.equal(env.ctrl.panelReloaded(), true);
  assert.equal(env.ctrl.state, "UNKNOWN_QUEUE_LOST");
  assert.equal(env.panel.depth(), 0, "queue is gone");

  assert.throws(
    () => env.ctrl.requeueAfterLoss([{ op: "create_rectangle", parent: ab, name: "Card/Base", frame: CARD_FRAME }]),
    (e: any) => e.code === "blind_retry",
  );

  const verdict = env.ctrl.resolveUnknownQueue([{ name: "Card/Base", parent: ab, frame: CARD_FRAME }]);
  assert.equal(verdict, "not_applied");
  assert.equal(env.ctrl.state, "PREPARE");
  env.ctrl.requeueAfterLoss([{ op: "create_rectangle", parent: ab, name: "Card/Base", frame: CARD_FRAME }]);
  assert.equal(env.panel.depth(), 1);
});

// 6
test("operation succeeds but read-back fails: recovery, not success", () => {
  const env = setup();
  const ab = makeArtboard(env);
  env.ctrl.queueBatch([{ op: "create_rectangle", parent: ab, name: "Card/Base", frame: CARD_FRAME }]);
  env.ctrl.userClicksExecute();
  env.ctrl.verifyExecution();
  const node = env.xd.byName("Card/Base")!;
  env.xd.nodes.delete(node.guid); // simulate a silently missing node
  assert.throws(() => env.ctrl.readBack([{ name: "Card/Base", parent: ab, frame: CARD_FRAME }]), (e: any) => e.code === "missing_node");
  assert.equal(env.ctrl.state, "RECOVER");
});

// 7
test("created node exists under the wrong parent: rejected", () => {
  const env = setup();
  const a = makeArtboard(env, "Screen/A");
  const b = makeArtboard(env, "Screen/B");
  env.xd.wrongParentOps.add("create_rectangle");
  env.ctrl.queueBatch([{ op: "create_rectangle", parent: a, name: "Card/Base", frame: CARD_FRAME }]);
  env.ctrl.userClicksExecute();
  env.ctrl.verifyExecution();
  assert.throws(
    () => env.ctrl.readBack([{ name: "Card/Base", parent: a, frame: CARD_FRAME }]),
    (e: any) => e.code === "wrong_parent",
  );
  assert.ok(b, "second artboard exists but is not the intended parent");
});

// 8
test("created node has invalid dimensions: rejected", () => {
  const env = setup();
  const ab = makeArtboard(env);
  env.xd.zeroSizeOps.add("create_rectangle");
  env.ctrl.queueBatch([{ op: "create_rectangle", parent: ab, name: "Card/Base", frame: CARD_FRAME }]);
  env.ctrl.userClicksExecute();
  env.ctrl.verifyExecution();
  assert.throws(() => env.ctrl.readBack([{ name: "Card/Base", parent: ab, frame: CARD_FRAME }]), (e: any) => e.code === "invalid_dimensions");
});

// 9
test("export produces an empty image: LEVEL 5 is not achieved", () => {
  const env = setup();
  const ab = makeArtboard(env);
  addCard(env, ab);
  env.xd.failExport = true;
  assert.throws(() => env.ctrl.exportAndRender(ab, "Screen/A"), (e: any) => e.code === "empty_export");
  assert.equal(env.ctrl.state, "RECOVER");
  assert.throws(() => env.ctrl.claim(5));
});

// 10
test("premature success claim is rejected at every level", () => {
  const env = setup();
  assert.throws(() => env.ctrl.claim(1), (e: any) => e.code === "premature_claim");
  env.ctrl.queueBatch([{ op: "create_artboard", name: "Screen/A", frame: AB_FRAME }]);
  assert.equal(env.ctrl.claim(2), true, "queue is provable");
  assert.throws(() => env.ctrl.claim(3), (e: any) => e.code === "premature_claim");
});

// 11
test("text style uses documented XD keys without a fallback", () => {
  const mapped = mapTextStyle({ fontFamily: "Segoe UI", fontSize: 13, fill: "#F4F6F8", fontWeight: "Semibold", lineHeight: 20 });
  assert.equal(mapped.range.fontFamily, "Segoe UI");
  assert.equal(mapped.range.fontStyle, "Semibold");
  assert.equal(mapped.range.fill, "#F4F6F8");
  assert.equal("fontWeight" in mapped.range, false);
  assert.deepEqual(mapped.fallbackOps, []);
  assert.ok(mapped.notes.some((n) => /lineHeight/i.test(n)));
});

// 12
test("agent creates styled text in one verified content batch and reaches LEVEL 4", () => {
  const env = setup();
  const ab = makeArtboard(env);
  const mapped = mapTextStyle({ fontFamily: "Segoe UI", fontSize: 13, fill: "#F4F6F8", fontWeight: "Semibold" });
  const frame = { x: 24, y: 24, width: 200, height: 20 };

  // One content batch uses the actual supported fontStyle/fill mappings.
  env.ctrl.queueBatch([
    { op: "create_text", parent: ab, name: "Card/Title", text: "Total balance", frame, style: mapped.range },
  ]);
  env.ctrl.userClicksExecute();
  env.ctrl.verifyExecution();
  env.ctrl.readBack([{ name: "Card/Title", parent: ab, frame, fill: "#F4F6F8" }]);

  assert.equal(env.ctrl.level, 4);
  assert.equal(env.xd.byName("Card/Title")!.fill, "#F4F6F8");
  assert.equal(env.ctrl.batches.length, 2, "one content batch after the artboard batch");
});

// 13
test("multi-screen project needs multiple execution cycles and ends at LEVEL 7", () => {
  const env = setup(2);
  const screens = ["Screen/A", "Screen/B"];
  for (const [i, screen] of screens.entries()) {
    const ab = makeArtboard(env, screen);
    addCard(env, ab);
    env.ctrl.exportAndRender(ab, screen);
    assert.equal(env.ctrl.level, 5);
    env.ctrl.qaPass();
    assert.equal(env.ctrl.level, 6);
    if (i < screens.length - 1) env.ctrl.beginNextScreen();
  }
  assert.equal(env.ctrl.batches.length, 4, "two screens × two batches, four panel executions");
  env.ctrl.finalVerify();
  env.ctrl.deliver();
  assert.equal(env.ctrl.level, 7);
  assert.equal(env.ctrl.screens.size, 2);
});

// 14
test("GUIDs come from execution results; invented parents fail", () => {
  const env = setup();
  const ab = makeArtboard(env);
  assert.equal(env.ctrl.guids.get("Screen/A"), env.xd.byName("Screen/A")!.guid);
  assert.equal(env.xd.byName("Screen/A")!.guid.startsWith("guid-"), true);

  env.ctrl.queueBatch([{ op: "create_rectangle", parent: "guid-invented", name: "Card/Base", frame: CARD_FRAME }]);
  env.ctrl.userClicksExecute();
  assert.throws(() => env.ctrl.verifyExecution(), (e: any) => e.code === "execution_failed");
  assert.equal(env.ctrl.state, "RECOVER");
});

// 15
test("completed screen carries verified rendered content", () => {
  const env = setup();
  const ab = makeArtboard(env);
  addCard(env, ab);
  const image = env.ctrl.exportAndRender(ab, "Screen/A");
  assert.ok(image.length > 0, "non-empty render");
  assert.deepEqual([...env.ctrl.screens], ["Screen/A"]);
  assert.equal(env.ctrl.claim(5), true);
  env.ctrl.qaPass();
  assert.equal(env.ctrl.claim(6), true);
});

// --- screen completeness: an artboard is not a screen ------------------------

const DASHBOARD_MANIFEST = [
  { role: "Dashboard/Background", types: ["Rectangle"] },
  { role: "Dashboard/Header/Title", types: ["Text"], requireNonEmptyText: true },
  { role: "Dashboard/Performance/Chart", types: ["Path"] },
  { role: "Dashboard/Assets/Table", types: ["Group"] },
];

function scenario(opts: { background: boolean; text: boolean; chart: boolean; table: boolean }) {
  const env = setup();
  const ab = env.xd.createArtboard("Screen/Test", { x: 0, y: 0, width: 1440, height: 1024 }, null);
  if (opts.background) env.xd.createShape("create_rectangle", "Dashboard/Background", ab.guid, { x: 0, y: 0, width: 1440, height: 1024 }, "#0C0E12");
  if (opts.text) {
    env.xd.createText("Dashboard/Header/Title", ab.guid, { x: 32, y: 28, width: 260, height: 28 }, "Portfolio overview");
  }
  if (opts.chart) {
    env.xd.createShape("create_path", "Dashboard/Performance/Chart/Series", ab.guid, { x: 32, y: 140, width: 500, height: 160 }, "#E3B04B");
  }
  if (opts.table) {
    const first = env.xd.createShape("create_rectangle", "Dashboard/Assets/Table/Row 01", ab.guid, { x: 32, y: 360, width: 500, height: 36 }, "#14171D");
    const second = env.xd.createShape("create_rectangle", "Dashboard/Assets/Table/Row 02", ab.guid, { x: 32, y: 404, width: 500, height: 36 }, "#14171D");
    env.xd.run({ op: "create_group", guids: [first.guid, second.guid], name: "Dashboard/Assets/Table" });
    const group = [...env.xd.nodes.values()].find((n) => n.name === "Dashboard/Assets/Table");
    if (group) group.type = "Group";
  }
  return { env, ab };
}

test("artboard-only screen fails its specific content manifest", () => {
  const { env } = scenario({ background: false, text: false, chart: false, table: false });
  const e = evaluateScreen(env.xd, "Screen/Test", DASHBOARD_MANIFEST);
  assert.equal(e.complete, false);
  assert.deepEqual(e.missingRoles, DASHBOARD_MANIFEST.map((r) => r.role));
  assert.equal(e.stats.descendants, 0);
});

test("background and placeholder panels fail: required content roles are absent", () => {
  const { env } = scenario({ background: true, text: false, chart: false, table: false });
  const e = evaluateScreen(env.xd, "Screen/Test", DASHBOARD_MANIFEST);
  assert.equal(e.complete, false);
  assert.deepEqual(e.missingRoles, ["Dashboard/Header/Title", "Dashboard/Performance/Chart", "Dashboard/Assets/Table"]);
});

test("screen manifest can require actual text, data visualisation, and a table group", () => {
  const { env } = scenario({ background: true, text: true, chart: true, table: false });
  const e = evaluateScreen(env.xd, "Screen/Test", DASHBOARD_MANIFEST);
  assert.deepEqual(e.missingRoles, ["Dashboard/Assets/Table"]);
  assert.equal(e.complete, false);
});

test("complete screen passes its manifest; optional render gate is explicit", () => {
  const { env } = scenario({ background: true, text: true, chart: true, table: true });
  const structural = evaluateScreen(env.xd, "Screen/Test", DASHBOARD_MANIFEST);
  assert.equal(structural.complete, true);
  assert.deepEqual(structural.missingRoles, []);

  const renderRequired = evaluateScreen(env.xd, "Screen/Test", DASHBOARD_MANIFEST, { requireRender: true });
  assert.equal(renderRequired.complete, false);
  assert.deepEqual(renderRequired.missingRoles, ["rendered-preview"]);

  const rendered = evaluateScreen(env.xd, "Screen/Test", DASHBOARD_MANIFEST, { requireRender: true, rendered: true });
  assert.equal(rendered.complete, true);
});

test("completion is decided by required regions, not by artboard existence", () => {
  const env = setup();
  env.xd.createArtboard("Screen/Empty", { x: 0, y: 0, width: 1440, height: 1024 }, null);
  assert.ok(env.xd.byName("Screen/Empty"), "artboard exists");
  const e = evaluateScreen(env.xd, "Screen/Empty", DASHBOARD_MANIFEST);
  assert.equal(e.complete, false);
  assert.equal(e.stats.children, 0);
  assert.equal(e.missingRoles.length, DASHBOARD_MANIFEST.length);
});
