/**
 * Batch prototype graph authoring.
 *
 * This module is orchestration only. It does not know how a wire is written
 * (that is PrototypeAutomationAdapter) and it does not decide whether a graph is
 * correct (that is the existing xd_validate_prototype operation). Its job is:
 *
 *   planned edges → serial execution → per-edge result → final validation
 *
 * Rules enforced here:
 *   * serial only - Adobe XD is a single stateful UI; no concurrent automation
 *   * per-edge truth - the batch is never more confident than its edges
 *   * idempotent - an edge already present is reported, never re-created
 *   * non-destructive - a conflicting edge is reported, never edited/deleted
 *   * cancellation boundary - checked *between* edges, never inside a UI action
 */
import {
  PROTOTYPE_ACTIONS,
  TRIGGERS,
  type DetectedEdge,
  type InteractionRequest,
  type PrototypeAction,
  type GraphMode,
  type Trigger,
  type VerificationResult,
  type WorkspaceMode,
} from "./protocol.ts";
import type { AdapterStatus, AuthoringFailure, StageRecord } from "./adapter.ts";

export const FAILURE_POLICIES = ["continue_on_error", "fail_fast"] as const;
export type FailurePolicy = (typeof FAILURE_POLICIES)[number];

/** One planned edge, after normalisation. */
export interface BatchEdge {
  index: number;
  source: string;
  target: string;
  trigger: Trigger;
  action: PrototypeAction;
  transition: string;
  duration: number;
  mode: WorkspaceMode;
  sourceRole?: string;
  note?: string;
}

/** Narrow view of the adapter result the batch depends on. */
export interface EdgeOutcome {
  status: AdapterStatus;
  repair?: { deleted: DetectedEdge[]; deletionVerified: boolean } | null;
  created: boolean;
  verified: boolean;
  source: { input: string; guid: string; name: string | null; type: string | null } | null;
  target: { input: string; guid: string; name: string | null; type: string | null } | null;
  verification: VerificationResult | null;
  detected: DetectedEdge[] | null;
  observedUi: Record<string, unknown> | null;
  failure: AuthoringFailure | null;
  stages: StageRecord[];
  durationMs: number;
}

export interface EdgeExecutionOptions {
  mode: GraphMode;
  /** every target the desired graph wants for this source (names or GUIDs) */
  wantedTargets: string[];
}

export interface GraphEdgeExecutor {
  createInteraction(request: Record<string, unknown>, options?: EdgeExecutionOptions): Promise<EdgeOutcome>;
}

export interface GraphRequirement {
  fromGuid: string;
  toGuid: string;
  trigger: Trigger;
  action: PrototypeAction;
}

export interface UnexpectedEdge {
  sourceGuid: string;
  sourceName: string | null;
  destinationGuid: string | null;
  destinationName: string | null;
  triggerType: string | null;
}

export type GraphValidation = {
  verdict: string | null;
  valid: boolean;
  coverage: number | null;
  expectedCount: number | null;
  missingCount: number | null;
  incorrectCount: number | null;
  /** document-wide, straight from xd_validate_prototype */
  extraCount: number | null;
  /** interactions from a batch SOURCE that the batch did not ask for (a real extra) */
  unexpected: UnexpectedEdge[];
  /** interactions from a node that is only a TARGET in this batch (informational) */
  unexpectedOnTargets: UnexpectedEdge[];
  note: string;
  /** pass-through from xd_validate_prototype, when present */
  missing?: unknown[];
  incorrect?: unknown[];
  raw?: Record<string, unknown>;
};

export interface BatchEdgeResult {
  index: number;
  source: string;
  target: string;
  sourceGuid: string | null;
  targetGuid: string | null;
  requested: { trigger: Trigger; action: PrototypeAction; transition: string; duration: number };
  status: "created" | "already_exists" | "conflict" | "failed" | "skipped" | "repaired";
  created: boolean;
  verified: boolean;
  evidence: {
    expected?: unknown;
    actual?: unknown;
    verdict?: string | null;
    problems?: string[];
    uiObserved?: Record<string, unknown> | null;
    stages?: Array<{ stage: string; ok: boolean; detail?: string; ms: number }>;
    failureCode?: string | null;
    failureStage?: string | null;
    note?: string;
  };
  durationMs: number;
}

