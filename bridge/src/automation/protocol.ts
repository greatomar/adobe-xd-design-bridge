/**
 * Request/response contract for prototype authoring through Windows UI
 * Automation. Pure functions only: no XD, no process spawning, no UI.
 *
 * DesignBridge keeps the truth: nothing here decides that a wire exists. It
 * normalises the request, maps semantic values to the labels Adobe XD's UI
 * actually shows, and compares what the UXP layer read back against what was
 * requested.
 */

export const TRIGGERS = ["tap", "drag", "time", "keys", "voice"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const PROTOTYPE_ACTIONS = ["goToArtboard", "overlay"] as const;
export type PrototypeAction = (typeof PROTOTYPE_ACTIONS)[number];

export const MODES = ["design", "prototype"] as const;

/** Graph authoring modes. `create` stays the default and is non-destructive. */
export const GRAPH_MODES = ["create", "repair", "reconcile"] as const;
export type GraphMode = (typeof GRAPH_MODES)[number];
export type WorkspaceMode = (typeof MODES)[number];

/** A request to create ONE prototype interaction. */
export interface InteractionRequest {
  source: string;
  target: string;
  trigger: Trigger;
  action: PrototypeAction;
  transition: string;
  duration: number;
  mode: WorkspaceMode;
}

export type ValidationResult =
  | { ok: true; request: InteractionRequest }
  | { ok: false; error: string };

function nonEmpty(v: unknown, name: string, max = 256): string | null {
  if (typeof v !== "string") return `${name} must be a string`;
  if (v.trim().length === 0) return `${name} must be a non-empty string`;
  if (v.length > max) return `${name} exceeds maximum length ${max}`;
  return null;
}

export function validateInteractionRequest(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "request must be an object {source, target, trigger?, action?, transition?, duration?, mode?}" };
  }
  const o = raw as Record<string, unknown>;

  const sourceError = nonEmpty(o.source, "source");
  if (sourceError) return { ok: false, error: sourceError };
  const targetError = nonEmpty(o.target, "target");
  if (targetError) return { ok: false, error: targetError };

  const trigger = o.trigger ?? "tap";
  if (typeof trigger !== "string" || !TRIGGERS.includes(trigger as Trigger)) {
    return { ok: false, error: `trigger must be one of ${TRIGGERS.join(", ")}` };
  }
  const action = o.action ?? "goToArtboard";
  if (typeof action !== "string" || !PROTOTYPE_ACTIONS.includes(action as PrototypeAction)) {
    return { ok: false, error: `action must be one of ${PROTOTYPE_ACTIONS.join(", ")}` };
  }
  const transition = o.transition ?? "dissolve";
  const transitionError = nonEmpty(transition, "transition", 64);
  if (transitionError) return { ok: false, error: transitionError };

  const duration = o.duration ?? 0.3;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 10) {
    return { ok: false, error: "duration must be a number between 0 and 10 (seconds)" };
  }

  const mode = o.mode ?? "prototype";
  if (typeof mode !== "string" || !MODES.includes(mode as WorkspaceMode)) {
    return { ok: false, error: `mode must be one of ${MODES.join(", ")}` };
  }

  return {
    ok: true,
    request: {
      source: (o.source as string).trim(),
      target: (o.target as string).trim(),
      trigger: trigger as Trigger,
      action: action as PrototypeAction,
      transition: transition as string,
      duration,
      mode: mode as WorkspaceMode,
    },
  };
}

// --- semantic value → label shown by Adobe XD's Interaction pane -------------

export const TRIGGER_LABELS: Record<Trigger, string> = {
  tap: "Tap",
  drag: "Drag",
  time: "Time",
  // XD offers this slot but exposes no key-mapping control to UI Automation, so
  // the grammar marks it unauthorable and preflight blocks it.
  keys: "Keys & Gamepad",
  voice: "Voice",
};

/** XD's "Type" dropdown value for a goToArtboard interaction. */
export const ACTION_LABELS: Record<PrototypeAction, string> = {
  goToArtboard: "Transition",
  overlay: "Overlay",
};

