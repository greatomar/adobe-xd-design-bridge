/**
 * PrototypeAutomationAdapter — production integration layer between DesignBridge
 * and Windows GUI Automation.
 *
 * Responsibility split (deliberate, and enforced by this file's shape):
 *
 *   Semantic planner  → decides WHAT should be wired            (prototype.ts)
 *   This adapter      → drives XD's own UI to author it         (here)
 *   UXP read-back     → decides whether it actually exists      (ports.readEdges)
 *
 * The adapter never reports success from its own actions. `success` requires a
 * fresh UXP read-back that classifies the interaction as `ok`.
 *
 * No coordinates, no connector dragging, no undocumented APIs. Every UI action
 * is a documented UI Automation pattern executed by
 * automation/PrototypeAutomation/uia-worker.ps1.
 */
import type { AutomationRunner, WorkerResult } from "./worker.ts";
import { classifyCombination } from "./grammar.ts";
import {
  classifyWire,
  edgeSatisfies,
  expectedUi,
  isAutoAnimate,
  identityOfEdge,
  slotOfEdge,
  triggerSlot,
  toFailureCode,
  type DetectedEdge,
  type ExpectedUi,
  type FailureCode,
  type GraphMode,
  type InteractionRequest,
  type VerificationResult,
  type WorkspaceMode,
  validateInteractionRequest,
} from "./protocol.ts";

export interface ResolvedNode {
  guid: string;
  name: string | null;
  type: string | null;
}

export type ResolveReason = "ok" | "not_found" | "ambiguous";

export interface ResolveResult {
  node: ResolvedNode | null;
  reason: ResolveReason;
  candidates: Array<{ guid: string; name: string | null }>;
}

export interface AuthoringPorts {
  /** UXP: resolve a semantic name or GUID to exactly one live node. */
  resolveSource(input: string): Promise<ResolveResult>;
  /** UXP: resolve a name or GUID to exactly one existing artboard. */
  resolveTarget(input: string): Promise<ResolveResult>;
  /** UXP: current document selection. */
  readSelection(): Promise<ResolvedNode[]>;
  /** UXP: every prototype interaction in the document. */
  readEdges(): Promise<DetectedEdge[]>;
  /** Windows UI Automation worker. */
  runner: AutomationRunner;
}

export interface StageRecord {
  stage: string;
  ok: boolean;
  detail?: string;
  evidence?: Record<string, unknown>;
  ms: number;
}

export interface AuthoringFailure {
  code: FailureCode;
  stage: string;
  message: string;
  /** true only when a document mutation was already attempted */
  xdModified: boolean;
  recoverable: boolean;
  hint: string;
}

export type AdapterStatus = "success" | "partial_success" | "failed" | "already_exists" | "conflict" | "repaired";

export interface AuthoringResult {
  ok: boolean;
  status: AdapterStatus;
  created: boolean;
  verified: boolean;
  automationPath: "windows-ui-automation";
  authoringSupported: true;
  source: { input: string; guid: string; name: string | null; type: string | null } | null;
  target: { input: string; guid: string; name: string | null; type: string | null } | null;
  interaction: { trigger: string; action: string; transition: string; duration: number } | null;
  expectedUi: ExpectedUi | null;
  observedUi: Record<string, unknown> | null;
  verification: VerificationResult | null;
  /** the interaction the document actually has for this source (diagnostics) */
  detected: DetectedEdge[] | null;
  stages: StageRecord[];
  failure: AuthoringFailure | null;
  /** present when repair deleted a blocking wire */
  repair: { deleted: DetectedEdge[]; deletionVerified: boolean } | null;
  durationMs: number;
}

export interface ConnectResult {
  stage: StageRecord;
  state: Record<string, unknown> | null;
}