export interface BatchSummary {
  created: number;
  already_exists: number;
  repaired: number;
  /** wires deleted by repair (not by "created") */
  deleted: number;
  conflicts: number;
  failed: number;
  skipped: number;
}

export type BatchStatus = "success" | "partial_success" | "already_exists" | "failed";

export interface BatchTiming {
  /** wall clock for the whole batch, including validation */
  totalDurationMs: number;
  /** edges that actually ran (created / already_exists / conflict / failed) */
  measuredEdges: number;
  averageEdgeDurationMs: number | null;
  minEdgeDurationMs: number | null;
  maxEdgeDurationMs: number | null;
  /** structural serial guarantee: the loop awaits one edge at a time */
  maxConcurrentEdges: number;
}

export interface BatchResult {
  ok: boolean;
  status: BatchStatus;
  failurePolicy: FailurePolicy;
  total: number;
  processed: number;
  aborted: boolean;
  summary: BatchSummary;
  edges: BatchEdgeResult[];
  validation: GraphValidation | null;
  validationSkippedReason: string | null;
  durationMs: number;
  timing: BatchTiming;
  progress: string[];
}

export type BatchValidation = (requirements: GraphRequirement[]) => Promise<GraphValidation | null> | GraphValidation | null;

export interface RunBatchOptions {
  failurePolicy?: FailurePolicy;
  /** create (default, non-destructive) | repair | reconcile */
  mode?: GraphMode;
  /** final semantic validation (existing xd_validate_prototype). omit to skip. */
  validate?: BatchValidation;
  /** checked between edges only; never mid-transaction */
  shouldAbort?: () => boolean;
  onProgress?: (line: string) => void;
}

// --- input normalisation -----------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Accept the shapes the planner already produces:
 *   * flat edge objects  { source, target, trigger?, ... }
 *   * xd_prototype_plan output edges { sourceNode:{name}, targetArtboard:{name}, ... }
 * Anything else is reported, never guessed.
 */
export function normalizeBatchEdges(raw: unknown): { ok: true; edges: BatchEdge[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "edges must be an array" };
  if (raw.length === 0) return { ok: false, error: "edges must not be empty" };
  if (raw.length > 200) return { ok: false, error: "edges is limited to 200 entries per batch" };

  const edges: BatchEdge[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: `edges[${i}] must be an object` };
    }
    const o = item as Record<string, unknown>;

    const sourceNode = (o.sourceNode ?? null) as Record<string, unknown> | null;
    const targetBoard = (o.targetArtboard ?? null) as Record<string, unknown> | null;
    const source = str(o.source) ?? (sourceNode ? str(sourceNode.name) : null) ?? (sourceNode ? str(sourceNode.input) : null);
    const target = str(o.target) ?? (targetBoard ? str(targetBoard.name) : null) ?? (targetBoard ? str(targetBoard.input) : null);

    if (!source) return { ok: false, error: `edges[${i}].source is required` };
    if (!target) return { ok: false, error: `edges[${i}].target is required` };

    const trigger = (o.trigger ?? "tap") as unknown;
    if (typeof trigger !== "string" || !TRIGGERS.includes(trigger as Trigger)) {
      return { ok: false, error: `edges[${i}].trigger must be one of ${TRIGGERS.join(", ")}` };
    }
    const action = (o.action ?? "goToArtboard") as unknown;
    if (typeof action !== "string" || !PROTOTYPE_ACTIONS.includes(action as PrototypeAction)) {
      return { ok: false, error: `edges[${i}].action must be one of ${PROTOTYPE_ACTIONS.join(", ")}` };
    }
    // The planner emits transition as an object ({type, duration}); accept that
    // shape verbatim so a plan is never silently downgraded to defaults.
    const transitionSpec = typeof o.transition === "object" && o.transition !== null && !Array.isArray(o.transition)
      ? (o.transition as Record<string, unknown>)
      : null;
    const transition = str(o.transition)
      ?? (transitionSpec ? str(transitionSpec.type) : null)
      ?? "dissolve";
    const duration = o.duration === undefined
      ? (transitionSpec && typeof transitionSpec.duration === "number" ? transitionSpec.duration : 0.3)
      : o.duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 10) {
      return { ok: false, error: `edges[${i}].duration must be a number between 0 and 10` };
    }
    const mode = (o.mode ?? "prototype") as unknown;
    if (mode !== "design" && mode !== "prototype") {
      return { ok: false, error: `edges[${i}].mode must be design or prototype` };
    }

    edges.push({
      index: edges.length,
      source,
      target,
      trigger: trigger as Trigger,
      action: action as PrototypeAction,
      transition,
      duration,
      mode: mode as WorkspaceMode,
      sourceRole: str(o.sourceRole) ?? undefined,
      note: str(o.note) ?? undefined,
    });
  }
  return { ok: true, edges };
}

