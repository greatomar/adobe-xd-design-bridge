/**
 * Stage 6 tests: platform grammar, planner preflight, and the persistent worker.
 *
 * The grammar tests encode measurements taken on XD 61.0.12.1 - they are the
 * contract the planner is held to. The preflight tests are pure (scripted
 * resolver). The worker tests spawn real PowerShell against tiny fixture
 * scripts, so they exercise the transport without touching XD.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCombination,
  grammarSummary,
  normalizeAction,
  normalizeTrigger,
  triggerSlot,
  authorableTriggers,
  GRAMMAR_VERSION,
} from "../bridge/src/automation/grammar.ts";
import { runPreflight, type PreflightResolver } from "../bridge/src/automation/preflight.ts";
import { normalizeBatchEdges } from "../bridge/src/automation/batch.ts";
import type { ResolveResult } from "../bridge/src/automation/adapter.ts";
import type { DetectedEdge } from "../bridge/src/automation/protocol.ts";
import { PersistentPowerShellRunner, PowerShellUiaRunner, HybridRunner } from "../bridge/src/automation/worker.ts";

// --- grammar ----------------------------------------------------------------

test("grammar: trigger and action names normalise", () => {
  assert.equal(normalizeTrigger("Tap"), "tap");
  assert.equal(normalizeTrigger("Keys & Gamepad"), "keys");
  assert.equal(normalizeTrigger("keys&gamepad"), "keys");
  assert.equal(normalizeAction("Transition"), "goToArtboard");
  assert.equal(normalizeAction("goToArtboard"), "goToArtboard");
  assert.equal(normalizeAction("Auto-Animate"), "autoAnimate");
  assert.deepEqual(authorableTriggers(), ["tap", "drag", "time", "voice"]);
});

test("grammar: verified_supported combinations", () => {
  for (const [trigger, action, transition] of [
    ["tap", "goToArtboard", "dissolve"],
    ["tap", "goToArtboard", "none"],
    ["time", "goToArtboard", "dissolve"],
    ["voice", "goToArtboard", "dissolve"],
  ]) {
    const v = classifyCombination(trigger, action, transition);
    assert.equal(v.support, "verified_supported", `${trigger}/${action}/${transition}`);
  }
});

test("grammar: verified_unsupported combination is drag + Transition", () => {
  const v = classifyCombination("drag", "goToArtboard", "dissolve");
  assert.equal(v.support, "verified_unsupported");
  assert.match(v.reason, /rejected|reset/i);
});

test("grammar: untested transition on a supported pair is unverified, not supported", () => {
  const v = classifyCombination("tap", "goToArtboard", "slide");
  assert.equal(v.support, "unverified");
  assert.match(v.reason, /not been verified/i);
});

test("grammar: Keys & Gamepad is not authorable and any use is unsupported/unverified", () => {
  const slot = triggerSlot("Keys & Gamepad");
  assert.ok(slot);
  assert.equal(slot!.authorable, false);
  const v = classifyCombination("keys", "goToArtboard", "dissolve");
  assert.ok(v.support === "verified_unsupported" || v.support === "unverified");
});

test("grammar: an unknown trigger is unsupported", () => {
  assert.equal(classifyCombination("hover", "goToArtboard", "dissolve").support, "verified_unsupported");
});

test("grammar summary is versioned and counts every rule", () => {
  const g = grammarSummary();
  assert.equal(g.version, GRAMMAR_VERSION);
  assert.equal(g.rules.length, g.bySupport.verified_supported + g.bySupport.verified_unsupported + g.bySupport.conditionally_supported + g.bySupport.unverified);
  assert.ok(g.bySupport.verified_supported >= 3);
});

// --- preflight ---------------------------------------------------------------

const SRC = { guid: "g-src", name: "SourceA", type: "Artboard" };
const DST = { guid: "g-dst", name: "Target1", type: "Artboard" };
const DST2 = { guid: "g-dst2", name: "Target2", type: "Artboard" };
const OK_SRC: ResolveResult = { node: SRC, reason: "ok", candidates: [] };
const OK_DST: ResolveResult = { node: DST, reason: "ok", candidates: [] };

function resolver(opts: { edges?: DetectedEdge[]; target?: ResolveResult; source?: ResolveResult } = {}): PreflightResolver {
  return {
    resolveSource: async () => opts.source ?? OK_SRC,
    resolveTarget: async () => opts.target ?? OK_DST,
    readEdges: async () => opts.edges ?? [],
  };
}

function edgesOf(list: Array<Record<string, unknown>>) {
  const n = normalizeBatchEdges(list);
  if (!n.ok) throw new Error(n.error);
  return n.edges;
}

test("preflight: safe_to_create when nothing is in the slot", async () => {
  const report = await runPreflight(resolver(), edgesOf([{ source: "SourceA", target: "Target1" }]), GRAMMAR_VERSION);
  assert.equal(report.ok, true);
  assert.equal(report.edges[0].status, "safe_to_create");
  assert.equal(report.blocking, 0);
  assert.equal(report.readOnly, true);
});

test("preflight: already_exists for an exact wire", async () => {
  const wire: DetectedEdge = {
    sourceGuid: "g-src", sourceName: "SourceA", triggerType: "tap", actionType: "goToArtboard",
    destinationGuid: "g-dst", destinationName: "Target1", transitionType: "dissolve", duration: 0.3,
  };
  const report = await runPreflight(resolver({ edges: [wire] }), edgesOf([{ source: "SourceA", target: "Target1" }]), GRAMMAR_VERSION);
  assert.equal(report.edges[0].status, "already_exists");
  assert.equal(report.ok, true);
});

test("preflight: conflict when the slot points elsewhere (create mode never repairs)", async () => {
  const wire: DetectedEdge = {
    sourceGuid: "g-src", sourceName: "SourceA", triggerType: "tap", actionType: "goToArtboard",
    destinationGuid: "g-other", destinationName: "Elsewhere", transitionType: "dissolve", duration: 0.3,
  };
  const report = await runPreflight(resolver({ edges: [wire] }), edgesOf([{ source: "SourceA", target: "Target1" }]), GRAMMAR_VERSION);
  assert.equal(report.edges[0].status, "conflict");
  assert.equal(report.ok, false);
  assert.match(report.blockers[0].reason, /Elsewhere/);
});

test("preflight: duplicate trigger slot inside one plan", async () => {
  const report = await runPreflight(
    resolver(),
    edgesOf([
      { source: "SourceA", target: "Target1", trigger: "tap" },
      { source: "SourceA", target: "Target2", trigger: "tap" },
    ]),
    GRAMMAR_VERSION,
  );
  assert.equal(report.edges[0].status, "safe_to_create");
  assert.equal(report.edges[1].status, "duplicate_trigger_slot");
  assert.equal(report.blocking, 1);
});

test("preflight: unsupported combination and unsupported trigger", async () => {
  const drag = await runPreflight(resolver(), edgesOf([{ source: "SourceA", target: "Target1", trigger: "drag", transition: "dissolve" }]), GRAMMAR_VERSION);
  assert.equal(drag.edges[0].status, "unsupported_combination");

  // "keys" is outside the planner schema on purpose: build the edge directly.
  const keysEdge = { ...edgesOf([{ source: "SourceA", target: "Target1" }])[0], trigger: "keys" as never };
  const keys = await runPreflight(resolver(), [keysEdge], GRAMMAR_VERSION);
  assert.equal(keys.edges[0].status, "unsupported_trigger");
});

test("preflight: unverified combination (untested transition)", async () => {
  const report = await runPreflight(resolver(), edgesOf([{ source: "SourceA", target: "Target1", transition: "slide" }]), GRAMMAR_VERSION);
  assert.equal(report.edges[0].status, "unverified_combination");
});

test("preflight: unresolved source and target are reported separately", async () => {
  const noSrc = await runPreflight(resolver({ source: { node: null, reason: "not_found", candidates: [] } }), edgesOf([{ source: "Nope", target: "Target1" }]), GRAMMAR_VERSION);
  assert.equal(noSrc.edges[0].status, "unresolved_source");

  const noDst = await runPreflight(resolver({ target: { node: null, reason: "not_found", candidates: [] } }), edgesOf([{ source: "SourceA", target: "Nope" }]), GRAMMAR_VERSION);
  assert.equal(noDst.edges[0].status, "unresolved_target");
});

test("preflight: strict mode reports EVERY blocker at once and mutates nothing", async () => {
  let writes = 0;
  const r: PreflightResolver = {
    resolveSource: async (input) => (input === "Missing" ? { node: null, reason: "not_found", candidates: [] } : OK_SRC),
    resolveTarget: async () => OK_DST,
    readEdges: async () => { writes++; return []; },
  };
  const report = await runPreflight(
    r,
    edgesOf([
      { source: "SourceA", target: "Target1", trigger: "tap" },
      { source: "SourceA", target: "Target2", trigger: "tap" },
      { source: "Missing", target: "Target1" },
      { source: "SourceA", target: "Target1", trigger: "drag", transition: "dissolve" },
    ]),
    GRAMMAR_VERSION,
  );
  assert.equal(report.total, 4);
  assert.equal(report.blocking, 3, "duplicate + unresolved + unsupported are all reported");
  const statuses = report.blockers.map((b) => b.status).sort();
  assert.deepEqual(statuses, ["duplicate_trigger_slot", "unresolved_source", "unsupported_combination"]);
  assert.equal(writes, 1, "preflight reads the document exactly once and writes nothing");
});

test("preflight: multiple triggers from one source are not duplicates", async () => {
  const report = await runPreflight(
    resolver(),
    edgesOf([
      { source: "SourceA", target: "Target1", trigger: "tap" },
      { source: "SourceA", target: "Target2", trigger: "time" },
      { source: "SourceA", target: "Target1", trigger: "voice" },
    ]),
    GRAMMAR_VERSION,
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.edges.map((e) => e.status), ["safe_to_create", "safe_to_create", "safe_to_create"]);
});

// --- persistent worker -------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "xd-uia-"));
const echoScript = join(dir, "echo.ps1");
writeFileSync(echoScript, [
  "param([string]$Base64,[switch]$Serve)",
  "if (-not $Serve) { @{ ok = $false; cmd = 'one-shot'; error = @{ code = 'ONESHOT_FIXTURE'; message = 'fixture answers only in -Serve mode'; stage = 'worker' } } | ConvertTo-Json -Compress; exit 2 }",
  "while ($true) {",
  "  $l = [Console]::In.ReadLine()",
  "  if ($null -eq $l) { break }",
  "  $r = $l | ConvertFrom-Json",
  "  [Console]::Out.WriteLine((@{ ok = $true; cmd = $r.cmd; result = @{ echo = $r.cmd } } | ConvertTo-Json -Compress))",
  "  [Console]::Out.Flush()",
  "}",
].join("\r\n"), "utf8");

const slowScript = join(dir, "slow.ps1");
writeFileSync(slowScript, [
  "param([string]$Base64,[switch]$Serve)",
  "while ($true) {",
  "  $l = [Console]::In.ReadLine()",
  "  if ($null -eq $l) { break }",
  "  $r = $l | ConvertFrom-Json",
  "  Start-Sleep -Milliseconds 250",
  "  [Console]::Out.WriteLine((@{ ok = $true; cmd = $r.cmd; result = @{ echo = $r.cmd } } | ConvertTo-Json -Compress))",
  "  [Console]::Out.Flush()",
  "}",
].join("\r\n"), "utf8");

const hangScript = join(dir, "hang.ps1");
writeFileSync(hangScript, [
  "param([string]$Base64,[switch]$Serve)",
  "[Console]::In.ReadLine() | Out-Null",
  "Start-Sleep -Seconds 30",
].join("\r\n"), "utf8");

const onceScript = join(dir, "once.ps1");
writeFileSync(onceScript, [
  "param([string]$Base64,[switch]$Serve)",
  "$l = [Console]::In.ReadLine()",
  "$r = $l | ConvertFrom-Json",
  "[Console]::Out.WriteLine((@{ ok = $true; cmd = $r.cmd; result = @{ echo = $r.cmd } } | ConvertTo-Json -Compress))",
  "[Console]::Out.Flush()",
  "exit 0",
].join("\r\n"), "utf8");

test("persistent worker: many requests share one process and answer in order", async () => {
  const runner = new PersistentPowerShellRunner({ scriptPath: echoScript, timeoutMs: 20_000 });
  try {
    const first = await runner.run("ping");
    assert.equal(first.ok, true);
    const started = Date.now();
    for (let i = 0; i < 10; i++) {
      const r = await runner.run(`cmd${i}`);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.result.echo, `cmd${i}`);
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `10 serial requests should be fast, took ${elapsed}ms`);
  } finally {
    runner.close();
  }
});

test("persistent worker: requests are strictly serial (no overlap)", async () => {
  const runner = new PersistentPowerShellRunner({ scriptPath: slowScript, timeoutMs: 20_000 });
  try {
    const started = Date.now();
    const results = await Promise.all([runner.run("a"), runner.run("b"), runner.run("c")]);
    const elapsed = Date.now() - started;
    assert.ok(results.every((r) => r.ok));
    // 3 × 250 ms serial; concurrent execution would be ~250 ms.
    assert.ok(elapsed >= 700, `expected serial execution >= 700ms, got ${elapsed}ms`);
  } finally {
    runner.close();
  }
});

test("persistent worker: a hung command times out and the process is discarded", async () => {
  const runner = new PersistentPowerShellRunner({ scriptPath: hangScript, timeoutMs: 900 });
  try {
    const r = await runner.run("hang");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "AUTOMATION_TIMEOUT");
  } finally {
    runner.close();
  }
});

test("persistent worker: recovers after the process dies", async () => {
  const runner = new PersistentPowerShellRunner({ scriptPath: onceScript, timeoutMs: 20_000 });
  try {
    const first = await runner.run("first");
    assert.equal(first.ok, true);
    // The script exits after one answer; the next request must respawn.
    await new Promise((r) => setTimeout(r, 300));
    const second = await runner.run("second");
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.result.echo, "second");
  } finally {
    runner.close();
  }
});

test("one-shot worker still works and is used when persistence is disabled", async () => {
  const oneShot = new PowerShellUiaRunner({ scriptPath: echoScript, timeoutMs: 20_000 });
  const r = await oneShot.run("ping");
  assert.equal(r.ok, false, "echo fixture expects -Serve style stdin, so one-shot must fail cleanly, not hang");

  process.env.XD_UIA_PERSISTENT = "0";
  try {
    const hybrid = new HybridRunner({ scriptPath: echoScript, timeoutMs: 20_000 });
    const h = await hybrid.run("ping");
    assert.equal(h.ok, false, "with persistence disabled the one-shot path is used");
  } finally {
    delete process.env.XD_UIA_PERSISTENT;
  }
});

test("persistent worker: missing script reports WORKER_UNAVAILABLE", async () => {
  const runner = new PersistentPowerShellRunner({ scriptPath: join(dir, "absent.ps1"), maxFailures: 1 });
  const r = await runner.run("ping");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "WORKER_UNAVAILABLE");
  runner.close();
});




// --- stage 7: schema completion ---------------------------------------------

test("keys is accepted by the request schema and reaches preflight as unsupported_trigger", async () => {
  const n = normalizeBatchEdges([{ source: "SourceA", target: "Target1", trigger: "keys" }]);
  assert.equal(n.ok, true, "keys must be expressible so preflight can classify it");
  if (!n.ok) return;
  assert.equal(n.edges[0].trigger, "keys");

  const report = await runPreflight(resolver(), n.edges, GRAMMAR_VERSION);
  assert.equal(report.edges[0].status, "unsupported_trigger");
  assert.equal(report.ok, false);
  assert.match(report.blockers[0].reason, /Keys & Gamepad|cannot be authored/i);
});

test("keys never reaches the suggested path: classification is blocking, not authorable", () => {
  const v = classifyCombination("keys", "goToArtboard", "dissolve");
  assert.equal(v.support, "verified_unsupported");
  assert.equal(triggerSlot("keys")!.authorable, false);
});

test("drag + Auto-Animate is classified conditional (allowed), drag + dissolve stays blocked", () => {
  const auto = classifyCombination("drag", "goToArtboard", "autoAnimate");
  assert.equal(auto.support, "conditionally_supported");

  const dissolve = classifyCombination("drag", "goToArtboard", "dissolve");
  assert.equal(dissolve.support, "verified_unsupported");
  assert.match(dissolve.reason, /only autoAnimate/i);
});

test("preflight accepts a drag + Auto-Animate edge and blocks drag + dissolve", async () => {
  const ok = await runPreflight(resolver(), edgesOf([{ source: "SourceA", target: "Target1", trigger: "drag", transition: "autoAnimate" }]), GRAMMAR_VERSION);
  assert.equal(ok.edges[0].status, "safe_to_create");
  assert.equal(ok.edges[0].grammar?.support, "conditionally_supported");

  const blocked = await runPreflight(resolver(), edgesOf([{ source: "SourceA", target: "Target1", trigger: "drag", transition: "dissolve" }]), GRAMMAR_VERSION);
  assert.equal(blocked.edges[0].status, "unsupported_combination");
});

test("strict preflight with keys + unsupported drag performs zero mutations", async () => {
  let reads = 0;
  const r: PreflightResolver = {
    resolveSource: async () => OK_SRC,
    resolveTarget: async () => OK_DST,
    readEdges: async () => { reads++; return []; },
  };
  const report = await runPreflight(
    r,
    edgesOf([
      { source: "SourceA", target: "Target1", trigger: "keys" },
      { source: "SourceA", target: "Target1", trigger: "drag", transition: "dissolve" },
      { source: "SourceA", target: "Target1", trigger: "tap" },
      { source: "SourceA", target: "Target2", trigger: "tap" },
    ]),
    GRAMMAR_VERSION,
  );
  assert.equal(report.ok, false);
  assert.equal(report.blocking, 3);
  assert.equal(reads, 1);
  // the only safe edge is still reported as safe, nothing is executed here
  assert.equal(report.summary.safe_to_create, 1);
});

test("Auto-Animate expected UI has no transition or duration to configure", async () => {
  const { expectedUi, isAutoAnimate, expectsDuration } = await import("../bridge/src/automation/protocol.ts");
  assert.equal(isAutoAnimate("autoAnimate"), true);
  assert.equal(isAutoAnimate("dissolve"), false);
  assert.equal(expectsDuration("autoAnimate"), false);

  const ui = expectedUi(
    { source: "A", target: "B", trigger: "drag", action: "goToArtboard", transition: "autoAnimate", duration: 0.3, mode: "prototype" },
    "B",
  );
  assert.equal(ui.trigger, "Drag");
  assert.equal(ui.action, "Auto-Animate");
  assert.equal(ui.transition, "Auto-Animate");
  assert.equal(ui.duration, "");
});

// --- stage 7b: graph schema accepts keys (aligned with preflight) ------------

test("every authoring input schema accepts keys; read-only validator schema is unchanged", async (t) => {
  const { McpClient } = await import("./helpers.ts");
  const c = new McpClient(27291, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const list = await c.request("tools/list");
  const tools = (list.result as { tools: Array<{ name: string; inputSchema: any }> }).tools;
  const byName = (n: string) => tools.find((x) => x.name === n)!;

  const graph = byName("xd_create_prototype_graph").inputSchema.properties.edges.items.properties.trigger.enum;
  assert.ok(graph.includes("keys"), "graph edges must accept keys so preflight can classify it");

  const single = byName("xd_create_prototype_interaction").inputSchema.properties.trigger.enum;
  assert.ok(single.includes("keys"), "single-edge tool must let the adapter answer, not the schema");

  const plan = byName("xd_prototype_plan").inputSchema.properties.manifest.properties.edges.items.properties.trigger.enum;
  assert.ok(plan.includes("keys"), "the planner manifest is a graph input path and must accept keys");

  // read-only validator describes document state, where keys wires cannot exist
  const validator = byName("xd_validate_prototype").inputSchema.properties.requiredConnections.items.properties.trigger.enum;
  assert.ok(!validator.includes("keys"), "validator input intentionally unchanged");
});

test("live-shaped strict call: a keys edge is preflight_blocked, never invalid_params", async (t) => {
  const { McpClient } = await import("./helpers.ts");
  const c = new McpClient(27292, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const payload = (r: Record<string, unknown>) =>
    JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text) as Record<string, any>;

  const plan = await c.callTool("xd_validate_prototype_plan", { edges: [{ source: "Home", target: "Details", trigger: "keys" }] });
  const planBody = payload(plan);
  assert.equal(planBody.edges[0].status, "unsupported_trigger");
  assert.equal(planBody.blocking, 1);

  const graph = await c.callTool("xd_create_prototype_graph", {
    edges: [{ source: "Home", target: "Details", trigger: "keys" }],
    strictPreflight: true,
  });
  assert.equal((graph.result as { isError?: boolean }).isError, true);
  const body = payload(graph);
  assert.equal(body.status, "preflight_blocked", "must be a preflight block, not a schema rejection");
  assert.equal(body.created, 0);
  assert.notEqual(body.code, "invalid_params");
  assert.equal(body.preflight.blockers[0].status, "unsupported_trigger");
});

test("blocked keys run leaves the document untouched and issues no UI automation", async (t) => {
  const { McpClient } = await import("./helpers.ts");
  const c = new McpClient(27293, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const payload = (r: Record<string, unknown>) =>
    JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text) as Record<string, any>;

  const before = payload(await c.callTool("xd_get_prototype_state"));
  const beforeEdges = (before.interactions || []).reduce((n: number, r: any) => n + (r.interactions || []).length, 0);

  await c.callTool("xd_create_prototype_graph", {
    edges: [{ source: "Home", target: "Details", trigger: "keys" }],
    strictPreflight: true,
  });

  const after = payload(await c.callTool("xd_get_prototype_state"));
  const afterEdges = (after.interactions || []).reduce((n: number, r: any) => n + (r.interactions || []).length, 0);
  assert.equal(afterEdges, beforeEdges, "zero document mutation");

  const boards = payload(await c.callTool("xd_get_artboards"));
  assert.equal(boards.count, 3, "no artboard created");
});