const STAGE_HINTS: Record<FailureCode | "CONFLICT", string> = {
  XD_NOT_FOUND: "Start Adobe XD and open the document before running the automation.",
  XD_NOT_ACTIVE: "Bring Adobe XD to the foreground; the automation will not act on a background window.",
  PROTOTYPE_MODE_FAILED: "Check whether the Prototype workspace toggle is available in this XD build/state.",
  SOURCE_NOT_FOUND: "Verify the source name/GUID against xd_search_nodes or xd_get_artboards.",
  SOURCE_AMBIGUOUS: "More than one node matches this name. Use a GUID (xd_search_nodes reports candidates).",
  SOURCE_SELECTION_FAILED: "The Layers row could not be selected or XD did not adopt it. Open the Layers pane and retry.",
  CONNECTOR_CREATION_FAILED: "The Interaction pane did not offer an editor for the selection. Check that exactly one node is selected and the pane is visible.",
  TARGET_NOT_FOUND: "The destination artboard must already exist; create it before wiring.",
  TARGET_AMBIGUOUS: "More than one artboard matches this name. Use the artboard GUID.",
  TARGET_CONNECTION_FAILED: "The Destination dropdown did not list the artboard (or the option could not be selected).",
  INTERACTION_CONFIGURATION_FAILED: "A trigger/action/transition/duration value was rejected by the XD UI; read the reported option list.",
  VERIFICATION_FAILED: "The interaction was attempted but the UXP read-back does not match. Inspect the reported verdict and detected interaction.",
  VIEWPORT_STATE_UNKNOWN: "The canvas viewport could not be read; avoid coordinate-based interaction and retry after focusing XD.",
  UNSUPPORTED_XD_UI: "This XD build does not expose the required control to UI Automation. The adapter stops instead of clicking blind coordinates.",
  AUTOMATION_TIMEOUT: "XD did not respond to the UI action in time. Check for a modal dialog or a hung document.",
  WORKER_UNAVAILABLE: "The PowerShell UI Automation worker could not be started.",
  INVALID_REQUEST: "Fix the request (source, target, trigger, action, transition, duration, mode).",
  CONFLICT: "The source already has a different interaction. This adapter does not modify or delete existing wiring.",
};

const SELECTION_RETRIES = 1;
const EDITOR_RETRIES = 1;

export class PrototypeAutomationAdapter {
  private ports: AuthoringPorts;
  private modeBefore: WorkspaceMode | null = null;
  private modeApplied: WorkspaceMode | null = null;

  constructor(ports: AuthoringPorts) {
    this.ports = ports;
  }

  // --- connection / state ---------------------------------------------------

  /** Focus XD and read its automation state. */
  async connect(mode: WorkspaceMode = "prototype"): Promise<ConnectResult> {
    const focus = await this.focusXd();
    if (!focus.ok) return { stage: focus, state: null };
    const switched = mode === "prototype" ? await this.switchToPrototypeMode() : await this.switchToDesignMode();
    if (switched.ok) this.modeApplied = mode;
    return { stage: switched, state: (switched.evidence as Record<string, unknown>) ?? null };
  }

  /** Raw automation diagnostics (see xd_probe_xd_automation). */
  async getState(sourceName?: string): Promise<Record<string, unknown> | null> {
    const r = await this.ports.runner.run("get_state", sourceName ? { name: sourceName } : {}, { timeoutMs: 45_000 });
    return r.ok ? (r.result as Record<string, unknown>) : null;
  }

  /** Full inventory: window, panels, controls, patterns, interaction state. */
  async probe(): Promise<WorkerResult> {
    return this.ports.runner.run("probe", {}, { timeoutMs: 45_000 });
  }

  async focusXd(): Promise<StageRecord> {
    return this.step("focus_xd", () => this.ports.runner.run("focus_xd", {}, { timeoutMs: 20_000 }), {
      expect: (r) => r.result?.focused === true,
      failureCode: "XD_NOT_ACTIVE",
    });
  }

  async switchToPrototypeMode(): Promise<StageRecord> {
    return this.step("switch_to_prototype_mode", () => this.ports.runner.run("ensure_mode", { mode: "prototype" }), {
      expect: (r) => r.result?.verified === true,
      failureCode: "PROTOTYPE_MODE_FAILED",
    });
  }

  async switchToDesignMode(): Promise<StageRecord> {
    return this.step("switch_to_design_mode", () => this.ports.runner.run("ensure_mode", { mode: "design" }), {
      expect: (r) => r.result?.verified === true,
      failureCode: "PROTOTYPE_MODE_FAILED",
    });
  }

