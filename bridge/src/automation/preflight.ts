/**
 * Planner preflight: classify a desired graph against the platform grammar and
 * the live document BEFORE anything is mutated.
 *
 * Read-only. The only inputs are UXP reads (resolution + prototype state) and
 * the measured grammar. Every blocker carries its own explanation so a caller
 * can decide without guessing.
 */
import type { BatchEdge } from "./batch.ts";
import type { ResolveResult } from "./adapter.ts";
import {
  classifyCombination,
  normalizeTrigger,
  triggerSlot as grammarSlot,
  type GrammarSupport,
} from "./grammar.ts";
import {
  edgeSatisfies,
  normalizeDurationSeconds,
  slotOfEdge,
  triggerSlot,
  type DetectedEdge,
} from "./protocol.ts";

export type PreflightStatus =
  | "already_exists"
  | "safe_to_create"
  | "conflict"
  | "unsupported_combination"
  | "unsupported_trigger"
  | "duplicate_trigger_slot"
  | "unresolved_source"
  | "unresolved_target"
  | "unverified_combination";

export interface PreflightResolver {
  resolveSource(input: string): Promise<ResolveResult>;
  resolveTarget(input: string): Promise<ResolveResult>;
  readEdges(): Promise<DetectedEdge[]>;
}

export interface PreflightEdge {
  index: number;
  source: string;
  target: string;
  sourceGuid: string | null;
  targetGuid: string | null;
  trigger: string;
  action: string;
  transition: string;
  duration: number;
  status: PreflightStatus;
  blocking: boolean;
  reason: string;
  grammar: { support: GrammarSupport; reason: string } | null;
  existing?: DetectedEdge[];
}

export interface PreflightReport {
  ok: boolean;
  readOnly: true;
  total: number;
  blocking: number;
  summary: Record<PreflightStatus, number>;
  edges: PreflightEdge[];
  blockers: PreflightEdge[];
  documentInteractions: number;
  grammarVersion: string;
}

const BLOCKING: PreflightStatus[] = [
  "conflict",
  "unsupported_combination",
  "unsupported_trigger",
  "duplicate_trigger_slot",
  "unresolved_source",
  "unresolved_target",
  "unverified_combination",
];

function emptySummary(): Record<PreflightStatus, number> {
  return {
    already_exists: 0,
    safe_to_create: 0,
    conflict: 0,
    unsupported_combination: 0,
    unsupported_trigger: 0,
    duplicate_trigger_slot: 0,
    unresolved_source: 0,
    unresolved_target: 0,
    unverified_combination: 0,
  };
}

