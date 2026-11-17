/**
 * Apply-Pending state machine tests.
 *
 * Everything here is deterministic: the clock and the sleep function are
 * injected, so "delayed completion" and "timeout" are exercised without real
 * waiting. No Adobe XD process is involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPanel,
  parsePendingCount,
  runApplyPending,
  summarizeExecution,
  isApplyingLabel,
  type ApplyPorts,
  type ExecutionEvent,
  type PanelSnapshot,
} from "../bridge/src/automation/pending.ts";

const IDLE: PanelSnapshot = {
  panelFound: true,
  applyButton: { found: true, enabled: false, name: "Apply", automationId: "execBtn" },
  queueInfo: "Idle - nothing queued",
  autoApply: "On",
};
const PENDING4: PanelSnapshot = {
  panelFound: true,
  applyButton: { found: true, enabled: true, name: "Apply 4 change(s)", automationId: "execBtn" },
  queueInfo: "4 change(s) ready - click anywhere in this panel to apply",
  autoApply: "On",
};
const APPLYING: PanelSnapshot = {
  panelFound: true,
  applyButton: { found: true, enabled: false, name: "Applying.", automationId: "execBtn" },
  queueInfo: "Applying.",
  autoApply: "On",
};
const NO_PANEL: PanelSnapshot = { panelFound: false, applyButton: null, queueInfo: null, autoApply: null };

function event(okCount: number, failCount = 0, at = 1000): ExecutionEvent {
  const results = [
    ...Array.from({ length: okCount }, (_, i) => ({ op: `op${i}`, ok: true, error: null })),
    ...Array.from({ length: failCount }, (_, i) => ({ op: `bad${i}`, ok: false, error: "boom" })),
  ];
  return { name: "batchExecuted", at, results, error: null, batch: ["execute_batch"], resultCount: results.length };
}

/** Deterministic clock + scriptable ports. Events appear at a simulated time. */
function harness(opts: {
  panels: PanelSnapshot[];
  timeline?: Array<{ at: number; event: ExecutionEvent }>;
  click?: { clicked: boolean; reason?: string; executionStartedObserved?: boolean };
  docs?: Array<{ artboards: number; nodes: number }>;
  throwOnPanel?: boolean;
}) {
  let now = 0;
  const calls = { click: 0, panel: 0 };
  let panelIndex = 0;
  let docIndex = 0;
  const ports: ApplyPorts = {
    async readPanel() {
      if (opts.throwOnPanel) throw new Error("worker unavailable");
      calls.panel++;
      const p = opts.panels[Math.min(panelIndex, opts.panels.length - 1)];
      panelIndex++;
      return p;
    },
    async clickApply() {
      calls.click++;
      return opts.click ?? { clicked: true, executionStartedObserved: true };
    },
    readEvent() {
      const timeline = opts.timeline ?? [];
      const visible = timeline.filter((t) => t.at <= now);
      return visible.length ? visible[visible.length - 1].event : null;
    },
    async readDocument() {
      const d = opts.docs?.[Math.min(docIndex, (opts.docs?.length ?? 1) - 1)] ?? { artboards: 0, nodes: 0 };
      docIndex++;
      return d;
    },
  };
  return {
    ports,
    calls,
    deps: { now: () => now, sleep: async (ms: number) => { now += ms; } },
  };
}

// --- parsing / classification ------------------------------------------------

test("parsePendingCount reads the panel's own strings", () => {
  assert.equal(parsePendingCount("Idle - nothing queued"), 0);
  assert.equal(parsePendingCount("4 change(s) ready - click anywhere in this panel to apply"), 4);
  assert.equal(parsePendingCount("1 change(s) waiting"), 1);
  assert.equal(parsePendingCount("Applying."), null);
  assert.equal(parsePendingCount(null), null);
  assert.equal(isApplyingLabel("Applying."), true);
});

test("classifyPanel distinguishes idle / pending / applying / unavailable", () => {
  assert.equal(classifyPanel(IDLE, null).status, "idle");
  assert.equal(classifyPanel(PENDING4, null).status, "pending");
  assert.equal(classifyPanel(PENDING4, null).pendingCount, 4);
  assert.equal(classifyPanel(APPLYING, null).status, "applying");
  const missing = classifyPanel(NO_PANEL, null);
  assert.equal(missing.status, "unknown");
  assert.equal(missing.panelAvailable, false);
  assert.match(missing.notes.join(" "), /Plugins pane/);
});

test("classifyPanel never invents a queue depth", () => {
  const weird: PanelSnapshot = { ...PENDING4, queueInfo: "something new" };
  const s = classifyPanel(weird, null);
  assert.equal(s.pendingCount, null);
  assert.equal(s.pendingSource, "unknown");
  assert.match(s.notes.join(" "), /not recognised/);
});

test("summarizeExecution: empty results are unknown, never success", () => {
  const empty: ExecutionEvent = { name: "batchExecuted", at: 1, results: [], error: null, batch: [], resultCount: 0 };
  const s = summarizeExecution(empty);
  assert.equal(s.status, "unknown");
  assert.match(s.note ?? "", /no operation results/);
  assert.equal(summarizeExecution(null).status, "unknown");
});

test("summarizeExecution: completed / partial / failed", () => {
  assert.equal(summarizeExecution(event(3)).status, "completed");
  assert.equal(summarizeExecution(event(2, 1)).status, "partial_success");
  assert.equal(summarizeExecution(event(0, 2)).status, "failed");
});

// --- runApplyPending ---------------------------------------------------------