// --- execution ----------------------------------------------------------------

function requirementOf(edge: BatchEdge, outcome: EdgeOutcome): GraphRequirement | null {
  const from = outcome.source?.guid;
  const to = outcome.target?.guid;
  if (!from || !to) return null;
  return { fromGuid: from, toGuid: to, trigger: edge.trigger, action: edge.action };
}

function edgeStatusOf(outcome: EdgeOutcome): BatchEdgeResult["status"] {
  switch (outcome.status) {
    case "success": return "created";
    case "already_exists": return "already_exists";
    case "repaired": return "repaired";
    case "conflict": return "conflict";
    default: return "failed";
  }
}

function toEdgeResult(edge: BatchEdge, outcome: EdgeOutcome): BatchEdgeResult {
  const status = edgeStatusOf(outcome);
  const verification = outcome.verification;
  return {
    index: edge.index,
    source: edge.source,
    target: edge.target,
    sourceGuid: outcome.source?.guid ?? null,
    targetGuid: outcome.target?.guid ?? null,
    requested: {
      trigger: edge.trigger,
      action: edge.action,
      transition: edge.transition,
      duration: edge.duration,
    },
    status,
    created: status === "created",
    verified: outcome.verified,
    evidence: {
      verdict: verification?.verdict ?? null,
      problems: verification?.problems ?? [],
      actual: outcome.detected ?? verification?.matches ?? null,
      uiObserved: outcome.observedUi,
      stages: outcome.stages.map((s) => ({ stage: s.stage, ok: s.ok, detail: s.detail, ms: s.ms })),
      failureCode: outcome.failure?.code ?? null,
      failureStage: outcome.failure?.stage ?? null,
      note: outcome.failure?.message,
      deleted: outcome.repair?.deleted.map((d) => ({
        targetGuid: d.destinationGuid,
        targetName: d.destinationName,
        triggerType: d.triggerType,
        transitionType: d.transitionType,
        duration: d.duration,
      })) ?? [],
      deletionVerified: outcome.repair?.deletionVerified ?? null,
    },
    durationMs: outcome.durationMs,
  };
}

/**
 * Execute edges one after another. Each edge is fully verified by the adapter
 * (UXP read-back) before the next one starts.
 */