  /** Restore the workspace this adapter switched away from, if any. */
  async disconnect(): Promise<StageRecord | null> {
    if (!this.modeApplied) return null;
    const restore: WorkspaceMode = this.modeApplied === "prototype" ? "design" : "prototype";
    this.modeApplied = null;
    return this.step("disconnect_restore_mode", () => this.ports.runner.run("ensure_mode", { mode: restore }), {
      expect: (r) => r.result?.verified === true,
      failureCode: "PROTOTYPE_MODE_FAILED",
    });
  }

  // --- selection ------------------------------------------------------------

  /** Select a node through the Layers list (SelectionItemPattern), no canvas click. */
  async selectNode(name: string, scope: "artboard" | "layer" = "artboard"): Promise<StageRecord> {
    return this.step("select_node", () => this.ports.runner.run("select_node", { name, scope }), {
      expect: (r) => r.result?.uiaSelected === true,
      failureCode: "SOURCE_SELECTION_FAILED",
    });
  }

  // --- interaction editor ---------------------------------------------------

  /** Open (or reuse) the interaction editor for the current selection. */
  async createConnector(force = false): Promise<StageRecord> {
    return this.step("create_connector", () => this.ports.runner.run("add_interaction", force ? { force: true } : {}), {
      expect: (r) => r.result?.editorVisible === true,
      failureCode: "CONNECTOR_CREATION_FAILED",
    });
  }

  async configureTarget(artboardName: string): Promise<StageRecord> {
    return this.setField("configure_target", "destination", artboardName, "TARGET_CONNECTION_FAILED");
  }

  async configureTrigger(trigger: string): Promise<StageRecord> {
    return this.setField("configure_trigger", "trigger", trigger, "INTERACTION_CONFIGURATION_FAILED");
  }

  async configureAction(action: string): Promise<StageRecord> {
    return this.setField("configure_action", "action", action, "INTERACTION_CONFIGURATION_FAILED");
  }

  async configureTransition(transition: string): Promise<StageRecord> {
    return this.setField("configure_transition", "transition", transition, "INTERACTION_CONFIGURATION_FAILED");
  }

  async configureDuration(seconds: number, label?: string): Promise<StageRecord> {
    const text = label ?? `${seconds.toFixed(1)} s`;
    return this.step("configure_duration", () => this.ports.runner.run("set_duration", { seconds, text }), {
      expect: (r) => {
        const after = r.result?.seconds;
        return typeof after === "number" && Math.abs(after - seconds) < 0.0005;
      },
      failureCode: "INTERACTION_CONFIGURATION_FAILED",
      field: "duration",
    });
  }

  /** Delete one existing wire by its target through XD's own UI, then re-read. */
  async deleteInteraction(targetName: string): Promise<StageRecord> {
    return this.step("delete_interaction", () => this.ports.runner.run("delete_row", { target: targetName }, { timeoutMs: 60_000 }), {
      expect: (r) => r.result?.status === "deleted",
      failureCode: "INTERACTION_DELETION_FAILED",
    });
  }

  /** Read the editor back and confirm the UI reflects what was requested. */
  async completeInteraction(): Promise<{ stage: StageRecord; observed: Record<string, unknown> | null }> {
    const stage = await this.step("complete_interaction", () => this.ports.runner.run("read_interaction", {}, { timeoutMs: 20_000 }), {
      expect: (r) => r.result?.editorOpen === true,
      failureCode: "INTERACTION_CONFIGURATION_FAILED",
    });
    return { stage, observed: stage.ok ? (stage.evidence ?? null) : null };
  }

  // --- orchestration --------------------------------------------------------

