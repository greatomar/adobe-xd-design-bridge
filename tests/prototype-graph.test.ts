/**
 * Batch prototype graph authoring - orchestrator tests.
 *
 * These tests exercise `runPrototypeGraphBatch` against a scripted edge
 * executor and a scripted validator. They prove ordering, aggregation,
 * idempotency, conflict reporting, failure policies, the cancellation boundary
 * and input normalisation.
 *
 * They do NOT prove that Adobe XD writes a wire: that is the adapter's live
 * acceptance (see automation/PrototypeAutomation/evidence/ACCEPTANCE-REPORT.md
 * and the graph live run).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBatchEdges,
  runPrototypeGraphBatch,
  findUnexpectedEdges,
  findTargetOnlyExtras,
  type BatchEdge,
  type EdgeOutcome,
  type GraphRequirement,
  type GraphValidation,
} from "../bridge/src/automation/batch.ts";
import type { AdapterStatus } from "../bridge/src/automation/adapter.ts";
import type { DetectedEdge } from "../bridge/src/automation/protocol.ts";

const EDGES: BatchEdge[] = normalizeBatchEdges([
  { source: "A", target: "B" },
  { source: "B", target: "C" },
  { source: "C", target: "D" },
  { source: "D", target: "A" },
]).ok
  ? (normalizeBatchEdges([{ source: "A", target: "B" }, { source: "B", target: "C" }, { source: "C", target: "D" }, { source: "D", target: "A" }]) as { ok: true; edges: BatchEdge[] }).edges
  : [];

function outcome(status: AdapterStatus, source: string, target: string, verified = status === "success" || status === "already_exists" || status === "repaired"): EdgeOutcome {
  return {
    status,
    created: status === "success",
    verified,
    source: { input: source, guid: `guid-${source}`, name: source, type: "Artboard" },
    target: { input: target, guid: `guid-${target}`, name: target, type: "Artboard" },
    verification: verified ? { verdict: "ok", verified: true, match: null, matches: [], problems: [] } : {
      verdict: status === "conflict" ? "wrong-destination" : "missing",
      verified: false,
      match: null,
      matches: [],
      problems: status === "conflict" ? ["source is wired to X instead of B"] : ["no interaction exists on the source node"],
    },
    detected: status === "conflict" ? [{
      sourceGuid: `guid-${source}`,
      sourceName: source,
      triggerType: "tap",
      actionType: "goToArtboard",
      destinationGuid: "guid-elsewhere",
      destinationName: "Elsewhere",
      transitionType: "dissolve",
      duration: 0.3,
    }] : null,
    observedUi: { trigger: "Tap" },
    failure: status === "success" || status === "already_exists" ? null : {
      code: status === "conflict" ? "CONNECTOR_CREATION_FAILED" : "VERIFICATION_FAILED",
      stage: status === "conflict" ? "precheck" : "verify",
      message: "scripted",
      xdModified: status !== "conflict",
      recoverable: status !== "conflict",
      hint: "scripted",
    },
    stages: [{ stage: "scripted", ok: true, ms: 1 }],
    durationMs: 5,
  };
}

class ScriptedExecutor {
  calls: Array<{ source: string; target: string }> = [];
  inFlight = 0;
  maxConcurrent = 0;
  private plan: Array<{ status: AdapterStatus; verified?: boolean }>;
  private delayMs: number;

  constructor(plan: Array<{ status: AdapterStatus; verified?: boolean }>, delayMs = 0) {
    this.plan = plan;
    this.delayMs = delayMs;
  }

  async createInteraction(request: Record<string, unknown>): Promise<EdgeOutcome> {
    this.calls.push({ source: String(request.source), target: String(request.target) });
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      const step = this.plan[this.calls.length - 1] ?? { status: "success" as AdapterStatus };
      return outcome(step.status, String(request.source), String(request.target), step.verified);
    } finally {
      this.inFlight--;
    }
  }
}

function validationOf(partial: Partial<GraphValidation> = {}): GraphValidation {
  return {
    verdict: "pass",
    valid: true,
    coverage: 1,
    expectedCount: 4,
    missingCount: 0,
    incorrectCount: 0,
    extraCount: 71,
    unexpected: [],
    unexpectedOnTargets: [],
    note: "test",
    ...partial,
  };
}

// --- input normalisation -----------------------------------------------------

test("normalise: flat edges, planner-shaped edges and defaults", () => {
  const v = normalizeBatchEdges([
    { source: "PrototypeBatchTest/ScreenA", target: "PrototypeBatchTest/ScreenB" },
    { source: "PrototypeBatchTest/ScreenB", target: "PrototypeBatchTest/ScreenC", trigger: "tap", action: "goToArtboard", transition: "slide-left", duration: 0.5 },
  ]);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.edges[0].trigger, "tap");
  assert.equal(v.edges[0].transition, "dissolve");
  assert.equal(v.edges[0].duration, 0.3);
  assert.equal(v.edges[0].index, 0);
  assert.equal(v.edges[1].duration, 0.5);
  assert.equal(v.edges[1].transition, "slide-left");

  const plannerShaped = normalizeBatchEdges([
    { sourceNode: { guid: "g-a", name: "A" }, targetArtboard: { guid: "g-b", name: "B" }, trigger: "tap", action: "goToArtboard" },
  ]);
  assert.equal(plannerShaped.ok, true);
  if (!plannerShaped.ok) return;
  assert.equal(plannerShaped.edges[0].source, "A");
  assert.equal(plannerShaped.edges[0].target, "B");
});

test("normalise: rejects invalid input instead of guessing", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /must be an array/],
    [[], /must not be empty/],
    [[{ target: "B" }], /source is required/],
    [[{ source: "A" }], /target is required/],
    [[{ source: "A", target: "B", trigger: "hover" }], /trigger must be one of/],
    [[{ source: "A", target: "B", action: "scroll" }], /action must be one of/],
    [[{ source: "A", target: "B", duration: 11 }], /between 0 and 10/],
    [[{ source: "A", target: "B", mode: "share" }], /mode must be design or prototype/],
  ];
  for (const [input, expected] of cases) {
    const v = normalizeBatchEdges(input);
    assert.equal(v.ok, false, `should reject ${JSON.stringify(input)}`);
    if (v.ok) continue;
    assert.match(v.error, expected);
  }
});

// --- execution ----------------------------------------------------------------

test("one edge: created, verified, validated", async () => {
  const executor = new ScriptedExecutor([{ status: "success" }]);
  let validatedWith: GraphRequirement[] | null = null;
  const result = await runPrototypeGraphBatch(executor, EDGES.slice(0, 1), {
    validate: (reqs) => { validatedWith = reqs; return validationOf({ expectedCount: 1 }); },
  });

  assert.equal(result.status, "success");
  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.equal(result.processed, 1);
  assert.deepEqual(result.summary, { created: 1, already_exists: 0, repaired: 0, deleted: 0, conflicts: 0, failed: 0, skipped: 0 });
  assert.equal(result.edges[0].status, "created");
  assert.equal(result.edges[0].created, true);
  assert.equal(result.edges[0].verified, true);
  assert.equal(result.edges[0].sourceGuid, "guid-A");
  assert.deepEqual(result.edges[0].requested, { trigger: "tap", action: "goToArtboard", transition: "dissolve", duration: 0.3 });
  assert.deepEqual(validatedWith, [{ fromGuid: "guid-A", toGuid: "guid-B", trigger: "tap", action: "goToArtboard" }]);
  assert.equal(result.validation?.verdict, "pass");
});

test("edges execute strictly serially in order", async () => {
  const executor = new ScriptedExecutor(EDGES.map(() => ({ status: "success" as AdapterStatus })), 5);
  const result = await runPrototypeGraphBatch(executor, EDGES, { validate: () => validationOf() });

  assert.equal(result.status, "success");
  assert.equal(executor.maxConcurrent, 1, "never more than one UI automation transaction in flight");
  assert.deepEqual(executor.calls.map((c) => `${c.source}→${c.target}`), ["A→B", "B→C", "C→D", "D→A"]);
  assert.equal(result.summary.created, 4);
  assert.equal(result.progress.length, 8, "two progress lines per edge");
  assert.match(result.progress[0], /edge 1\/4/);
});

test("second run with identical edges reports already_exists and creates nothing", async () => {
  const executor = new ScriptedExecutor(EDGES.map(() => ({ status: "already_exists" as AdapterStatus })));
  const result = await runPrototypeGraphBatch(executor, EDGES, { validate: () => validationOf() });

  assert.equal(result.status, "already_exists");
  assert.equal(result.ok, true);
  assert.equal(result.summary.created, 0);
  assert.equal(result.summary.already_exists, 4);
  assert.ok(result.edges.every((e) => e.status === "already_exists" && e.verified && !e.created));
});

test("conflict is reported with the actual interaction and the next edge still runs", async () => {
  const executor = new ScriptedExecutor([
    { status: "success" },
    { status: "conflict" },
    { status: "success" },
  ]);
  const result = await runPrototypeGraphBatch(executor, EDGES.slice(0, 3), { validate: () => validationOf() });

  assert.equal(result.status, "partial_success");
  assert.equal(result.ok, false);
  assert.equal(result.summary.created, 2);
  assert.equal(result.summary.conflicts, 1);
  assert.equal(result.edges[1].status, "conflict");
  assert.equal(result.edges[1].verified, false);
  assert.equal(result.edges[1].evidence.failureCode, "CONNECTOR_CREATION_FAILED");
  assert.equal((result.edges[1].evidence.actual as DetectedEdge[])[0].destinationName, "Elsewhere");
  assert.equal(result.edges[2].status, "created", "continue_on_error must keep going");
});

test("continue_on_error aggregates a mixed run", async () => {
  const executor = new ScriptedExecutor([
    { status: "success" },
    { status: "success" },
    { status: "failed" },
    { status: "success" },
    { status: "already_exists" },
  ]);
  const result = await runPrototypeGraphBatch(executor, EDGES.concat(EDGES.slice(0, 1)).slice(0, 5), {
    validate: () => validationOf({ valid: false, verdict: "fail", missingCount: 1 }),
  });

  assert.equal(result.status, "partial_success");
  assert.equal(result.failurePolicy, "continue_on_error");
  assert.deepEqual(result.summary, { created: 3, already_exists: 1, repaired: 0, deleted: 0, conflicts: 0, failed: 1, skipped: 0 });
  assert.equal(result.processed, 5);
  assert.equal(result.aborted, false);
  assert.equal(result.validation?.valid, false);
});

test("fail_fast stops at the first failure and reports the rest as skipped", async () => {
  const executor = new ScriptedExecutor([
    { status: "success" },
    { status: "failed" },
    { status: "success" },
    { status: "success" },
  ]);
  const result = await runPrototypeGraphBatch(executor, EDGES, {
    failurePolicy: "fail_fast",
    validate: () => validationOf(),
  });

  assert.equal(result.aborted, true);
  assert.equal(result.status, "partial_success");
  assert.equal(executor.calls.length, 2, "execution stopped after the failure");
  assert.deepEqual(result.edges.map((e) => e.status), ["created", "failed", "skipped", "skipped"]);
  assert.deepEqual(result.summary, { created: 1, already_exists: 0, repaired: 0, deleted: 0, conflicts: 0, failed: 1, skipped: 2 });
  assert.equal(result.processed, 2);
});

test("fail_fast keeps verified results from earlier edges", async () => {
  const executor = new ScriptedExecutor([{ status: "success" }, { status: "success" }, { status: "failed" }]);
  const result = await runPrototypeGraphBatch(executor, EDGES.slice(0, 3), { failurePolicy: "fail_fast", validate: () => validationOf() });
  assert.equal(result.edges[0].verified, true);
  assert.equal(result.edges[1].verified, true);
  assert.equal(result.edges[2].status, "failed");
});

test("cancellation is checked between edges only", async () => {
  let calls = 0;
  const executor = new ScriptedExecutor(EDGES.map(() => ({ status: "success" as AdapterStatus })));
  const result = await runPrototypeGraphBatch(executor, EDGES, {
    validate: () => validationOf(),
    shouldAbort: () => ++calls > 2,
  });

  assert.equal(executor.calls.length, 2, "the third edge was never started");
  assert.equal(result.edges[2].status, "skipped");
  assert.equal(result.edges[3].status, "skipped");
  assert.equal(result.aborted, true);
  assert.equal(result.summary.skipped, 2);
});

test("validation failure downgrades an otherwise clean run", async () => {
  const executor = new ScriptedExecutor(EDGES.map(() => ({ status: "success" as AdapterStatus })));
  const result = await runPrototypeGraphBatch(executor, EDGES, {
    validate: () => validationOf({ valid: false, verdict: "fail", missingCount: 1, coverage: 0.75 }),
  });

  assert.equal(result.summary.failed, 0);
  assert.equal(result.status, "partial_success");
  assert.equal(result.validation?.coverage, 0.75);
});

test("a source-scoped extra interaction prevents a success verdict", async () => {
  const executor = new ScriptedExecutor(EDGES.map(() => ({ status: "success" as AdapterStatus })));
  const extra: GraphValidation = validationOf();
  extra.unexpected = [{ sourceGuid: "guid-A", sourceName: "A", destinationGuid: "guid-Z", destinationName: "Z", triggerType: "tap" }];
  const result = await runPrototypeGraphBatch(executor, EDGES, { validate: () => extra });

  assert.equal(result.status, "partial_success");
  assert.equal(result.validation?.unexpected.length, 1);
});

test("validation can be skipped and says why", async () => {
  const executor = new ScriptedExecutor([{ status: "success" }]);
  const result = await runPrototypeGraphBatch(executor, EDGES.slice(0, 1), {});
  assert.equal(result.status, "success");
  assert.equal(result.validation, null);
  assert.match(result.validationSkippedReason ?? "", /validation port not provided/);
});

test("an executor that throws becomes a failed edge, not a crashed batch", async () => {
  const executor = {
    createInteraction: async () => { throw new Error("exploded"); },
  };
  const result = await runPrototypeGraphBatch(executor, EDGES.slice(0, 1), { validate: () => validationOf() });
  assert.equal(result.edges[0].status, "failed");
  assert.match(result.edges[0].evidence.note ?? "", /exploded/);
  assert.equal(result.status, "failed");
});

// --- scoped extra detection ---------------------------------------------------

const OBSERVED: DetectedEdge[] = [
  { sourceGuid: "guid-A", sourceName: "A", triggerType: "tap", actionType: "goToArtboard", destinationGuid: "guid-B", destinationName: "B", transitionType: "dissolve", duration: 0.3 },
  { sourceGuid: "guid-B", sourceName: "B", triggerType: "tap", actionType: "goToArtboard", destinationGuid: "guid-C", destinationName: "C", transitionType: "dissolve", duration: 0.3 },
  { sourceGuid: "guid-C", sourceName: "C", triggerType: "tap", actionType: "goToArtboard", destinationGuid: "guid-D", destinationName: "D", transitionType: "dissolve", duration: 0.3 },
];

test("extra detection is scoped: source extras vs target-only context", () => {
  const requirements: GraphRequirement[] = [
    { fromGuid: "guid-A", toGuid: "guid-B", trigger: "tap", action: "goToArtboard" },
    { fromGuid: "guid-B", toGuid: "guid-C", trigger: "tap", action: "goToArtboard" },
  ];
  // C→D is not requested. C is only a target here, so it is context, not a graph error.
  assert.deepEqual(findUnexpectedEdges(OBSERVED, requirements), []);
  const targetExtras = findTargetOnlyExtras(OBSERVED, requirements);
  assert.equal(targetExtras.length, 1);
  assert.equal(targetExtras[0].sourceName, "C");

  // If C is also a requested source, C→D becomes a genuine extra.
  const withC: GraphRequirement[] = requirements.concat([{ fromGuid: "guid-C", toGuid: "guid-A", trigger: "tap", action: "goToArtboard" }]);
  const extras = findUnexpectedEdges(OBSERVED, withC);
  assert.equal(extras.length, 1);
  assert.equal(extras[0].destinationName, "D");
});

// --- MCP surface --------------------------------------------------------------

test("MCP exposes xd_create_prototype_graph and rejects invalid input before running automation", async (t) => {
  const { McpClient } = await import("./helpers.ts");
  const c = new McpClient(27281, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const list = await c.request("tools/list");
  const tools = (list.result as { tools: Array<{ name: string; description: string; inputSchema: Record<string, any> }> }).tools;
  const graph = tools.find((x) => x.name === "xd_create_prototype_graph");
  assert.ok(graph, "missing xd_create_prototype_graph");
  assert.match(graph!.description, /strictly serially/i);
  assert.match(graph!.description, /never duplicated/i);
  assert.equal(graph!.inputSchema.properties.failurePolicy.enum.includes("fail_fast"), true);

  const empty = await c.callTool("xd_create_prototype_graph", { edges: [] });
  assert.equal((empty.result as { isError?: boolean }).isError, true);
  assert.equal(JSON.parse((empty.result as { content: Array<{ text: string }> }).content[0].text).code, "invalid_params");

  const nothing = await c.callTool("xd_create_prototype_graph", {});
  assert.equal(JSON.parse((nothing.result as { content: Array<{ text: string }> }).content[0].text).code, "invalid_params");

  const badTrigger = await c.callTool("xd_create_prototype_graph", { edges: [{ source: "A", target: "B", trigger: "hover" }] });
  assert.match(JSON.parse((badTrigger.result as { content: Array<{ text: string }> }).content[0].text).error, /trigger must be one of/);
});

test("fail_fast also stops on a conflict (an unsatisfiable edge)", async () => {
  const executor = new ScriptedExecutor([
    { status: "success" },
    { status: "conflict" },
    { status: "success" },
  ]);
  const result = await runPrototypeGraphBatch(executor, EDGES.slice(0, 3), {
    failurePolicy: "fail_fast",
    validate: () => validationOf(),
  });

  assert.equal(result.aborted, true);
  assert.equal(executor.calls.length, 2, "the edge after the conflict was never started");
  assert.deepEqual(result.edges.map((e) => e.status), ["created", "conflict", "skipped"]);
  assert.deepEqual(result.summary, { created: 1, already_exists: 0, repaired: 0, deleted: 0, conflicts: 1, failed: 0, skipped: 1 });
});

test("timing is reported per edge and in aggregate, with a serial invariant", async () => {
  const executor = new ScriptedExecutor(EDGES.map(() => ({ status: "success" as AdapterStatus })), 3);
  const result = await runPrototypeGraphBatch(executor, EDGES, { validate: () => validationOf() });

  assert.equal(result.timing.measuredEdges, 4);
  assert.equal(result.timing.maxConcurrentEdges, 1, "serial invariant");
  assert.ok(result.timing.totalDurationMs >= result.timing.averageEdgeDurationMs!);
  assert.ok(result.timing.minEdgeDurationMs! <= result.timing.maxEdgeDurationMs!);
  for (const e of result.edges) assert.equal(typeof e.durationMs, "number");
  assert.equal(result.edges.filter((e) => e.status === "skipped").length, 0);
});

test("timing ignores skipped edges", async () => {
  const executor = new ScriptedExecutor([{ status: "success" }, { status: "failed" }]);
  const result = await runPrototypeGraphBatch(executor, EDGES, { failurePolicy: "fail_fast", validate: () => validationOf() });
  assert.equal(result.timing.measuredEdges, 2);
  assert.equal(result.summary.skipped, 2);
});

test("normalise honours the planner's transition object verbatim", () => {
  const planned = normalizeBatchEdges([{
    source: "A",
    target: "B",
    sourceNode: { guid: "g-a", name: "A", type: "Artboard" },
    targetArtboard: { guid: "g-b", name: "B", type: "Artboard" },
    trigger: "tap",
    action: "goToArtboard",
    transition: { type: "slide", duration: 0.5 },
    ready: true,
    index: 0,
  }]);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.edges[0].transition, "slide");
  assert.equal(planned.edges[0].duration, 0.5);

  const coerced = normalizeBatchEdges([{ source: "A", target: "B", transition: "wipe_up" }]);
  assert.equal(coerced.ok, true);
  if (!coerced.ok) return;
  assert.equal(coerced.edges[0].transition, "wipe_up");
  assert.equal(coerced.edges[0].duration, 0.3);
});


// --- stage 5: multi-edge sources, repair, deletion ---------------------------

const SAMPLE_WIRE: DetectedEdge = {
  sourceGuid: "guid-A",
  sourceName: "A",
  triggerType: "tap",
  actionType: "goToArtboard",
  destinationGuid: "guid-elsewhere",
  destinationName: "Booking",
  transitionType: "dissolve",
  duration: 0.3,
};

test("many edges from one source are all executed and receive the full wanted-target set", async () => {
  const many = normalizeBatchEdges(Array.from({ length: 17 }, (_, i) => ({ source: "Home", target: `T${i + 1}` })));
  assert.equal(many.ok, true);
  if (!many.ok) return;

  const seen: Array<{ mode: string; wantedTargets: string[] }> = [];
  const executor = {
    createInteraction: async (req: Record<string, unknown>, opts?: { mode: string; wantedTargets: string[] }) => {
      seen.push(opts ?? { mode: "?", wantedTargets: [] });
      return outcome("success", String(req.source), String(req.target));
    },
  };

  const result = await runPrototypeGraphBatch(executor, many.edges, { validate: () => validationOf({ expectedCount: 17 }) });
  assert.equal(result.summary.created, 17);
  assert.equal(result.summary.conflicts, 0);
  assert.equal(seen.length, 17);
  for (const call of seen) {
    assert.equal(call.mode, "create");
    assert.equal(call.wantedTargets.length, 17, "every call sees all 17 desired targets for that source");
    assert.ok(call.wantedTargets.includes("T17"));
  }
});

test("mode is forwarded to the executor (repair / reconcile)", async () => {
  const modes: string[] = [];
  const executor = {
    createInteraction: async (req: Record<string, unknown>, opts?: { mode: string }) => {
      modes.push(opts!.mode);
      return outcome("success", String(req.source), String(req.target));
    },
  };
  await runPrototypeGraphBatch(executor, EDGES.slice(0, 2), { mode: "repair", validate: () => validationOf() });
  await runPrototypeGraphBatch(executor, EDGES.slice(0, 2), { mode: "reconcile", validate: () => validationOf() });
  await runPrototypeGraphBatch(executor, EDGES.slice(0, 2), { validate: () => validationOf() });
  assert.deepEqual(modes, ["repair", "repair", "reconcile", "reconcile", "create", "create"]);
});

test("a repaired edge reports the deleted wire and counts as repaired, not created", async () => {
  const stale: DetectedEdge = SAMPLE_WIRE;
  const executor = {
    createInteraction: async (req: Record<string, unknown>) => ({
      ...outcome("repaired", String(req.source), String(req.target)),
      repair: { deleted: [stale], deletionVerified: true },
    }),
  };
  const result = await runPrototypeGraphBatch(executor, EDGES.slice(0, 1), { mode: "repair", validate: () => validationOf({ expectedCount: 1 }) });

  assert.equal(result.status, "success");
  assert.deepEqual(result.summary, { created: 0, already_exists: 0, repaired: 1, deleted: 1, conflicts: 0, failed: 0, skipped: 0 });
  assert.equal(result.edges[0].status, "repaired");
  assert.equal(result.edges[0].created, false, "repaired is not created");
  assert.equal(result.edges[0].verified, true);
  assert.equal(result.edges[0].evidence.deleted?.[0].targetName, "Booking");
  assert.equal(result.edges[0].evidence.deletionVerified, true);
});

test("a repair that fails after deleting is reported honestly", async () => {
  const failed = outcome("failed", "A", "B");
  failed.failure = {
    code: "REPAIR_FAILED",
    stage: "configure_target",
    message: "delete succeeded, create failed",
    xdModified: true,
    recoverable: true,
    hint: "manual follow-up required",
  };
  failed.repair = { deleted: [{ ...SAMPLE_WIRE, destinationName: "Old" }], deletionVerified: true };
  const executor = { createInteraction: async () => failed };

  const result = await runPrototypeGraphBatch(executor, EDGES.slice(0, 1), { mode: "repair", validate: () => validationOf() });
  // nothing achieved by this batch -> failed, never success
  assert.equal(result.status, "failed");
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.deleted, 0, "deleted counts only verified repairs");
  assert.equal(result.edges[0].evidence.failureCode, "REPAIR_FAILED");
  assert.equal(result.edges[0].verified, false);
});




// --- stage 5: canonical identity ---------------------------------------------

test("identity matching is canonical across case, float noise and planner shapes", async () => {
  const { edgeSatisfies, identityKey, identityOfEdge, triggerSlot } = await import("../bridge/src/automation/protocol.ts");
  const edge = {
    sourceGuid: "src",
    sourceName: "S",
    triggerType: "tap",
    actionType: "goToArtboard",
    destinationGuid: "dst",
    destinationName: "T",
    transitionType: "dissolve",
    duration: 0.30000001192092896,
  };
  const desired = { sourceGuid: "src", trigger: "tap", action: "goToArtboard", targetGuid: "dst", transition: "dissolve", duration: 0.3 };
  assert.equal(edgeSatisfies(edge, desired), true);
  assert.equal(identityKey(identityOfEdge(edge)), identityKey(desired));
  assert.equal(triggerSlot("src", "tap", "goToArtboard"), triggerSlot("src", "TAP", "gotoartboard"));

  assert.equal(edgeSatisfies({ ...edge, transitionType: "slide" }, desired), false);
  assert.equal(edgeSatisfies({ ...edge, duration: 0.5 }, desired), false);
  assert.equal(edgeSatisfies({ ...edge, destinationGuid: "other" }, desired), false);
  assert.equal(edgeSatisfies({ ...edge, triggerType: "drag" }, desired), false);
});
