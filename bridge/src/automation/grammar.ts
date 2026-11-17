/**
 * Adobe XD 61 platform grammar for prototype interactions.
 *
 * Everything here is derived from LIVE measurements on XD 61.0.12.1, not from
 * dropdown contents. A combination is only `verified_supported` when the UI
 * accepted it, it stayed stable, and the UXP read-back reported the requested
 * semantics on two separate reads.
 *
 * Evidence sources:
 *  - automation/PrototypeAutomation/evidence/ACCEPTANCE-REPORT.md (stages 1-5)
 *  - the pane/trigger probes recorded in docs/prototype-gui-automation.md
 *
 * Do not widen a rule without a live test that proves it.
 */

export const GRAMMAR_VERSION = "xd-61.0.12.1/1";

export type GrammarSupport =
  | "verified_supported"
  | "verified_unsupported"
  | "conditionally_supported"
  | "unverified";

export interface InteractionGrammarRule {
  trigger: string;
  /** XD's action type as the plugin reports it (goToArtboard, autoAnimate, overlay) */
  action: string;
  /** UI label shown in the "Type" dropdown */
  actionLabel: string;
  /** transitions the pane accepts AND keeps for this pair (plugin values) */
  transitions: string[];
  /** transitions measured to be rejected/reset for this pair */
  unsupportedTransitions?: string[];
  support: GrammarSupport;
  constraints?: Record<string, unknown>;
  evidence?: string[];
  note?: string;
}

export interface TriggerSlotRule {
  trigger: string;
  /** UI label */
  label: string;
  /** plugin value */
  value: string;
  /** can an interaction with this trigger be authored today? */
  authorable: boolean;
  note?: string;
}

/**
 * Triggers XD offers, in the order the pane assigns them to new interactions.
 * One interaction per trigger slot per source node.
 */
export const TRIGGER_SLOTS: TriggerSlotRule[] = [
  { trigger: "tap", label: "Tap", value: "tap", authorable: true, note: "default trigger for a source's first interaction" },
  { trigger: "drag", label: "Drag", value: "drag", authorable: true, note: "defaults to the Auto-Animate action" },
  { trigger: "time", label: "Time", value: "time", authorable: true },
  {
    trigger: "keys",
    label: "Keys & Gamepad",
    value: "keys",
    authorable: false,
    note: "an interaction authored with this trigger did not persist in the document; no key-mapping control is exposed to UI Automation",
  },
  { trigger: "voice", label: "Voice", value: "voice", authorable: true },
];

const RULES: InteractionGrammarRule[] = [
  {
    trigger: "tap",
    action: "goToArtboard",
    actionLabel: "Transition",
    transitions: ["none", "dissolve"],
    support: "verified_supported",
    evidence: [
      "Stage 1-4: tap/Transition/Dissolve/0.3s authored repeatedly and validated through xd_validate_prototype (16-edge graph, coverage 1).",
      "Stage 5: tap/Transition created on PrototypeMultiTest/ConflictSource (Target6) and read back as tap/goToArtboard/dissolve/0.3.",
    ],
  },
  {
    trigger: "drag",
    action: "goToArtboard",
    actionLabel: "Auto-Animate",
    transitions: ["autoAnimate"],
    unsupportedTransitions: ["none", "dissolve", "slide"],
    support: "conditionally_supported",
    evidence: [
      "Stage 5: a drag interaction created by the pane default persisted as trigger drag, action goToArtboard, transition autoAnimate (no duration).",
      "Stage 7: drag + autoAnimate authored through the adapter and verified by UXP read-back.",
    ],
    note: "Only the pane's default Auto-Animate template for Drag is authorable. The plugin reports it as action goToArtboard + transition autoAnimate, and there is no duration.",
  },
  {
    trigger: "time",
    action: "goToArtboard",
    actionLabel: "Transition",
    transitions: ["dissolve"],
    support: "verified_supported",
    evidence: [
      "Stage 5: time/Transition/Dissolve/0.3s created on SourceA (Target3) and on ConflictSource (Target7); both persisted in UXP read-back.",
    ],
  },
  {
    trigger: "voice",
    action: "goToArtboard",
    actionLabel: "Transition",
    transitions: ["dissolve"],
    support: "verified_supported",
    evidence: [
      "Stage 5: voice/Transition/Dissolve/0.3s created on SourceA (Target5) and ConflictSource (Target9); both persisted in UXP read-back.",
    ],
  },
  {
    trigger: "keys",
    action: "goToArtboard",
    actionLabel: "Transition",
    transitions: ["dissolve"],
    support: "unverified",
    evidence: [
      "Stage 5: an interaction configured with Keys & Gamepad was written to the pane but never appeared in the UXP read-back; no key mapping control was found.",
    ],
    note: "Treated as unsupported by preflight until a key mapping is both configurable and readable.",
  },
];