export async function runPrototypeGraphBatch(
  executor: GraphEdgeExecutor,
  edges: BatchEdge[],
  options: RunBatchOptions = {},
): Promise<BatchResult> {
  const started = Date.now();
  const failurePolicy: FailurePolicy = options.failurePolicy ?? "continue_on_error";
  const mode: GraphMode = options.mode ?? "create";
  const progress: string[] = [];
  const results: BatchEdgeResult[] = [];
  const requirements: GraphRequirement[] = [];
  let aborted = false;
  let stopReason: string | null = null;
  let inFlight = 0;
  let maxConcurrent = 0;

  const report = (line: string) => {
    progress.push(line);
    if (options.onProgress) {
      try { options.onProgress(line); } catch { /* progress must never break the batch */ }
    }
  };

  for (const edge of edges) {
    // Cancellation boundary: only between edges, never inside a UI transaction.
    if (!aborted && options.shouldAbort && options.shouldAbort()) {
      aborted = true;
      stopReason = "aborted by caller";
    }
    if (aborted) {
      results.push({
        index: edge.index,
        source: edge.source,
        target: edge.target,
        sourceGuid: null,
        targetGuid: null,
        requested: { trigger: edge.trigger, action: edge.action, transition: edge.transition, duration: edge.duration },
        status: "skipped",
        created: false,
        verified: false,
        evidence: { note: stopReason ?? "not executed" },
        durationMs: 0,
      });
      continue;
    }

    report(`edge ${edge.index + 1}/${edges.length}: ${edge.source} → ${edge.target}`);

    let outcome: EdgeOutcome;
    inFlight++;
    if (inFlight > maxConcurrent) maxConcurrent = inFlight;
    try {
      outcome = await executor.createInteraction({
        source: edge.source,
        target: edge.target,
        trigger: edge.trigger,
        action: edge.action,
        transition: edge.transition,
        duration: edge.duration,
        mode: edge.mode,
      } satisfies InteractionRequest, {
        mode,
        wantedTargets: edges.filter((e) => e.source === edge.source).map((e) => e.target),
      });
    } catch (e) {
      outcome = {
        status: "failed",
        created: false,
        verified: false,
        source: null,
        target: null,
        verification: null,
        detected: null,
        observedUi: null,
        failure: {
          code: "VERIFICATION_FAILED",
          stage: "execute",
          message: `adapter threw: ${String(e)}`,
          xdModified: false,
          recoverable: true,
          hint: "Inspect the adapter log; this is not a normal execution path.",
        },
        stages: [],
        durationMs: 0,
      };
    } finally {
      inFlight--;
    }

    const result = toEdgeResult(edge, outcome);
    results.push(result);
    const req = requirementOf(edge, outcome);
    if (req) requirements.push(req);
    report(`edge ${edge.index + 1}/${edges.length}: ${result.status}${result.verified ? " (verified)" : ""}`);

    // fail_fast stops on anything that cannot satisfy the request: a failed
    // edge or a conflict with an existing incompatible interaction.
    if (failurePolicy === "fail_fast" && (result.status === "failed" || result.status === "conflict")) {
      aborted = true;
      stopReason = `fail_fast stopped at edge ${edge.index + 1} (${result.status})`;
      break;
    }
  }

  // any edge not reached (fail_fast) is reported, never silently dropped
  if (aborted && failurePolicy === "fail_fast") {
    for (const edge of edges.slice(results.length)) {
      results.push({
        index: edge.index,
        source: edge.source,
        target: edge.target,
        sourceGuid: null,
        targetGuid: null,
        requested: { trigger: edge.trigger, action: edge.action, transition: edge.transition, duration: edge.duration },
        status: "skipped",
        created: false,
        verified: false,
        evidence: { note: stopReason ?? "skipped" },
        durationMs: 0,
      });
    }
  }

  const summary: BatchSummary = { created: 0, already_exists: 0, repaired: 0, deleted: 0, conflicts: 0, failed: 0, skipped: 0 };
  for (const r of results) {
    if (r.status === "created") summary.created++;
    else if (r.status === "already_exists") summary.already_exists++;
    else if (r.status === "repaired") { summary.repaired++; summary.deleted += r.evidence.deleted?.length ?? 0; }
    else if (r.status === "conflict") summary.conflicts++;
    else if (r.status === "skipped") summary.skipped++;
    else summary.failed++;
  }

  let validation: GraphValidation | null = null;
  let validationSkippedReason: string | null = null;
  if (!options.validate) {
    validationSkippedReason = "validation port not provided";
  } else if (requirements.length === 0) {
    validationSkippedReason = "no edge resolved to a pair of GUIDs, so there was nothing to validate";
  } else {
    try {
      validation = await options.validate(requirements);
    } catch (e) {
      validationSkippedReason = `validation failed: ${String(e)}`;
    }
  }

  const processed = results.filter((r) => r.status !== "skipped").length;
  const allVerified = results.length > 0 && results.every((r) => r.verified);
  const anyFailure = summary.failed > 0 || summary.conflicts > 0 || summary.skipped > 0;
  // A source-scoped extra means we wired something the caller did not ask for.
  const extraFromSources = validation ? validation.unexpected.length > 0 : false;
  const validationOk = validation ? validation.valid && !extraFromSources : true;

  let status: BatchStatus;
  if (allVerified && !anyFailure && validationOk) {
    status = summary.created > 0 || summary.repaired > 0 ? "success" : "already_exists";
  } else {
    status = "partial_success";
  }
  if (summary.created === 0 && summary.already_exists === 0 && summary.repaired === 0 && summary.failed > 0) status = "failed";

  return {
    ok: status === "success" || status === "already_exists",
    status,
    failurePolicy,
    total: edges.length,
    processed,
    aborted,
    summary,
    edges: results,
    validation,
    validationSkippedReason,
    durationMs: Date.now() - started,
    timing: buildTiming(results, Date.now() - started, maxConcurrent),
    progress,
  };
}