/**
 * Transition labels. Verified against XD 61: dissolve is shown as "Dissolve".
 * Unknown names are title-cased so the adapter can fail with the real option
 * list instead of silently picking something else.
 */
const TRANSITION_LABELS: Record<string, string> = {
  none: "None",
  dissolve: "Dissolve",
  "slide-left": "Slide Left",
  "slide-right": "Slide Right",
  "slide-up": "Slide Up",
  "slide-down": "Slide Down",
  dissolve_in: "Dissolve",
  push_left: "Push Left",
  push_right: "Push Right",
};

export function transitionLabel(name: string): string {
  const key = name.trim().toLowerCase();
  if (TRANSITION_LABELS[key]) return TRANSITION_LABELS[key];
  return name
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** XD shows durations with one decimal and a trailing " s" (e.g. "0.3 s"). */
export function formatDurationLabel(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}

export function parseDurationLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const cleaned = label.toLowerCase().replace(",", ".").replace(/\s+/g, "").replace(/s$/, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface ExpectedUi {
  trigger: string;
  action: string;
  destination: string;
  transition: string;
  duration: string;
}

/** The exact strings the Interaction pane must show for this request. */
/** Auto-Animate is reported by the plugin as transition.type = "autoAnimate" (no duration). */
export function isAutoAnimate(transition: string): boolean {
  return transition.trim().toLowerCase().replace(/[\s_-]+/g, "") === "autoanimate";
}

/** Auto-Animate interactions have no duration; every other transition does. */
export function expectsDuration(transition: string): boolean {
  return !isAutoAnimate(transition);
}

export function expectedUi(request: InteractionRequest, targetArtboardName: string): ExpectedUi {
  const autoAnimate = isAutoAnimate(request.transition);
  return {
    trigger: TRIGGER_LABELS[request.trigger],
    // XD shows Auto-Animate as the interaction *Type* for drag interactions, so
    // the pane label differs from the plugin action (goToArtboard).
    action: autoAnimate ? "Auto-Animate" : ACTION_LABELS[request.action],
    destination: targetArtboardName,
    transition: autoAnimate ? "Auto-Animate" : transitionLabel(request.transition),
    duration: autoAnimate ? "" : formatDurationLabel(request.duration),
  };
}

// --- UXP read-back comparison ----------------------------------------------

/** One interaction as read back by the plugin (get_prototype_state). */
export interface DetectedEdge {
  sourceGuid: string;
  sourceName: string | null;
  triggerType: string | null;
  actionType: string | null;
  destinationGuid: string | null;
  destinationName: string | null;
  transitionType: string | null;
  duration: number | null;
}

export interface VerificationRequirement {
  sourceGuid: string;
  targetGuid: string;
  trigger: Trigger;
  action: PrototypeAction;
  transition: string;
  duration: number;
}

export type WireVerdict =
  | "ok"
  | "missing"
  | "incomplete"
  | "wrong-destination"
  | "wrong-trigger"
  | "wrong-action"
  | "wrong-transition"
  | "wrong-duration"
  | "ambiguous";

export interface VerificationResult {
  verdict: WireVerdict;
  verified: boolean;
  match: DetectedEdge | null;
  matches: DetectedEdge[];
  problems: string[];
}

const DURATION_TOLERANCE = 0.02;

function sameTransition(actual: string | null, wanted: string): boolean {
  if (!actual) return false;
  return actual.trim().toLowerCase() === wanted.trim().toLowerCase();
}

/**
 * Classify the read-back against the requirement. Mirrors the plugin's
 * `classifyConnection`, extended with transition and duration because those
 * were explicitly part of this POC.
 */
export function classifyWire(edges: DetectedEdge[], requirement: VerificationRequirement): VerificationResult {
  const fromSource = edges.filter((e) => e.sourceGuid === requirement.sourceGuid);
  if (fromSource.length === 0) {
    return { verdict: "missing", verified: false, match: null, matches: [], problems: ["no interaction exists on the source node"] };
  }

  const toTarget = fromSource.filter((e) => e.destinationGuid === requirement.targetGuid);
  if (toTarget.length === 0) {
    const destinations = fromSource.map((e) => e.destinationName ?? e.destinationGuid ?? "none");
    return {
      verdict: "wrong-destination",
      verified: false,
      match: null,
      matches: [],
      problems: [`source is wired to ${destinations.join(", ")} instead of the requested target`],
    };
  }
  if (toTarget.length > 1) {
    return { verdict: "ambiguous", verified: false, match: null, matches: toTarget, problems: ["more than one interaction matches source → target"] };
  }

  const edge = toTarget[0];
  const problems: string[] = [];
  if (!edge.destinationGuid) problems.push("destination is empty");
  if (edge.triggerType !== requirement.trigger) problems.push(`trigger is "${edge.triggerType ?? "none"}" instead of "${requirement.trigger}"`);
  if (edge.actionType !== requirement.action) problems.push(`action is "${edge.actionType ?? "none"}" instead of "${requirement.action}"`);
  if (!sameTransition(edge.transitionType, requirement.transition)) {
    problems.push(`transition is "${edge.transitionType ?? "none"}" instead of "${requirement.transition}"`);
  }
  if (expectsDuration(requirement.transition)) {
    if (edge.duration === null || Math.abs(edge.duration - requirement.duration) > DURATION_TOLERANCE) {
      problems.push(`duration is ${edge.duration ?? "unset"} instead of ${requirement.duration}`);
    }
  }

  if (problems.length === 0) {
    return { verdict: "ok", verified: true, match: edge, matches: [edge], problems };
  }
  const verdict: WireVerdict = !edge.triggerType || !edge.actionType || !edge.destinationGuid
    ? "incomplete"
    : edge.triggerType !== requirement.trigger
      ? "wrong-trigger"
      : edge.actionType !== requirement.action
        ? "wrong-action"
        : !sameTransition(edge.transitionType, requirement.transition)
          ? "wrong-transition"
          : "wrong-duration";
  return { verdict, verified: false, match: edge, matches: [edge], problems };
}

// --- failure vocabulary -----------------------------------------------------

export const FAILURE_CODES = [
  "XD_NOT_FOUND",
  "XD_NOT_ACTIVE",
  "PROTOTYPE_MODE_FAILED",
  "SOURCE_NOT_FOUND",
  "SOURCE_AMBIGUOUS",
  "SOURCE_SELECTION_FAILED",
  "CONNECTOR_CREATION_FAILED",
  "TARGET_NOT_FOUND",
  "TARGET_AMBIGUOUS",
  "TARGET_CONNECTION_FAILED",
  "INTERACTION_CONFIGURATION_FAILED",
  "VERIFICATION_FAILED",
  "INTERACTION_DELETION_FAILED",
  "REPAIR_FAILED",
  "VIEWPORT_STATE_UNKNOWN",
  "UNSUPPORTED_XD_UI",
  "AUTOMATION_TIMEOUT",
  "WORKER_UNAVAILABLE",
  "INVALID_REQUEST",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Map a worker/adapter error onto the public failure vocabulary. */
export function toFailureCode(code: string | null | undefined, field?: string): FailureCode {
  switch (code) {
    case "XD_NOT_FOUND":
    case "XD_WINDOW_NOT_FOUND":
      return "XD_NOT_FOUND";
    case "PROTOTYPE_MODE_FAILED":
      return "PROTOTYPE_MODE_FAILED";
    case "SOURCE_NOT_FOUND":
      return "SOURCE_NOT_FOUND";
    case "SOURCE_AMBIGUOUS":
    case "ambiguous":
      return "SOURCE_AMBIGUOUS";
    case "SOURCE_SELECTION_FAILED":
      return "SOURCE_SELECTION_FAILED";
    case "CONNECTOR_CREATION_FAILED":
      return "CONNECTOR_CREATION_FAILED";
    case "TARGET_NOT_FOUND":
      return "TARGET_NOT_FOUND";
    case "INTERACTION_CONFIGURATION_FAILED":
      return field === "destination" ? "TARGET_CONNECTION_FAILED" : "INTERACTION_CONFIGURATION_FAILED";
    case "option_not_found":
      return field === "destination" ? "TARGET_CONNECTION_FAILED" : "INTERACTION_CONFIGURATION_FAILED";
    case "UNSUPPORTED_XD_UI":
    case "element_not_found":
    case "unsupported_control":
      return "UNSUPPORTED_XD_UI";
    case "AUTOMATION_TIMEOUT":
    case "timeout":
      return "AUTOMATION_TIMEOUT";
    case "WORKER_UNAVAILABLE":
      return "WORKER_UNAVAILABLE";
    case "VERIFICATION_FAILED":
      return "VERIFICATION_FAILED";
    default:
      return "UNSUPPORTED_XD_UI";
  }
}

// --- canonical wire identity -------------------------------------------------

/**
 * One normalised identity for a prototype wire. Every layer (reconciliation,
 * conflict detection, deletion, creation, verification, validation) compares
 * wires through this shape - there is exactly one matching definition.
 */
export interface InteractionIdentity {
  sourceGuid: string;
  trigger: string;
  action: string;
  targetGuid: string;
  transition: string;
  /** seconds, rounded to 2 decimals so XD float noise never splits a match */
  duration: number;
}

export function normalizeTransitionName(value: unknown): string {
  if (typeof value !== "string") return "none";
  const t = value.trim().toLowerCase();
  return t.length > 0 ? t : "none";
}

export function normalizeDurationSeconds(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.round(n * 100) / 100;
}

export function identityOfEdge(edge: DetectedEdge): InteractionIdentity {
  return {
    sourceGuid: edge.sourceGuid,
    trigger: normalizeTransitionName(edge.triggerType),
    action: normalizeTransitionName(edge.actionType),
    targetGuid: edge.destinationGuid ?? "",
    transition: normalizeTransitionName(edge.transitionType),
    duration: normalizeDurationSeconds(edge.duration),
  };
}

/**
 * Canonical key for one wire.
 *
 * Everything is normalised here so a caller passing "goToArtboard" and a
 * read-back edge reporting "gotoartboard" produce the same key. Auto-Animate is
 * special: XD stores it WITHOUT a duration, so duration must not participate in
 * its identity - otherwise a request carrying the default 0.3 s never matches
 * the existing wire and the edge is re-authored (the failure found in final
 * acceptance).
 */
export function identityKey(id: InteractionIdentity): string {
  const transition = normalizeTransitionName(id.transition);
  const duration = isAutoAnimate(transition) ? 0 : normalizeDurationSeconds(id.duration);
  return [
    id.sourceGuid,
    normalizeTransitionName(id.trigger),
    normalizeTransitionName(id.action),
    id.targetGuid,
    transition,
    duration,
  ].join("|");
}

/** The trigger slot a wire occupies: two wires in the same slot with different
 * destinations cannot both satisfy one desired edge. */
export function triggerSlot(sourceGuid: string, trigger: string, action: string): string {
  return [sourceGuid, normalizeTransitionName(trigger), normalizeTransitionName(action)].join("|");
}

export function slotOfEdge(edge: DetectedEdge): string {
  return triggerSlot(edge.sourceGuid, edge.triggerType ?? "", edge.actionType ?? "");
}

/** Exact match on the full identity (source, slot, target, transition, duration). */
export function sameIdentity(a: InteractionIdentity, b: InteractionIdentity): boolean {
  return identityKey(a) === identityKey(b);
}

/** Does an existing edge already satisfy a desired wire? */
export function edgeSatisfies(edge: DetectedEdge, desired: InteractionIdentity): boolean {
  return identityKey(identityOfEdge(edge)) === identityKey(desired);
}

/**
 * Which existing edges occupy the same trigger slot as the desired wire but
 * point somewhere the desired graph does not want? Those are the wires that
 * block creation (conflict) or that repair/reconcile may delete.
 */
export function findBlockingWires(
  existing: DetectedEdge[],
  desired: InteractionIdentity,
  wantedTargetKeys: Set<string>,
): DetectedEdge[] {
  const slot = triggerSlot(desired.sourceGuid, desired.trigger, desired.action);
  return existing.filter((e) => {
    if (slotOfEdge(e) !== slot) return false;
    const target = e.destinationGuid ?? "";
    return !wantedTargetKeys.has(target);
  });
}




