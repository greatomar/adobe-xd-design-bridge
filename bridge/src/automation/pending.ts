/**
 * Apply-Pending orchestration.
 *
 * The panel queue lives inside the UXP webview; the bridge cannot read it over
 * the socket (the plugin's queued reply only carries `pending: queue.length` at
 * queue time). The only reliable live view is the panel's own UI, which is
 * exposed to Windows UI Automation through three stable AutomationIds:
 *
 *   execBtn    Button   "Apply" | "Apply N change(s)" | "Applying."  (disabled
 *                        when the queue is empty or a batch is running)
 *   queueInfo  Custom   "Idle - nothing queued" | "N change(s) waiting" |
 *                        "N change(s) ready - click anywhere in this panel to apply" |
 *                        "Applying."
 *   autoChk    CheckBox "Apply automatically"
 *
 * Execution completion is reported by the plugin as a `batchExecuted` event.
 * That event carries no batch id, so correlation is "the newest event newer than
 * the moment we clicked" - documented, not hidden.
 *
 * This module never treats a click as success: a click only means the control
 * was activated.
 */

export type PendingPhase =
  | "idle"
  | "pending"
  | "applying"
  | "completed"
  | "partial_success"
  | "failed"
  | "timeout"
  | "unknown";

export interface PanelSnapshot {
  panelFound: boolean;
  applyButton: {
    found: boolean;
    enabled?: boolean;
    name?: string;
    automationId?: string;
    offscreen?: boolean;
  } | null;
  queueInfo: string | null;
  autoApply: string | null;
  windowName?: string | null;
}

export interface ExecutionEvent {
  name: string;
  at: number;
  results: Array<{ op: string; ok: boolean; error?: string | null }>;
  error: string | null;
  batch: string[];
  /** number of operations the plugin reported in the event payload */
  resultCount: number;
}

export interface PendingStatus {
  status: PendingPhase;
  panelAvailable: boolean;
  /** parsed from queueInfo only - never from unrelated bridge counters */
  pendingCount: number | null;
  pendingSource: "queue-info" | "unknown";
  applyEnabled: boolean | null;
  applying: boolean;
  autoApply: string | null;
  lastEvent: { name: string; at: number; ageMs: number; resultCount: number } | null;
  notes: string[];
}

/** "N change(s) ..." → N, "Idle - nothing queued" → 0, "Applying." → null */
export function parsePendingCount(queueInfo: string | null): number | null {
  if (!queueInfo) return null;
  const text = queueInfo.trim();
  if (/^idle\b/i.test(text)) return 0;
  const m = text.match(/(\d+)\s+change/i);
  if (m) return Number(m[1]);
  return null;
}

export function isApplyingLabel(queueInfo: string | null): boolean {
  return typeof queueInfo === "string" && /applying/i.test(queueInfo);
}

export function classifyPanel(panel: PanelSnapshot, lastEvent: ExecutionEvent | null, now = Date.now()): PendingStatus {
  const notes: string[] = [];
  const apply = panel.applyButton;
  const pendingCount = parsePendingCount(panel.queueInfo);
  const applying = isApplyingLabel(panel.queueInfo) || (apply?.name ?? "").toLowerCase().includes("applying");
  const panelAvailable = Boolean(panel.panelFound && apply?.found);

  if (!panelAvailable) {
    notes.push("execBtn is not exposed: the DesignBridge panel is not realised (open the Plugins pane).");
  }
  if (panel.queueInfo && pendingCount === null && !applying) {
    notes.push(`queueInfo text not recognised: "${panel.queueInfo}"`);
  }
  if (panel.autoApply === "On") {
    notes.push("auto-apply is ON: the panel may execute pending operations on any interaction inside it.");
  }

  let status: PendingPhase = "unknown";
  if (!panelAvailable) status = "unknown";
  else if (applying) status = "applying";
  else if (pendingCount === 0) status = "idle";
  else if (pendingCount !== null && pendingCount > 0) status = "pending";
  else if (apply?.enabled === false) status = "idle";
  else status = "unknown";

  return {
    status,
    panelAvailable,
    pendingCount,
    pendingSource: pendingCount === null ? "unknown" : "queue-info",
    applyEnabled: apply?.enabled ?? null,
    applying,
    autoApply: panel.autoApply,
    lastEvent: lastEvent
      ? { name: lastEvent.name, at: lastEvent.at, ageMs: Math.max(0, now - lastEvent.at), resultCount: lastEvent.resultCount }
      : null,
    notes,
  };
}