/** Scoped extra detection: interactions on this batch's own sources that were not requested. */
export function findUnexpectedEdges(
  edges: DetectedEdge[],
  requirements: GraphRequirement[],
): UnexpectedEdge[] {
  const sources = new Set(requirements.map((r) => r.fromGuid));
  const expected = new Set(requirements.map((r) => `${r.fromGuid}→${r.toGuid}`));
  return collectUnexpected(edges, sources, expected);
}

/** Interactions from nodes that are only targets in this batch (context, not graph errors). */
export function findTargetOnlyExtras(
  edges: DetectedEdge[],
  requirements: GraphRequirement[],
): UnexpectedEdge[] {
  const sources = new Set(requirements.map((r) => r.fromGuid));
  const targets = new Set(requirements.map((r) => r.toGuid));
  const expected = new Set(requirements.map((r) => `${r.fromGuid}→${r.toGuid}`));
  const targetOnly = new Set([...targets].filter((t) => !sources.has(t)));
  return collectUnexpected(edges, targetOnly, expected);
}

function collectUnexpected(
  edges: DetectedEdge[],
  scope: Set<string>,
  expected: Set<string>,
): UnexpectedEdge[] {
  const out: UnexpectedEdge[] = [];
  for (const edge of edges) {
    if (!scope.has(edge.sourceGuid)) continue;
    if (expected.has(`${edge.sourceGuid}→${edge.destinationGuid}`)) continue;
    out.push({
      sourceGuid: edge.sourceGuid,
      sourceName: edge.sourceName,
      destinationGuid: edge.destinationGuid,
      destinationName: edge.destinationName,
      triggerType: edge.triggerType,
    });
  }
  return out;
}






function buildTiming(results: BatchEdgeResult[], totalDurationMs: number, maxConcurrent: number): BatchTiming {
  const measured = results.filter((r) => r.status !== "skipped").map((r) => r.durationMs).filter((n) => n >= 0);
  if (measured.length === 0) {
    return { totalDurationMs, measuredEdges: 0, averageEdgeDurationMs: null, minEdgeDurationMs: null, maxEdgeDurationMs: null, maxConcurrentEdges: maxConcurrent };
  }
  const sum = measured.reduce((a, b) => a + b, 0);
  return {
    totalDurationMs,
    measuredEdges: measured.length,
    averageEdgeDurationMs: Math.round(sum / measured.length),
    minEdgeDurationMs: Math.min(...measured),
    maxEdgeDurationMs: Math.max(...measured),
    maxConcurrentEdges: maxConcurrent,
  };
}


