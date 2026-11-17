/**
 * Prototype authoring through Windows UI Automation - unit + adapter tests.
 *
 * Layering (so nothing is faked across a boundary that matters):
 *   1. protocol.ts  - pure: validation, XD label mapping, read-back
 *                     classification, failure mapping.
 *   2. geometry.ts  - pure: document→screen mapping for the coordinate fallback.
 *   3. adapter.ts   - orchestration against a scripted runner + scripted UXP
 *                     ports. Proves control flow, stage attribution, retry and
 *                     idempotency; does NOT prove that Adobe XD obeys the UI
 *                     automation.
 *
 * The only proof that XD obeys it is the live acceptance run recorded in
 * automation/PrototypeAutomation/evidence/ plus the UXP read-back that follows
 * it. No test here claims a wire exists in a real document.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWire,
  expectedUi,
  formatDurationLabel,
  parseDurationLabel,
  toFailureCode,
  transitionLabel,
  validateInteractionRequest,
  type DetectedEdge,
} from "../bridge/src/automation/protocol.ts";
import { documentToScreen, frameCenterInDocument } from "../bridge/src/automation/geometry.ts";
import {
  PrototypeAutomationAdapter,
  type AuthoringPorts,
  type ResolvedNode,
  type ResolveResult,
} from "../bridge/src/automation/adapter.ts";
import type { AutomationRunner, WorkerResult } from "../bridge/src/automation/worker.ts";
import { McpClient } from "./helpers.ts";

// --- 1. request validation ---------------------------------------------------

test("interaction request applies XD defaults", () => {
  const v = validateInteractionRequest({ source: "PrototypeTest/Source", target: "PrototypeTest/Target" });
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(v.request, {
    source: "PrototypeTest/Source",
    target: "PrototypeTest/Target",
    trigger: "tap",
    action: "goToArtboard",
    transition: "dissolve",
    duration: 0.3,
    mode: "prototype",
  });
});

test("interaction request rejects structurally invalid input", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /must be an object/],
    [{ target: "T" }, /source must be a string/],
    [{ source: "  ", target: "T" }, /non-empty/],
    [{ source: "S", target: "T", trigger: "hover" }, /trigger must be one of/],
    [{ source: "S", target: "T", action: "scrollTo" }, /action must be one of/],
    [{ source: "S", target: "T", duration: -1 }, /between 0 and 10/],
    [{ source: "S", target: "T", duration: 11 }, /between 0 and 10/],
    [{ source: "S", target: "T", transition: "" }, /non-empty/],
    [{ source: "S", target: "T", mode: "share" }, /mode must be one of/],
  ];
  for (const [input, expected] of cases) {
    const v = validateInteractionRequest(input);
    assert.equal(v.ok, false, `should reject ${JSON.stringify(input)}`);
    if (v.ok) continue;
    assert.match(v.error, expected);
  }
});

test("XD labels match the controls the live probe discovered", () => {
  const v = validateInteractionRequest({
    source: "PrototypeTest/Source",
    target: "PrototypeTest/Target",
    trigger: "tap",
    action: "goToArtboard",
    transition: "dissolve",
    duration: 0.3,
  });
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(expectedUi(v.request, "PrototypeTest/Target"), {
    trigger: "Tap",
    action: "Transition",
    destination: "PrototypeTest/Target",
    transition: "Dissolve",
    duration: "0.3 s",
  });
});

test("transition labels title-case unknown names instead of inventing options", () => {
  assert.equal(transitionLabel("dissolve"), "Dissolve");
  assert.equal(transitionLabel("none"), "None");
  assert.equal(transitionLabel("slide-left"), "Slide Left");
  assert.equal(transitionLabel("wipe_up"), "Wipe Up");
});

test("duration labels use XD's one-decimal format and parse back", () => {
  assert.equal(formatDurationLabel(0.3), "0.3 s");
  assert.equal(formatDurationLabel(1), "1.0 s");
  assert.equal(parseDurationLabel("0.3 s"), 0.3);
  assert.equal(parseDurationLabel("0,3 s"), 0.3);
  assert.equal(parseDurationLabel("n/a"), null);
});

// --- 2. read-back classification --------------------------------------------

const EDGE: DetectedEdge = {
  sourceGuid: "src",
  sourceName: "PrototypeTest/Source",
  triggerType: "tap",
  actionType: "goToArtboard",
  destinationGuid: "dst",
  destinationName: "PrototypeTest/Target",
  transitionType: "dissolve",
  duration: 0.3,
};
const REQ = {
  sourceGuid: "src",
  targetGuid: "dst",
  trigger: "tap" as const,
  action: "goToArtboard" as const,
  transition: "dissolve",
  duration: 0.3,
};

test("classification: exact match verifies", () => {
  const r = classifyWire([EDGE], REQ);
  assert.equal(r.verdict, "ok");
  assert.equal(r.verified, true);
  assert.equal(r.match?.destinationGuid, "dst");
});

test("classification: missing, wrong destination, wrong trigger/action/transition/duration", () => {
  assert.equal(classifyWire([], REQ).verdict, "missing");
  assert.equal(classifyWire([{ ...EDGE, destinationGuid: "other" }], REQ).verdict, "wrong-destination");
  assert.equal(classifyWire([{ ...EDGE, triggerType: "drag" }], REQ).verdict, "wrong-trigger");
  assert.equal(classifyWire([{ ...EDGE, actionType: "overlay" }], REQ).verdict, "wrong-action");
  assert.equal(classifyWire([{ ...EDGE, transitionType: "slide" }], REQ).verdict, "wrong-transition");
  assert.equal(classifyWire([{ ...EDGE, duration: 0.5 }], REQ).verdict, "wrong-duration");
  assert.equal(classifyWire([{ ...EDGE, duration: 0.30000001 }], REQ).verified, true, "float noise must not fail");
  assert.equal(classifyWire([{ ...EDGE, triggerType: null }], REQ).verdict, "incomplete");
  assert.equal(classifyWire([EDGE, { ...EDGE }], REQ).verdict, "ambiguous");
});

test("failure codes map worker errors onto the public vocabulary", () => {
  assert.equal(toFailureCode("XD_WINDOW_NOT_FOUND"), "XD_NOT_FOUND");
  assert.equal(toFailureCode("option_not_found", "destination"), "TARGET_CONNECTION_FAILED");
  assert.equal(toFailureCode("option_not_found", "transition"), "INTERACTION_CONFIGURATION_FAILED");
  assert.equal(toFailureCode("ambiguous"), "SOURCE_AMBIGUOUS");
  assert.equal(toFailureCode("unsupported_control"), "UNSUPPORTED_XD_UI");
  assert.equal(toFailureCode("AUTOMATION_TIMEOUT"), "AUTOMATION_TIMEOUT");
  assert.equal(toFailureCode("something_else"), "UNSUPPORTED_XD_UI");
});

// --- 3. geometry fallback ----------------------------------------------------

test("document→screen mapping uses the live viewport, not fixed pixels", () => {
  const canvas = { x: 614, y: 152, width: 936, height: 816 };
  const at100 = documentToScreen({ x: 100, y: 200 }, { bounds: { x: 0, y: 0, width: 936, height: 816 }, zoomFactor: 1 }, canvas);
  assert.equal(at100.ok, true);
  if (!at100.ok) return;
  assert.equal(at100.x, 714);
  assert.equal(at100.y, 352);
  assert.equal(at100.insideCanvas, true);

  const panned = documentToScreen({ x: 100, y: 200 }, { bounds: { x: 50, y: 100, width: 936, height: 816 }, zoomFactor: 0.5 }, canvas);
  assert.equal(panned.ok, true);
  if (!panned.ok) return;
  assert.equal(panned.x, 639);
  assert.equal(panned.y, 202);

  const outside = documentToScreen({ x: 100000, y: 100000 }, { bounds: { x: 0, y: 0, width: 936, height: 816 }, zoomFactor: 1 }, canvas);
  assert.equal(outside.ok, true);
  if (!outside.ok) return;
  assert.equal(outside.insideCanvas, false);
});

test("document→screen refuses to answer without a trustworthy viewport", () => {
  const canvas = { x: 0, y: 0, width: 100, height: 100 };
  for (const viewport of [null, { bounds: { x: 0, y: 0, width: 0, height: 0 }, zoomFactor: 1 }, { bounds: { x: 0, y: 0, width: 10, height: 10 }, zoomFactor: 0 }]) {
    const r = documentToScreen({ x: 1, y: 1 }, viewport as never, canvas);
    assert.equal(r.ok, false);
    if (r.ok) continue;
    assert.match(r.reason, /VIEWPORT_STATE_UNKNOWN/);
  }
  const noCanvas = documentToScreen({ x: 1, y: 1 }, { bounds: { x: 0, y: 0, width: 10, height: 10 }, zoomFactor: 1 }, null);
  assert.equal(noCanvas.ok, false);
});

test("artboard frame centre maps into document space", () => {
  assert.deepEqual(frameCenterInDocument({ x: 0, y: 13000 }, { x: 0, y: 0, width: 320, height: 480 }), { x: 160, y: 13240 });
});

// --- 4. adapter orchestration ------------------------------------------------

const SOURCE: ResolvedNode = { guid: "src-guid", name: "PrototypeTest/Source", type: "Artboard" };
const TARGET: ResolvedNode = { guid: "dst-guid", name: "PrototypeTest/Target", type: "Artboard" };
const NODE_OK: ResolveResult = { node: SOURCE, reason: "ok", candidates: [{ guid: SOURCE.guid, name: SOURCE.name }] };
const BOARD_OK: ResolveResult = { node: TARGET, reason: "ok", candidates: [{ guid: TARGET.guid, name: TARGET.name }] };

class ScriptedRunner implements AutomationRunner {
  calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  private script: Record<string, (args: Record<string, unknown>) => WorkerResult>;

  constructor(script: Record<string, (args: Record<string, unknown>) => WorkerResult>) {
    this.script = script;
  }

  async run(cmd: string, args: Record<string, unknown> = {}): Promise<WorkerResult> {
    this.calls.push({ cmd, args });
    const h = this.script[cmd];
    if (!h) return { ok: true, cmd, result: {} };
    return h(args);
  }

  count(cmd: string): number {
    return this.calls.filter((c) => c.cmd === cmd).length;
  }
}

function makePorts(opts: {
  runner: AutomationRunner;
  edges?: DetectedEdge[][];
  selection?: ResolvedNode[];
  source?: ResolveResult;
  target?: ResolveResult;
}): AuthoringPorts {
  const edgeSequence = opts.edges ?? [[]];
  let read = 0;
  return {
    resolveSource: async () => opts.source ?? NODE_OK,
    resolveTarget: async () => opts.target ?? BOARD_OK,
    readSelection: async () => opts.selection ?? [SOURCE],
    readEdges: async () => {
      const value = edgeSequence[Math.min(read, edgeSequence.length - 1)];
      read++;
      return value;
    },
    runner: opts.runner,
  };
}

const OK_SCRIPT: Record<string, (args: Record<string, unknown>) => WorkerResult> = {
  focus_xd: () => ({ ok: true, cmd: "focus_xd", result: { focused: true } }),
  ensure_mode: () => ({ ok: true, cmd: "ensure_mode", result: { verified: true } }),
  select_node: () => ({ ok: true, cmd: "select_node", result: { uiaSelected: true, rowText: "PrototypeTest/Source" } }),
  add_interaction: () => ({ ok: true, cmd: "add_interaction", result: { added: true, editorVisible: true } }),
  set_field: (args) => ({ ok: true, cmd: "set_field", result: { field: args.field, after: String(args.value) } }),
  set_duration: () => ({ ok: true, cmd: "set_duration", result: { after: "0.3 s", seconds: 0.3 } }),
  read_interaction: () => ({
    ok: true,
    cmd: "read_interaction",
    result: { editorOpen: true, trigger: "Tap", action: "Transition", destination: "PrototypeTest/Target", transition: "Dissolve", duration: "0.3 s" },
  }),
};

const CREATED: DetectedEdge = {
  sourceGuid: "src-guid",
  sourceName: "PrototypeTest/Source",
  triggerType: "tap",
  actionType: "goToArtboard",
  destinationGuid: "dst-guid",
  destinationName: "PrototypeTest/Target",
  transitionType: "dissolve",
  duration: 0.3,
};

const REQUEST = {
  source: "PrototypeTest/Source",
  target: "PrototypeTest/Target",
  trigger: "tap" as const,
  action: "goToArtboard" as const,
  transition: "dissolve",
  duration: 0.3,
};

test("adapter drives the documented UI steps in order and verifies through UXP", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[], [CREATED]] }));

  const result = await adapter.createInteraction(REQUEST);

  assert.equal(result.status, "success");
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.verified, true);
  assert.equal(result.automationPath, "windows-ui-automation");
  assert.equal(result.verification?.verdict, "ok");
  assert.equal(result.failure, null);
  assert.equal(result.observedUi?.trigger, "Tap");
  assert.deepEqual(result.expectedUi, {
    trigger: "Tap",
    action: "Transition",
    destination: "PrototypeTest/Target",
    transition: "Dissolve",
    duration: "0.3 s",
  });

  assert.deepEqual(runner.calls.map((c) => c.cmd), [
    "focus_xd",
    "ensure_mode",
    "select_node",
    "add_interaction",
    "set_field",      // destination
    "set_field",      // trigger
    "set_field",      // action
    "set_field",      // transition
    "set_duration",
    "read_interaction",
  ]);
  assert.equal(runner.calls[1].args.mode, "prototype");
  assert.equal(runner.calls[2].args.name, "PrototypeTest/Source");
  assert.equal(runner.calls[4].args.field, "destination");
  assert.equal(runner.calls[4].args.value, "PrototypeTest/Target");
});

test("adapter retries the selection once and succeeds when XD adopts it", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);
  const ports = makePorts({ runner, edges: [[], [CREATED]], selection: [] });
  let selectionReads = 0;
  const original = ports.readSelection;
  ports.readSelection = async () => {
    selectionReads++;
    return selectionReads >= 2 ? [SOURCE] : [];
  };
  assert.equal(typeof original, "function");

  const result = await new PrototypeAutomationAdapter(ports).createInteraction(REQUEST);
  assert.equal(result.status, "success");
  assert.equal(runner.count("select_node"), 2, "one retry");
  assert.ok(result.stages.some((s) => s.stage === "select_source_retry_1"));
});

test("adapter stops when UXP never confirms the selection", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[], [CREATED]], selection: [] }));

  const result = await adapter.createInteraction(REQUEST);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "SOURCE_SELECTION_FAILED");
  assert.equal(result.failure?.stage, "confirm_selection");
  assert.equal(result.failure?.xdModified, false);
  assert.equal(runner.count("add_interaction"), 0, "no UI mutation after a failed selection");
});

test("adapter reports UNSUPPORTED_XD_UI when a required control is missing", async () => {
  const runner = new ScriptedRunner({
    ...OK_SCRIPT,
    add_interaction: () => ({ ok: false, cmd: "add_interaction", error: { code: "UNSUPPORTED_XD_UI", message: "no Add Interaction button", stage: "CONNECTOR_CREATION_FAILED" } }),
  });
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[], []] }));

  const result = await adapter.createInteraction(REQUEST);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "UNSUPPORTED_XD_UI");
  assert.equal(runner.count("add_interaction"), 2, "editor retried once, then reported");
});

test("adapter reports partial_success when the wire exists with wrong properties", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);
  const wrongDuration = { ...CREATED, duration: 0.5 };
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[], [wrongDuration]] }));

  const result = await adapter.createInteraction(REQUEST);
  assert.equal(result.status, "partial_success");
  assert.equal(result.created, true);
  assert.equal(result.verified, false);
  assert.equal(result.failure?.code, "VERIFICATION_FAILED");
  assert.equal(result.failure?.xdModified, true);
  assert.equal(result.verification?.verdict, "wrong-duration");
  assert.match(result.verification?.problems.join(" ") ?? "", /0\.5/);
});

test("adapter reports failed when no interaction exists after the UI run", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[], []] }));

  const result = await adapter.createInteraction(REQUEST);
  assert.equal(result.status, "failed");
  assert.equal(result.created, false);
  assert.equal(result.verification?.verdict, "missing");
});

test("adapter stops at XD_NOT_ACTIVE before touching the document", async () => {
  const runner = new ScriptedRunner({
    focus_xd: () => ({ ok: false, cmd: "focus_xd", error: { code: "XD_WINDOW_NOT_FOUND", message: "no window", stage: "focus_xd" } }),
  });
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[]] }));

  const result = await adapter.createInteraction(REQUEST);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "XD_NOT_ACTIVE");
  assert.equal(result.failure?.xdModified, false);
  assert.deepEqual(runner.calls.map((c) => c.cmd), ["focus_xd"]);
});

test("adapter reports PROTOTYPE_MODE_FAILED when the workspace cannot be switched", async () => {
  const runner = new ScriptedRunner({
    ...OK_SCRIPT,
    ensure_mode: () => ({ ok: false, cmd: "ensure_mode", error: { code: "PROTOTYPE_MODE_FAILED", message: "toggle did not engage", stage: "PROTOTYPE_MODE_FAILED" } }),
  });
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[]] }));

  const result = await adapter.createInteraction(REQUEST);
  assert.equal(result.failure?.code, "PROTOTYPE_MODE_FAILED");
  assert.equal(runner.count("select_node"), 0);
});

test("adapter reports a missing destination option as TARGET_CONNECTION_FAILED", async () => {
  const runner = new ScriptedRunner({
    ...OK_SCRIPT,
    set_field: (args) =>
      args.field === "destination"
        ? { ok: false, cmd: "set_field", error: { code: "option_not_found", message: "'Nope' is not an option. Realised options: PrototypeTest/Target", stage: "INTERACTION_CONFIGURATION_FAILED" } }
        : { ok: true, cmd: "set_field", result: { field: args.field, after: String(args.value) } },
  });
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[], []] }));

  const result = await adapter.createInteraction(REQUEST);
  assert.equal(result.failure?.code, "TARGET_CONNECTION_FAILED");
  assert.equal(result.failure?.stage, "configure_target");
  assert.match(result.failure?.message ?? "", /Realised options/);
});

test("adapter reuses an existing identical interaction instead of duplicating it", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[CREATED]] }));

  const result = await adapter.createInteraction(REQUEST);
  assert.equal(result.status, "already_exists");
  assert.equal(result.verified, true);
  assert.equal(result.created, false);
  assert.equal(runner.calls.length, 0, "no UI interaction when the document already matches");
});

test("adapter returns conflict for a differently wired source and never edits it", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);
  const other: DetectedEdge = { ...CREATED, destinationGuid: "elsewhere", destinationName: "Other" };
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[other]] }));

  const result = await adapter.createInteraction(REQUEST);
  assert.equal(result.status, "conflict");
  assert.equal(result.verified, false);
  assert.equal(result.failure?.recoverable, false);
  assert.equal(result.detected?.length, 1);
  assert.equal(result.detected?.[0].destinationName, "Other");
  assert.equal(runner.calls.length, 0);
});

test("adapter rejects invalid requests before resolving anything", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);
  let resolved = 0;
  const ports = makePorts({ runner, edges: [[]] });
  const original = ports.resolveSource;
  ports.resolveSource = async (input) => { resolved++; return original(input); };

  const result = await new PrototypeAutomationAdapter(ports).createInteraction({ source: "", target: "X" });
  assert.equal(result.failure?.code, "INVALID_REQUEST");
  assert.equal(resolved, 0);
});

test("adapter reports ambiguous and missing sources/targets without guessing", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);

  const ambiguousSource = await new PrototypeAutomationAdapter(makePorts({
    runner,
    source: { node: null, reason: "ambiguous", candidates: [{ guid: "a", name: "CTA/Primary/Label" }, { guid: "b", name: "CTA/Primary/Label" }] },
  })).createInteraction(REQUEST);
  assert.equal(ambiguousSource.failure?.code, "SOURCE_AMBIGUOUS");
  assert.match(ambiguousSource.failure?.message ?? "", /CTA\/Primary\/Label/);

  const missingSource = await new PrototypeAutomationAdapter(makePorts({
    runner,
    source: { node: null, reason: "not_found", candidates: [] },
  })).createInteraction(REQUEST);
  assert.equal(missingSource.failure?.code, "SOURCE_NOT_FOUND");

  const ambiguousTarget = await new PrototypeAutomationAdapter(makePorts({
    runner,
    target: { node: null, reason: "ambiguous", candidates: [{ guid: "c", name: "Dashboard" }, { guid: "d", name: "Dashboard" }] },
  })).createInteraction(REQUEST);
  assert.equal(ambiguousTarget.failure?.code, "TARGET_AMBIGUOUS");

  const missingTarget = await new PrototypeAutomationAdapter(makePorts({
    runner,
    target: { node: null, reason: "not_found", candidates: [] },
  })).createInteraction(REQUEST);
  assert.equal(missingTarget.failure?.code, "TARGET_NOT_FOUND");
  assert.equal(runner.calls.length, 0);
});

test("adapter exposes the requested helper API (connect / getState / configure* / disconnect)", async () => {
  const runner = new ScriptedRunner({
    ...OK_SCRIPT,
    get_state: (args) => ({
      ok: true,
      cmd: "get_state",
      result: { diagnostics: { xdWindowFound: true, sourceLayerFound: Boolean(args.name) }, modes: { prototype: "On" } },
    }),
  });
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner }));

  const connected = await adapter.connect("prototype");
  assert.equal(connected.stage.ok, true);

  const state = await adapter.getState("PrototypeTest/Source");
  assert.equal((state?.diagnostics as Record<string, unknown>).sourceLayerFound, true);

  assert.equal((await adapter.configureTrigger("Tap")).ok, true);
  assert.equal((await adapter.configureAction("Transition")).ok, true);
  assert.equal((await adapter.configureTarget("PrototypeTest/Target")).ok, true);
  assert.equal((await adapter.configureTransition("Dissolve")).ok, true);
  assert.equal((await adapter.configureDuration(0.3)).ok, true);
  assert.equal((await adapter.completeInteraction()).stage.ok, true);

  const restore = await adapter.disconnect();
  assert.ok(restore);
  assert.equal(restore?.ok, true);
  assert.equal(runner.calls.at(-1)?.args.mode, "design");
});

test("configureDuration rejects a field that did not take the requested value", async () => {
  const runner = new ScriptedRunner({
    ...OK_SCRIPT,
    set_duration: () => ({ ok: true, cmd: "set_duration", result: { after: "0.2 s", seconds: 0.2 } }),
  });
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner }));
  const stage = await adapter.configureDuration(0.3);
  assert.equal(stage.ok, false);
  assert.equal(stage.detail, "worker returned ok but the expected state was not observed");
});

// --- 5. production ports ------------------------------------------------------

test("ports normalise real UXP payload shapes and refuse to guess", async () => {
  const { createXdPorts } = await import("../bridge/src/automation/ports.ts");
  const boards = [
    { guid: "g-src", name: "PrototypeTest/Source", frame: { x: 0, y: 13000, width: 320, height: 480 } },
    { guid: "g-tgt", name: "PrototypeTest/Target", frame: { x: 520, y: 13000, width: 320, height: 480 } },
    { guid: "g-dup", name: "Dashboard", frame: { x: 0, y: 0, width: 10, height: 10 } },
    { guid: "g-dup2", name: "Dashboard", frame: { x: 20, y: 0, width: 10, height: 10 } },
  ];
  const link = {
    execute: async (op: string, params: Record<string, unknown>) => {
      switch (op) {
        case "get_artboards":
          return { ok: true, result: { artboards: boards } };
        case "get_selection":
          return { ok: true, result: { selection: [{ guid: "g-src", name: "PrototypeTest/Source", type: "Artboard" }] } };
        case "search_nodes":
          return params.query === "CTA/Primary/Label"
            ? { ok: true, result: { nodes: [{ guid: "n1", name: "CTA/Primary/Label", type: "Text" }, { guid: "n2", name: "CTA/Primary/Label", type: "Text" }] } }
            : { ok: true, result: { nodes: [{ guid: "n3", name: "Header/Title", type: "Text" }] } };
        case "inspect_node":
          return params.guid === "11111111-1111-1111-1111-111111111111"
            ? { ok: true, result: { guid: "11111111-1111-1111-1111-111111111111", name: "Header/Title", type: "Text" } }
            : { ok: false, error: "node_not_found" };
        case "get_prototype_state":
          return {
            ok: true,
            result: {
              interactions: [{
                triggerNode: { guid: "g-src", name: "PrototypeTest/Source", type: "Artboard" },
                interactions: [{
                  trigger: { type: "tap" },
                  action: {
                    type: "goToArtboard",
                    destination: { guid: "g-tgt", name: "PrototypeTest/Target", type: "Artboard" },
                    transition: { type: "dissolve", duration: 0.30000001192092896, easing: "linear" },
                  },
                }],
              }],
            },
          };
        default:
          return { ok: false, error: `unexpected op ${op}` };
      }
    },
  } as unknown as Parameters<typeof createXdPorts>[0];

  const ports = createXdPorts(link, { run: async () => ({ ok: true, cmd: "noop", result: {} }) });

  const src = await ports.resolveSource("PrototypeTest/Source");
  assert.equal(src.reason, "ok");
  assert.equal(src.node?.guid, "g-src");
  assert.equal(src.node?.type, "Artboard");

  const byGuid = await ports.resolveSource("11111111-1111-1111-1111-111111111111");
  assert.equal(byGuid.node?.type, "Text");

  const ambiguous = await ports.resolveSource("CTA/Primary/Label");
  assert.equal(ambiguous.reason, "ambiguous");
  assert.equal(ambiguous.node, null);
  assert.equal(ambiguous.candidates.length, 2);

  const missing = await ports.resolveSource("Nope");
  assert.equal(missing.reason, "not_found");

  assert.equal((await ports.resolveTarget("PrototypeTest/Target")).node?.guid, "g-tgt");
  assert.equal((await ports.resolveTarget("Dashboard")).reason, "ambiguous");

  const edges = await ports.readEdges();
  assert.deepEqual(edges[0], {
    sourceGuid: "g-src",
    sourceName: "PrototypeTest/Source",
    triggerType: "tap",
    actionType: "goToArtboard",
    destinationGuid: "g-tgt",
    destinationName: "PrototypeTest/Target",
    transitionType: "dissolve",
    duration: 0.30000001192092896,
  });

  const selection = await ports.readSelection();
  assert.deepEqual(selection.map((s) => s.guid), ["g-src"]);
});

test("classifyWire accepts the live XD float representation of 0.3s", async () => {
  // Real XD returns 0.30000001192092896 from the plugin.
  const live: DetectedEdge = { ...EDGE, duration: 0.30000001192092896 };
  assert.equal(classifyWire([live], REQ).verified, true);
});

// --- 6. MCP surface ----------------------------------------------------------

test("MCP exposes the automation tools and does not overstate the plugin API", async (t) => {
  const c = new McpClient(27261, { mock: true });
  t.after(() => c.kill());
  await c.initialize();

  const list = await c.request("tools/list");
  const tools = (list.result as { tools: Array<{ name: string; description: string }> }).tools;
  const names = tools.map((x) => x.name);
  assert.ok(names.includes("xd_create_prototype_interaction"));
  assert.ok(names.includes("xd_probe_xd_automation"));

  const create = tools.find((x) => x.name === "xd_create_prototype_interaction");
  assert.ok(create);
  assert.match(create.description, /verified:true ONLY when the document itself contains/i);

  const caps = payload(await c.callTool("xd_get_capabilities"));
  assert.equal(caps.prototypeAuthoring.pluginApi.startsWith("unsupported"), true);
  assert.match(caps.note, /read-only/i);
  assert.match(caps.note, /Windows UI Automation/i);
});

function payload(r: Record<string, unknown>): Record<string, any> {
  return JSON.parse((r.result as { content: Array<{ text: string }> }).content[0].text) as Record<string, any>;
}


test("the adapter refuses a grammar-unsupported combination before touching the UI", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[]] }));

  const keys = await adapter.createInteraction({ source: "PrototypeTest/Source", target: "PrototypeTest/Target", trigger: "keys" });
  assert.equal(keys.status, "failed");
  assert.equal(keys.failure?.stage, "platform_grammar");
  assert.match(keys.failure?.message ?? "", /Keys & Gamepad|cannot be authored/i);
  assert.equal(runner.calls.length, 0, "no UI command may run for an unsupported combination");

  const drag = await adapter.createInteraction({ source: "PrototypeTest/Source", target: "PrototypeTest/Target", trigger: "drag", transition: "dissolve" });
  assert.equal(drag.failure?.stage, "platform_grammar");
  assert.equal(runner.calls.length, 0);
});

test("drag + Auto-Animate skips the transition and duration steps", async () => {
  const created: DetectedEdge = {
    ...CREATED,
    triggerType: "drag",
    transitionType: "autoAnimate",
    duration: null,
  };
  const runner = new ScriptedRunner(OK_SCRIPT);
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[], [created]] }));

  const result = await adapter.createInteraction({
    source: "PrototypeTest/Source",
    target: "PrototypeTest/Target",
    trigger: "drag",
    transition: "autoAnimate",
  });

  const fields = runner.calls.filter((c) => c.cmd === "set_field").map((c) => c.args.field);
  assert.deepEqual(fields, ["destination", "trigger", "action"], "no transition field for Auto-Animate");
  assert.equal(runner.count("set_duration"), 0, "Auto-Animate has no duration");
  assert.equal(result.status, "success");
  assert.equal(result.verified, true);
});

// --- Auto-Animate identity + partial-mutation safety -------------------------

const AA_WIRE: DetectedEdge = {
  sourceGuid: "src-guid",
  sourceName: "PrototypeTest/Source",
  triggerType: "drag",
  actionType: "goToArtboard",
  destinationGuid: "dst-guid",
  destinationName: "PrototypeTest/Target",
  transitionType: "autoAnimate",
  duration: null,
};

test("identity: Auto-Animate matches regardless of a requested duration", async () => {
  const { edgeSatisfies } = await import("../bridge/src/automation/protocol.ts");
  const desired = (duration?: number) => ({
    sourceGuid: "src-guid", trigger: "drag", action: "goToArtboard",
    targetGuid: "dst-guid", transition: "autoAnimate", duration: duration as number,
  });
  assert.equal(edgeSatisfies(AA_WIRE, desired(undefined)), true, "omitted duration matches");
  assert.equal(edgeSatisfies(AA_WIRE, desired(0.3)), true, "default 0.3 matches");
  assert.equal(edgeSatisfies(AA_WIRE, desired(1.5)), true, "duration is semantically irrelevant");
});

test("identity: dissolve still compares duration", async () => {
  const { edgeSatisfies } = await import("../bridge/src/automation/protocol.ts");
  const wire: DetectedEdge = { ...AA_WIRE, transitionType: "dissolve", duration: 0.3 };
  const desired = (d: number) => ({
    sourceGuid: "src-guid", trigger: "drag", action: "goToArtboard",
    targetGuid: "dst-guid", transition: "dissolve", duration: d,
  });
  assert.equal(edgeSatisfies(wire, desired(0.3)), true);
  assert.equal(edgeSatisfies(wire, desired(0.5)), false, "a different duration is a different wire");
});

test("preflight classifies an existing Auto-Animate edge as already_exists", async () => {
  const { runPreflight } = await import("../bridge/src/automation/preflight.ts");
  const { normalizeBatchEdges } = await import("../bridge/src/automation/batch.ts");
  const { GRAMMAR_VERSION } = await import("../bridge/src/automation/grammar.ts");
  const n = normalizeBatchEdges([{ source: "PrototypeTest/Source", target: "PrototypeTest/Target", trigger: "drag", transition: "autoAnimate", duration: 0.3 }]);
  assert.equal(n.ok, true);
  if (!n.ok) return;
  const resolver = {
    resolveSource: async () => ({ node: { guid: "src-guid", name: "PrototypeTest/Source", type: "Artboard" }, reason: "ok" as const, candidates: [] }),
    resolveTarget: async () => ({ node: { guid: "dst-guid", name: "PrototypeTest/Target", type: "Artboard" }, reason: "ok" as const, candidates: [] }),
    readEdges: async () => [AA_WIRE],
  };
  const report = await runPreflight(resolver, n.edges, GRAMMAR_VERSION);
  assert.equal(report.edges[0].status, "already_exists");
  assert.equal(report.ok, true);
});

test("replay: an existing Auto-Animate edge never calls the mutation path", async () => {
  const runner = new ScriptedRunner(OK_SCRIPT);
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[AA_WIRE], [AA_WIRE]] }));

  const result = await adapter.createInteraction({
    source: "PrototypeTest/Source",
    target: "PrototypeTest/Target",
    trigger: "drag",
    transition: "autoAnimate",
    duration: 0.3,
  });

  assert.equal(result.status, "already_exists");
  assert.equal(result.created, false);
  assert.equal(result.verified, true);
  assert.deepEqual(runner.calls.map((c) => c.cmd), ["noop"].filter(() => false), "no UI command at all");
  assert.equal(runner.calls.length, 0, "create_connector/config* must not run");
});

test("replay: a same-slot wire that is not an exact match blocks before the UI", async () => {
  // The document holds Drag -> Target1, the request wants Drag -> Target2 with
  // the same trigger slot: XD cannot hold both, so this must stop at precheck.
  const other: DetectedEdge = { ...AA_WIRE, destinationGuid: "guid-other", destinationName: "Elsewhere" };
  const runner = new ScriptedRunner(OK_SCRIPT);
  const adapter = new PrototypeAutomationAdapter(makePorts({ runner, edges: [[other]] }));

  const result = await adapter.createInteraction({
    source: "PrototypeTest/Source",
    target: "PrototypeTest/Target",
    trigger: "drag",
    transition: "autoAnimate",
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.failure?.code, "CONNECTOR_CREATION_FAILED");
  assert.equal(result.failure?.stage, "precheck");
  assert.equal(runner.calls.length, 0, "no partial interaction can be created");
});