test("refuses when nothing is pending", async () => {
  const h = harness({ panels: [IDLE, IDLE] });
  const r = await runApplyPending(h.ports, h.deps);
  assert.equal(r.clicked, false);
  assert.equal(r.status, "idle");
  assert.equal(h.calls.click, 0, "no click on an empty queue");
  assert.match(r.errors[0], /no pending operations/);
});

test("refuses when the panel/button is not available", async () => {
  const h = harness({ panels: [NO_PANEL, NO_PANEL] });
  const r = await runApplyPending(h.ports, h.deps);
  assert.equal(r.clicked, false);
  assert.equal(r.status, "unknown");
  assert.equal(h.calls.click, 0);
  assert.match(r.errors[0], /not available|not realised/);
});

test("refuses when the button is disabled although the queue is not idle", async () => {
  const disabled: PanelSnapshot = { ...PENDING4, applyButton: { found: true, enabled: false, name: "Apply 4 change(s)" }, queueInfo: "4 change(s) waiting" };
  const h = harness({ panels: [disabled, disabled] });
  const r = await runApplyPending(h.ports, h.deps);
  assert.equal(r.clicked, false);
  assert.equal(h.calls.click, 0);
  assert.match(r.errors[0], /disabled/);
});

test("refuses to click while a batch is already executing (duplicate-click prevention)", async () => {
  const h = harness({ panels: [APPLYING, APPLYING] });
  const r = await runApplyPending(h.ports, h.deps);
  assert.equal(r.status, "applying");
  assert.equal(h.calls.click, 0, "never clicks a second time");
  assert.match(r.errors[0], /already executing/);
});

test("successful click and completion with independent document verification", async () => {
  const h = harness({
    panels: [PENDING4, IDLE],
    timeline: [{ at: 200, event: event(4, 0, 200) }],
    docs: [{ artboards: 7, nodes: 90 }, { artboards: 8, nodes: 100 }],
  });
  const r = await runApplyPending(h.ports, { ...h.deps, expect: { artboards: 8 } });
  assert.equal(r.clicked, true);
  assert.equal(r.status, "completed");
  assert.equal(r.pendingBefore, 4);
  assert.equal(r.pendingAfter, 0);
  assert.equal(r.executionStarted, true);
  assert.equal(r.executionCompleted, true);
  assert.equal(r.executionResult?.okCount, 4);
  assert.equal(r.verification.artboards, 8);
  assert.equal(r.verification.ok, true);
  assert.equal(h.calls.click, 1);
});

test("partial batch failure is reported as partial_success, not success", async () => {
  const h = harness({ panels: [PENDING4, IDLE], timeline: [{ at: 200, event: event(3, 1, 200) }] });
  const r = await runApplyPending(h.ports, h.deps);
  assert.equal(r.status, "partial_success");
  assert.equal(r.executionResult?.failedCount, 1);
  assert.equal(r.executionResult?.failures[0].op, "bad0");
});

test("a batchExecuted with no results leaves the outcome unknown", async () => {
  const empty: ExecutionEvent = { name: "batchExecuted", at: 500, results: [], error: null, batch: ["execute_batch"], resultCount: 0 };
  const h = harness({ panels: [PENDING4, IDLE], timeline: [{ at: 200, event: empty }] });
  const r = await runApplyPending(h.ports, h.deps);
  assert.equal(r.status, "unknown");
  assert.equal(r.executionCompleted, false);
  assert.match(r.errors.join(" "), /no operation results/);
});

test("delayed completion event is still captured", async () => {
  const h = harness({
    panels: [PENDING4, IDLE],
    timeline: [{ at: 700, event: event(4, 0, 700) }],
  });
  const r = await runApplyPending(h.ports, { ...h.deps, timeoutMs: 5000, pollMs: 100 });
  assert.equal(r.status, "completed");
  assert.equal(r.timeout, false);
  assert.equal(h.calls.click, 1);
});

test("timeout does not click again and reports uncertain", async () => {
  const h = harness({ panels: [PENDING4, APPLYING] });
  const r = await runApplyPending(h.ports, { ...h.deps, timeoutMs: 600, pollMs: 100 });
  assert.equal(r.clicked, true, "the click did happen");
  assert.equal(r.status, "timeout");
  assert.equal(r.timeout, true);
  assert.equal(h.calls.click, 1, "exactly one click, never a retry");
  assert.match(r.errors.join(" "), /NOT clicked again/);
});

test("UIA worker failure is surfaced, not swallowed", async () => {
  const h = harness({ panels: [PENDING4], throwOnPanel: true });
  const r = await runApplyPending(h.ports, h.deps);
  assert.equal(r.clicked, false);
  assert.equal(r.status, "unknown");
  assert.match(r.errors[0], /panel read failed/);
});

test("a click that did not activate the control is reported as such", async () => {
  const h = harness({ panels: [PENDING4, PENDING4], click: { clicked: false, reason: "invoke-failed" } });
  const r = await runApplyPending(h.ports, h.deps);
  assert.equal(r.clicked, false);
  assert.match(r.errors[0], /not activated/);
});

test("panel that cannot be re-read after execution is reported", async () => {
  let panelReads = 0;
  const h = harness({ panels: [PENDING4], timeline: [{ at: 200, event: event(4, 0, 200) }] });
  const ports: ApplyPorts = {
    ...h.ports,
    async readPanel() {
      panelReads++;
      if (panelReads > 1) throw new Error("panel disappeared (reload)");
      return PENDING4;
    },
  };
  const r = await runApplyPending(ports, h.deps);
  assert.equal(r.status, "completed");
  assert.equal(r.pendingAfter, null);
  assert.match(r.errors.join(" "), /could not re-read the panel/);
});