export type ExecutionSummaryStatus = "completed" | "partial_success" | "failed" | "unknown";

export interface ExecutionSummary {
  status: ExecutionSummaryStatus;
  opCount: number;
  okCount: number;
  failedCount: number;
  failures: Array<{ op: string; error?: string | null }>;
  note: string | null;
}

/**
 * A `batchExecuted` payload with no results is NOT success: the plugin can emit
 * an empty array when the executor never ran. It is reported as `unknown`.
 */
export function summarizeExecution(event: ExecutionEvent | null): ExecutionSummary {
  if (!event) {
    return { status: "unknown", opCount: 0, okCount: 0, failedCount: 0, failures: [], note: "no execution event observed" };
  }
  if (!event.results || event.results.length === 0) {
    return { status: "unknown", opCount: 0, okCount: 0, failedCount: 0, failures: [], note: "batchExecuted reported no operation results; execution cannot be confirmed" };
  }
  const failures = event.results.filter((r) => !r.ok).map((r) => ({ op: r.op, error: r.error ?? null }));
  const okCount = event.results.length - failures.length;
  const status: ExecutionSummaryStatus = failures.length === 0 ? "completed" : failures.length === event.results.length ? "failed" : "partial_success";
  return { status, opCount: event.results.length, okCount, failedCount: failures.length, failures, note: event.error };
}

// --- orchestration ----------------------------------------------------------

export interface ApplyPorts {
  /** UIA: current panel state (worker `panel_state`). */
  readPanel(): Promise<PanelSnapshot>;
  /** UIA: click the Apply button (worker `click_apply`). */
  clickApply(): Promise<{ clicked: boolean; reason?: string; nameBefore?: string; queueInfoBefore?: string; executionStartedObserved?: boolean; observedStateChange?: unknown; detail?: string }>;
  /** Bridge: newest plugin execution event, or null. */
  readEvent(): ExecutionEvent | null;
  /** UXP: cheap document counters used for independent verification. */
  readDocument(): Promise<{ artboards: number; nodes: number }>;
}