export function normalizeTrigger(value: string): string {
  const t = value.trim().toLowerCase().replace(/\s*&\s*/, "&");
  if (t === "keys&gamepad" || t === "keys" || t === "keyboard") return "keys";
  return t;
}

export function normalizeAction(value: string): string {
  const t = value.trim().toLowerCase();
  if (t === "transition" || t === "gotoartboard") return "goToArtboard";
  if (t === "auto-animate" || t === "autoanimate") return "autoAnimate";
  if (t === "overlay") return "overlay";
  return value.trim();
}

export function normalizeTransition(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function findRule(trigger: string, action: string): InteractionGrammarRule | undefined {
  const t = normalizeTrigger(trigger);
  const a = normalizeAction(action);
  return RULES.find((r) => r.trigger === t && normalizeAction(r.action) === a);
}

export function triggerSlot(trigger: string): TriggerSlotRule | undefined {
  const t = normalizeTrigger(trigger);
  return TRIGGER_SLOTS.find((s) => s.trigger === t);
}

export function authorableTriggers(): string[] {
  return TRIGGER_SLOTS.filter((s) => s.authorable).map((s) => s.trigger);
}

export interface GrammarVerdict {
  support: GrammarSupport;
  reason: string;
  rule?: InteractionGrammarRule;
}

/** Classify one desired (trigger, action, transition) triple. */
export function classifyCombination(trigger: string, action: string, transition: string): GrammarVerdict {
  const slot = triggerSlot(trigger);
  if (!slot) {
    return { support: "verified_unsupported", reason: `trigger "${trigger}" does not exist in XD 61` };
  }
  if (!slot.authorable) {
    return { support: "verified_unsupported", reason: `trigger "${slot.label}" cannot be authored through UI Automation${slot.note ? `: ${slot.note}` : ""}` };
  }
  const rule = findRule(trigger, action);
  if (!rule) {
    return { support: "unverified", reason: `no measurement exists for ${slot.label} + ${action} in XD 61` };
  }
  const wanted = normalizeTransition(transition);
  const allowed = rule.transitions.map(normalizeTransition);
  if (rule.support === "verified_unsupported") {
    return { support: rule.support, reason: `${slot.label} + ${rule.actionLabel} is rejected/reset by the pane${rule.note ? `: ${rule.note}` : ""}`, rule };
  }
  if (rule.unsupportedTransitions && rule.unsupportedTransitions.map(normalizeTransition).includes(wanted)) {
    return {
      support: "verified_unsupported",
      reason: `${slot.label} + "${transition}" is reset by the pane; only ${rule.transitions.join(", ")} is authorable for this trigger`,
      rule,
    };
  }
  if (allowed.length > 0 && !allowed.includes(wanted)) {
    return {
      support: rule.support === "verified_supported" ? "unverified" : rule.support,
      reason: `${slot.label} + ${rule.actionLabel} is measured only for transition(s) ${rule.transitions.join(", ")}; "${transition}" has not been verified`,
      rule,
    };
  }
  return { support: rule.support, reason: `${slot.label} + ${rule.actionLabel} verified in XD 61`, rule };
}

export function grammarSummary() {
  const bySupport: Record<GrammarSupport, number> = {
    verified_supported: 0,
    verified_unsupported: 0,
    conditionally_supported: 0,
    unverified: 0,
  };
  for (const rule of RULES) bySupport[rule.support]++;
  return {
    version: GRAMMAR_VERSION,
    triggers: TRIGGER_SLOTS,
    authorableTriggers: authorableTriggers(),
    rules: RULES,
    bySupport,
  };
}