  async createInteraction(
    raw: unknown,
    options: { mode?: GraphMode; wantedTargets?: string[] } = {},
  ): Promise<AuthoringResult> {
    const started = Date.now();
    const stages: StageRecord[] = [];
    const mode: GraphMode = options.mode ?? "create";
    const repairEnabled = mode === "repair" || mode === "reconcile";

    const fail = (
      code: FailureCode | "CONFLICT",
      stage: string,
      message: string,
      extra: {
        xdModified?: boolean;
        recoverable?: boolean;
        source?: AuthoringResult["source"];
        target?: AuthoringResult["target"];
        verification?: VerificationResult | null;
        detected?: DetectedEdge[] | null;
      } = {},
    ): AuthoringResult => {
      const publicCode = (code === "CONFLICT" ? "CONNECTOR_CREATION_FAILED" : code) as FailureCode;
      return {
        ok: false,
        status: code === "CONFLICT" ? "conflict" : "failed",
        created: false,
        verified: false,
        automationPath: "windows-ui-automation",
        authoringSupported: true,
        source: extra.source ?? null,
        target: extra.target ?? null,
        interaction: null,
        expectedUi: null,
        observedUi: null,
        verification: extra.verification ?? null,
        detected: extra.detected ?? null,
        repair: null,
        stages,
        failure: {
          code: publicCode,
          stage,
          message,
          xdModified: extra.xdModified ?? false,
          recoverable: extra.recoverable ?? true,
          hint: STAGE_HINTS[code],
        },
        durationMs: Date.now() - started,
      };
    };

    const validated = validateInteractionRequest(raw);
    if (!validated.ok) return fail("INVALID_REQUEST", "validate", validated.error);
    const request = validated.request;

    // 1. resolve through UXP (read-only, never guesses)
    const source = await this.ports.resolveSource(request.source).catch(() => null);
    if (!source || source.reason !== "ok" || !source.node) {
      if (source?.reason === "ambiguous") {
        return fail("SOURCE_AMBIGUOUS", "resolve_source", `"${request.source}" matches ${source.candidates.length} nodes: ${source.candidates.map((c) => c.name ?? c.guid).join(", ")}`);
      }
      return fail("SOURCE_NOT_FOUND", "resolve_source", `no single node or artboard matches "${request.source}"`);
    }
    const target = await this.ports.resolveTarget(request.target).catch(() => null);
    if (!target || target.reason !== "ok" || !target.node) {
      if (target?.reason === "ambiguous") {
        return fail("TARGET_AMBIGUOUS", "resolve_target", `"${request.target}" matches ${target.candidates.length} artboards: ${target.candidates.map((c) => c.name ?? c.guid).join(", ")}`);
      }
      return fail("TARGET_NOT_FOUND", "resolve_target", `no artboard matches "${request.target}"`);
    }
    if (target.node.type !== "Artboard") {
      return fail("TARGET_NOT_FOUND", "resolve_target", `"${request.target}" resolves to ${target.node.type}, not an Artboard`);
    }

    const sourceNode = source.node;
    const targetNode = target.node;
    const resolved = {
      source: { input: request.source, guid: sourceNode.guid, name: sourceNode.name, type: sourceNode.type },
      target: { input: request.target, guid: targetNode.guid, name: targetNode.name, type: targetNode.type },
    };
    stages.push(stage("resolve_source", true, `${sourceNode.name ?? sourceNode.guid} (${sourceNode.type})`, { guid: sourceNode.guid }));
    stages.push(stage("resolve_target", true, `${targetNode.name ?? targetNode.guid}`, { guid: targetNode.guid }));

    // Platform grammar guard: never drive the UI for a combination XD is known
    // to reject or that has never been verified. Preflight is the primary gate;
    // this keeps a direct single-edge call from bypassing it.
    const grammar = classifyCombination(request.trigger, request.action, request.transition);
    if (grammar.support === "verified_unsupported" || grammar.support === "unverified") {
      stages.push(stage("platform_grammar", false, grammar.reason, { support: grammar.support }));
      return fail("UNSUPPORTED_XD_UI", "platform_grammar", grammar.reason, {
        recoverable: true, source: resolved.source, target: resolved.target,
      });
    }
    stages.push(stage("platform_grammar", true, grammar.reason, { support: grammar.support }));

    const requirement = {
      sourceGuid: sourceNode.guid,
      targetGuid: targetNode.guid,
      trigger: request.trigger,
      action: request.action,
      transition: request.transition,
      duration: request.duration,
    };

    // 2. reconcile against EVERY interaction the source currently has
    const before = await this.ports.readEdges().catch(() => [] as DetectedEdge[]);
    const sourceEdges = before.filter((e) => e.sourceGuid === sourceNode.guid);

    const desired = {
      sourceGuid: sourceNode.guid,
      trigger: request.trigger,
      action: request.action,
      targetGuid: targetNode.guid,
      transition: request.transition,
      duration: request.duration,
    };
    const exact = sourceEdges.find((e) => edgeSatisfies(e, desired));

    // A trigger slot can hold exactly one interaction in XD. If anything occupies
    // it and is not an exact match, authoring another one is guaranteed to fail
    // and would leave a partial interaction - so it is decided here, before any
    // UI command runs.
    const slot = triggerSlot(sourceNode.guid, request.trigger, request.action);
    // `wantedTargets` is kept for the batch contract (multi-edge sources) and is
    // used only to describe which requested edge owns the slot.
    const wanted = new Set<string>(options.wantedTargets ?? []);
    wanted.add(targetNode.guid);
    if (targetNode.name) wanted.add(targetNode.name);
    const blocking = exact ? [] : sourceEdges.filter((e) => slotOfEdge(e) === slot);

    stages.push(stage("precheck", Boolean(exact) || blocking.length === 0,
      `source has ${sourceEdges.length} interaction(s); ${exact ? "exact match" : `${blocking.length} blocking in trigger slot`}`,
      { sourceEdges: sourceEdges.length, blocking: blocking.length, exactMatch: Boolean(exact), mode }));

    if (exact) {
      return {
        ok: true,
        status: "already_exists",
        created: false,
        verified: true,
        automationPath: "windows-ui-automation",
        authoringSupported: true,
        source: resolved.source,
        target: resolved.target,
        interaction: interactionOf(request),
        expectedUi: expectedUi(request, targetNode.name ?? request.target),
        observedUi: null,
        verification: { verdict: "ok", verified: true, match: exact, matches: [exact], problems: [] },
        detected: sourceEdges,
        stages,
        failure: null,
        repair: null,
        durationMs: Date.now() - started,
      };
    }

    if (blocking.length > 0 && !repairEnabled) {
      return fail(
        "CONFLICT",
        "precheck",
        `the source already has ${blocking.length} interaction(s) in the same trigger slot pointing elsewhere (${blocking.map((e) => e.destinationName ?? e.destinationGuid ?? "?").join(", ")}); mode=create never edits or deletes existing wiring`,
        { recoverable: false, source: resolved.source, target: resolved.target, detected: sourceEdges },
      );
    }

    // 3. repair: delete the blocking wire(s), verify each, only then create
    let repair: AuthoringResult["repair"] = null;
    if (blocking.length > 0) {
      const deleted: DetectedEdge[] = [];
      for (const wire of blocking) {
        const name = wire.destinationName ?? wire.destinationGuid ?? "";
        const del = await this.deleteInteraction(name);
        stages.push({ ...del, stage: `delete_conflict:${name}` });
        if (!del.ok) {
          return fail("INTERACTION_DELETION_FAILED", "delete_conflict", del.detail ?? `could not delete the existing wire to ${name}`, {
            xdModified: false, source: resolved.source, target: resolved.target, detected: sourceEdges,
          });
        }
        const afterDelete = await this.ports.readEdges().catch(() => [] as DetectedEdge[]);
        const stillThere = afterDelete.some((e) => edgeSatisfies(e, identityOfEdge(wire)));
        stages.push(stage(`verify_deletion:${name}`, !stillThere, stillThere ? "the wire is still present in XD" : "the wire is gone"));
        if (stillThere) {
          return fail("INTERACTION_DELETION_FAILED", "verify_deletion", `the wire to ${name} is still present in XD after the delete action`, {
            xdModified: true, source: resolved.source, target: resolved.target,
            detected: afterDelete.filter((e) => e.sourceGuid === sourceNode.guid),
          });
        }
        deleted.push(wire);
      }
      repair = { deleted, deletionVerified: true };
    }

    // 3. drive the UI
    const focus = await this.focusXd();
    stages.push(focus);
    if (!focus.ok) {
      return fail("XD_NOT_ACTIVE", "focus_xd", focus.detail ?? "Adobe XD is not in the foreground", { source: resolved.source, target: resolved.target });
    }

    const modeStage = request.mode === "prototype" ? await this.switchToPrototypeMode() : await this.switchToDesignMode();
    stages.push(modeStage);
    if (!modeStage.ok) {
      return fail("PROTOTYPE_MODE_FAILED", "switch_mode", modeStage.detail ?? "workspace switch failed", { source: resolved.source, target: resolved.target });
    }
    this.modeApplied = request.mode;

    const sourceName = sourceNode.name ?? request.source;
    const scope = sourceNode.type === "Artboard" ? "artboard" : "layer";
    let selection: StageRecord | null = null;
    let selectionConfirmed = false;
    for (let attempt = 0; attempt <= SELECTION_RETRIES; attempt++) {
      selection = await this.selectNode(sourceName, scope);
      stages.push({ ...selection, stage: attempt === 0 ? "select_source" : `select_source_retry_${attempt}` });
      if (!selection.ok) continue;
      const selected = await this.ports.readSelection().catch(() => [] as ResolvedNode[]);
      selectionConfirmed = selected.some((n) => n.guid === sourceNode.guid);
      stages.push(stage("confirm_selection", selectionConfirmed, selectionConfirmed
        ? "UXP reports the source selected"
        : "UXP does not report the source selected", {
        selection: selected.map((s) => s.name ?? s.guid),
      }));
      if (selectionConfirmed) break;
    }
    if (!selection?.ok) {
      const code = toFailureCode((selection?.evidence as Record<string, unknown>)?.code as string | undefined);
      return fail(code === "UNSUPPORTED_XD_UI" ? "UNSUPPORTED_XD_UI" : "SOURCE_SELECTION_FAILED", "select_source", selection?.detail ?? "selection failed", {
        source: resolved.source, target: resolved.target,
      });
    }
    if (!selectionConfirmed) {
      return fail("SOURCE_SELECTION_FAILED", "confirm_selection", "the Layers row reported selected to UI Automation but XD's document selection did not change", {
        source: resolved.source, target: resolved.target,
      });
    }

    let connector: StageRecord | null = null;
    for (let attempt = 0; attempt <= EDITOR_RETRIES; attempt++) {
      // A source that already has wires needs a NEW interaction, not a reuse of
      // the open editor (XD allows one interaction per trigger).
      connector = await this.createConnector(sourceEdges.length > 0);
      stages.push({ ...connector, stage: attempt === 0 ? "create_connector" : `create_connector_retry_${attempt}` });
      if (connector.ok) break;
      // Recovery: re-select the node, then try the editor once more.
      await this.selectNode(sourceName, scope);
    }
    if (!connector?.ok) {
      const code = toFailureCode((connector?.evidence as Record<string, unknown>)?.code as string | undefined);
      return fail(code, "create_connector", connector?.detail ?? "the interaction editor did not open", {
        xdModified: false, source: resolved.source, target: resolved.target,
      });
    }

    // 4. configure, in XD's own field order
    const ui = expectedUi(request, targetNode.name ?? request.target);
    const autoAnimate = isAutoAnimate(request.transition);
    const configured: StageRecord[] = [
      await this.configureTarget(ui.destination),
      await this.configureTrigger(ui.trigger),
      await this.configureAction(ui.action),
    ];
    // Auto-Animate has no transition or duration control to configure; setting
    // them would reset the trigger (measured in stage 5).
    if (!autoAnimate) {
      configured.push(await this.configureTransition(ui.transition));
      configured.push(await this.configureDuration(request.duration, ui.duration));
    }
    stages.push(...configured);
    const failedField = configured.find((s) => !s.ok);
    if (failedField) {
      const code = failedField.stage === "configure_target" ? "TARGET_CONNECTION_FAILED" : "INTERACTION_CONFIGURATION_FAILED";
      return fail(code, failedField.stage, failedField.detail ?? `${failedField.stage} was not applied`, {
        xdModified: true, source: resolved.source, target: resolved.target,
      });
    }

    const completed = await this.completeInteraction();
    stages.push(completed.stage);

    // 5. the only evidence that counts
    const after = await this.ports.readEdges().catch(() => [] as DetectedEdge[]);
    const verification = classifyWire(after, requirement);
    const afterSourceEdges = after.filter((e) => e.sourceGuid === sourceNode.guid);
    stages.push(stage("verify", verification.verified, `${verification.verdict}${verification.problems.length ? ": " + verification.problems.join("; ") : ""}`, {
      verdict: verification.verdict,
      detected: afterSourceEdges.length,
    }));

    const partial = !verification.verified && verification.verdict !== "missing";
    const repaired = Boolean(repair) && verification.verified;
    return {
      ok: verification.verified,
      status: verification.verified ? (repaired ? "repaired" : "success") : partial ? "partial_success" : "failed",
      created: verification.verdict !== "missing",
      verified: verification.verified,
      automationPath: "windows-ui-automation",
      authoringSupported: true,
      source: resolved.source,
      target: resolved.target,
      interaction: interactionOf(request),
      expectedUi: ui,
      observedUi: completed.observed,
      verification,
      detected: afterSourceEdges,
      stages,
      repair,
      failure: verification.verified ? null : {
        code: repaired ? "REPAIR_FAILED" : "VERIFICATION_FAILED",
        stage: "verify",
        message: `the UI accepted the configuration but XD's read-back says ${verification.verdict}: ${verification.problems.join("; ")}`,
        xdModified: true,
        recoverable: true,
        hint: STAGE_HINTS.VERIFICATION_FAILED,
      },
      durationMs: Date.now() - started,
    };
  }