export interface ApplyOptions {
  timeoutMs?: number;
  pollMs?: number;
  expect?: { artboards?: number; nodes?: number };
  /** injected clock for tests */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ApplyResult {
  status: PendingPhase;
  clicked: boolean;
  pendingBefore: number | null;
  pendingAfter: number | null;
  executionStarted: boolean;
  executionCompleted: boolean;
  executionResult: ExecutionSummary | null;
  verification: { artboards: number | null; nodes: number | null; expected: ApplyOptions["expect"] | null; ok: boolean | null };
  timeout: boolean;
  errors: string[];
  durationMs: number;
  detail: Record<string, unknown>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runApplyPending(ports: ApplyPorts, options: ApplyOptions = {}): Promise<ApplyResult> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 150;
  const started = now();
  const errors: string[] = [];
  const detail: Record<string, unknown> = {};

  const base = (): ApplyResult => ({
    status: "unknown",
    clicked: false,
    pendingBefore: null,
    pendingAfter: null,
    executionStarted: false,
    executionCompleted: false,
    executionResult: null,
    verification: { artboards: null, nodes: null, expected: options.expect ?? null, ok: null },
    timeout: false,
    errors,
    durationMs: now() - started,
    detail,
  });

  const before = await ports.readPanel().catch((e) => {
    errors.push(`panel read failed: ${String(e)}`);
    return null;
  });
  if (!before) {
    const r = base();
    r.status = "unknown";
    return r;
  }
  const statusBefore = classifyPanel(before, ports.readEvent(), now());
  detail.panelBefore = before;
  detail.statusBefore = statusBefore;

  const r = base();
  r.pendingBefore = statusBefore.pendingCount;

  if (!statusBefore.panelAvailable) {
    r.status = "unknown";
    errors.push("Apply Pending is not available: the DesignBridge panel is not realised (execBtn missing).");
    return r;
  }
  if (statusBefore.applying) {
    r.status = "applying";
    errors.push("a batch is already executing; refusing to click again");
    return r;
  }
  if (statusBefore.pendingCount === 0 || (statusBefore.pendingCount === null && statusBefore.applyEnabled === false)) {
    r.status = "idle";
    errors.push("no pending operations: the Apply button is disabled and the panel reports an idle queue");
    return r;
  }
  if (statusBefore.applyEnabled === false) {
    r.status = statusBefore.status;
    errors.push("Apply button is disabled although the panel does not report an idle queue");
    return r;
  }

  // Snapshot the event cursor so a stale event is never attributed to this click.
  const eventBeforeAt = ports.readEvent()?.at ?? 0;
  const docBefore = await ports.readDocument().catch(() => null);

  const click = await ports.clickApply().catch((e) => {
    errors.push(`click failed: ${String(e)}`);
    return { clicked: false, detail: String(e) };
  });
  r.clicked = click.clicked === true;
  detail.click = click;
  if (!r.clicked) {
    r.status = "unknown";
    errors.push(`Apply button not activated: ${click.reason ?? click.detail ?? "unknown reason"}`);
    return r;
  }

  // Wait for a NEW execution event. A click alone is never success.
  const deadline = started + timeoutMs;
  let event: ExecutionEvent | null = null;
  while (now() < deadline) {
    const candidate = ports.readEvent();
    if (candidate && candidate.at > eventBeforeAt) {
      event = candidate;
      break;
    }
    await sleep(pollMs);
  }

  r.executionStarted = Boolean(click.executionStartedObserved) || Boolean(event);
  if (!event) {
    r.timeout = true;
    r.status = "timeout";
    errors.push(`no batchExecuted event within ${timeoutMs}ms after the click; the batch may still be running - the panel was NOT clicked again`);
  } else {
    const summary = summarizeExecution(event);
    r.executionResult = summary;
    r.executionCompleted = summary.status === "completed" || summary.status === "partial_success";
    r.status = summary.status;
    if (summary.status === "unknown") {
      errors.push("batchExecuted carried no operation results; execution is unconfirmed");
    }
  }

  const after = await ports.readPanel().catch(() => null);
  if (after) {
    const statusAfter = classifyPanel(after, event, now());
    detail.panelAfter = after;
    detail.statusAfter = statusAfter;
    r.pendingAfter = statusAfter.pendingCount;
    if (r.pendingAfter !== null && r.pendingAfter > 0) {
      errors.push(`${r.pendingAfter} operation(s) are still queued after the batch`);
    }
  } else {
    errors.push("could not re-read the panel after execution");
  }

  const docAfter = await ports.readDocument().catch(() => null);
  if (docBefore && docAfter) {
    detail.documentBefore = docBefore;
    detail.documentAfter = docAfter;
    const expected = options.expect;
    r.verification.artboards = docAfter.artboards;
    r.verification.nodes = docAfter.nodes;
    if (expected?.artboards !== undefined) {
      r.verification.ok = docAfter.artboards === expected.artboards;
      if (!r.verification.ok) errors.push(`document has ${docAfter.artboards} artboards, expected ${expected.artboards}`);
    } else {
      r.verification.ok = null;
    }
  }

  r.durationMs = now() - started;
  return r;
}