export async function runPreflight(
  resolver: PreflightResolver,
  edges: BatchEdge[],
  grammarVersion: string,
): Promise<PreflightReport> {
  const existing = await resolver.readEdges().catch(() => [] as DetectedEdge[]);
  const out: PreflightEdge[] = [];
  const usedSlots = new Map<string, { index: number; target: string }>();

  for (const edge of edges) {
    const base: PreflightEdge = {
      index: edge.index,
      source: edge.source,
      target: edge.target,
      sourceGuid: null,
      targetGuid: null,
      trigger: edge.trigger,
      action: edge.action,
      transition: edge.transition,
      duration: edge.duration,
      status: "safe_to_create",
      blocking: false,
      reason: "",
      grammar: null,
    };

    const source = await resolver.resolveSource(edge.source).catch(() => null);
    if (!source || source.reason !== "ok" || !source.node) {
      out.push({
        ...base,
        status: "unresolved_source",
        blocking: true,
        reason: source?.reason === "ambiguous"
          ? `"${edge.source}" matches ${source.candidates.length} nodes: ${source.candidates.map((c) => c.name ?? c.guid).join(", ")}`
          : `no node or artboard matches "${edge.source}"`,
      });
      continue;
    }
    base.sourceGuid = source.node.guid;

    const target = await resolver.resolveTarget(edge.target).catch(() => null);
    if (!target || target.reason !== "ok" || !target.node) {
      out.push({
        ...base,
        status: "unresolved_target",
        blocking: true,
        reason: target?.reason === "ambiguous"
          ? `"${edge.target}" matches ${target.candidates.length} artboards`
          : `no artboard matches "${edge.target}"`,
      });
      continue;
    }
    base.targetGuid = target.node.guid;

    // 1. platform grammar
    const verdict = classifyCombination(edge.trigger, edge.action, edge.transition);
    base.grammar = { support: verdict.support, reason: verdict.reason };
    if (verdict.support === "verified_unsupported" || verdict.support === "unverified") {
      const slot = grammarSlot(edge.trigger);
      const triggerProblem = !slot || !slot.authorable;
      out.push({
        ...base,
        status: verdict.support === "unverified" ? "unverified_combination" : triggerProblem ? "unsupported_trigger" : "unsupported_combination",
        blocking: true,
        reason: verdict.reason,
      });
      continue;
    }

    // 2. one interaction per trigger slot inside the requested graph
    const slotKey = `${source.node.guid}|${normalizeTrigger(edge.trigger)}`;
    const prior = usedSlots.get(slotKey);
    if (prior) {
      out.push({
        ...base,
        status: "duplicate_trigger_slot",
        blocking: true,
        reason: `edge ${prior.index + 1} already uses trigger "${edge.trigger}" for ${edge.source} (→ ${prior.target}); XD allows one interaction per trigger slot`,
      });
      continue;
    }
    usedSlots.set(slotKey, { index: edge.index, target: edge.target });

    // 3. document state
    const fromSource = existing.filter((e) => e.sourceGuid === source.node!.guid);
    const desired = {
      sourceGuid: source.node.guid,
      trigger: edge.trigger,
      action: edge.action,
      targetGuid: target.node.guid,
      transition: edge.transition,
      duration: edge.duration,
    };
    const exact = fromSource.find((e) => edgeSatisfies(e, desired));
    if (exact) {
      out.push({ ...base, status: "already_exists", blocking: false, reason: "the document already contains this interaction", existing: [exact] });
      continue;
    }

    const wantedWires = edges
      .filter((e) => e.source === edge.source)
      .map((e) => e.target);
    const wanted = new Set<string>(wantedWires);
    wanted.add(edge.target);
    const desiredSlot = triggerSlot(source.node.guid, edge.trigger, edge.action);
    const blocking = fromSource.filter((e) => slotOfEdge(e) === desiredSlot
      && !(wanted.has(e.destinationGuid ?? "") || (e.destinationName !== null && wanted.has(e.destinationName))));
    if (blocking.length > 0) {
      out.push({
        ...base,
        status: "conflict",
        blocking: true,
        reason: `${blocking.length} existing interaction(s) occupy the "${edge.trigger}" trigger slot of ${edge.source} and point outside the desired graph: ${blocking
          .map((b) => `${b.destinationName ?? b.destinationGuid} (${b.transitionType ?? "?"}, ${normalizeDurationSeconds(b.duration)}s)`)
          .join("; ")}. mode=create never edits or deletes existing wiring`,
        existing: blocking,
      });
      continue;
    }

    out.push({ ...base, status: "safe_to_create", blocking: false, reason: "no existing interaction occupies this trigger slot" });
  }

  const summary = emptySummary();
  for (const e of out) summary[e.status]++;
  const blockers = out.filter((e) => e.blocking);
  return {
    ok: blockers.length === 0,
    readOnly: true,
    total: out.length,
    blocking: blockers.length,
    summary,
    edges: out,
    blockers,
    documentInteractions: existing.length,
    grammarVersion,
  };
}

/** Human-readable one-liner for a status. */
export function describeStatus(status: PreflightStatus): string {
  switch (status) {
    case "already_exists": return "already exists in the document";
    case "safe_to_create": return "safe to create";
    case "conflict": return "an existing interaction blocks this trigger slot";
    case "unsupported_combination": return "this trigger/action/transition combination is not authorable";
    case "unsupported_trigger": return "this trigger cannot be authored";
    case "duplicate_trigger_slot": return "another requested edge already uses this trigger on the same source";
    case "unresolved_source": return "source does not resolve to exactly one node";
    case "unresolved_target": return "target does not resolve to an artboard";
    case "unverified_combination": return "this combination has not been verified on XD 61";
  }
}

export { BLOCKING };