  // --- helpers --------------------------------------------------------------

  private async setField(stageName: string, field: string, value: string, failureCode: FailureCode): Promise<StageRecord> {
    return this.step(stageName, () => this.ports.runner.run("set_field", { field, value }), {
      expect: (r) => typeof r.result?.after === "string" && String(r.result.after).trim() === value.trim(),
      failureCode,
      field,
    });
  }

  private async step(
    stageName: string,
    run: () => Promise<WorkerResult>,
    opts: { expect: (r: Extract<WorkerResult, { ok: true }>) => boolean; failureCode: FailureCode; field?: string },
  ): Promise<StageRecord> {
    const t0 = Date.now();
    let result: WorkerResult;
    try {
      result = await run();
    } catch (e) {
      return { stage: stageName, ok: false, detail: `worker threw: ${String(e)}`, ms: Date.now() - t0 };
    }
    if (!result.ok) {
      return {
        stage: stageName,
        ok: false,
        detail: `${result.error.code}: ${result.error.message}`,
        evidence: { code: result.error.code, workerStage: result.error.stage, failureCode: toFailureCode(result.error.code, opts.field) },
        ms: Date.now() - t0,
      };
    }
    const satisfied = opts.expect(result);
    return {
      stage: stageName,
      ok: satisfied,
      detail: satisfied ? "ok" : "worker returned ok but the expected state was not observed",
      evidence: result.result,
      ms: Date.now() - t0,
    };
  }
}

function stage(stageName: string, ok: boolean, detail?: string, evidence?: Record<string, unknown>): StageRecord {
  return { stage: stageName, ok, detail, evidence, ms: 0 };
}

function interactionOf(request: InteractionRequest) {
  return { trigger: request.trigger, action: request.action, transition: request.transition, duration: request.duration };
}






/** Aggregate stage timings into the phases the performance report asks for. */
function breakdown(stages: StageRecord[], totalMs: number) {
  const sum = (pred: (s: StageRecord) => boolean) => stages.filter(pred).reduce((n, s) => n + (s.ms || 0), 0);
  return {
    totalMs,
    resolveMs: sum((s) => s.stage.startsWith("resolve_")),
    focusMs: sum((s) => s.stage === "focus_xd"),
    modeMs: sum((s) => s.stage.startsWith("switch_")),
    selectMs: sum((s) => s.stage.startsWith("select_source") || s.stage === "confirm_selection"),
    createMs: sum((s) => s.stage.startsWith("create_connector")),
    configureMs: sum((s) => s.stage.startsWith("configure_") || s.stage.startsWith("delete_") || s.stage.startsWith("verify_deletion")),
    verifyMs: sum((s) => s.stage === "verify" || s.stage === "complete_interaction"),
  };
}


