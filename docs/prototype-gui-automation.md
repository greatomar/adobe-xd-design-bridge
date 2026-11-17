# Prototype authoring through Windows GUI Automation

Adobe XD's plugin API is read-only for prototype wiring: the `interactions`
module exposes `flows`, `allInteractions`, `triggeredInteractions` and
`incomingInteractions`, and nothing creates, edits or deletes a wire. Until now
the bridge could only *prepare* and *verify* manual wiring.

This layer closes the authoring gap from the other side: it drives **XD's own
UI** with Windows UI Automation (the same accessibility tree a screen reader
uses), then proves the result through the existing UXP read-back.

```
OpenCode → DesignBridge MCP → Windows UI Automation → Adobe XD UI → real wire
                                    ▲
                                    └── no coordinates, no connector drag
                       UXP read-back ──┴── get_prototype_state / validate_prototype
```

## Division of responsibility

| Layer | Owns |
|---|---|
| UXP plugin (unchanged) | document/node/artboard inspection, geometry, prototype read-back, selection observation |
| `bridge/src/automation/protocol.ts` | request validation, XD label mapping, read-back classification, failure vocabulary (pure) |
| `bridge/src/automation/geometry.ts` | document→screen mapping for a coordinate fallback (pure, not used on the happy path) |
| `bridge/src/automation/adapter.ts` | the high-level operations and the staged, verified flow |
| `bridge/src/automation/worker.ts` | child-process transport with timeouts |
| `automation/PrototypeAutomation/uia-worker.ps1` | the actual UI Automation commands |

## High-level operations

Exposed by `PrototypeAutomationAdapter` (units, not raw mouse events):

```
connect(opts?)                focus XD + switch workspace (verified)
getState(sourceName?)         automation diagnostics (what exists / what is missing)
switchToPrototypeMode()       verified workspace switch
selectNode(name, scope)       Layers list → SelectionItemPattern.Select()
createConnector()             Add Interaction (idempotent: reuses an open editor)
configureTrigger(v)           verified against the control's ValuePattern
configureAction(v)            "
configureTarget(artboard)     " (reveals virtualized rows when needed)
configureTransition(v)        "
configureDuration(seconds)    " (focus + Enter, then read back)
completeInteraction()         reads the editor state back
createInteraction(request)    the composed, verified flow
disconnect()                  restores the workspace it switched away from
```

`createInteraction` is the only composed flow:

```
validate → resolve source/target (UXP, ambiguous names refused)
        → pre-check document (UXP): already_exists / conflict / proceed
        → focus_xd → switch workspace → select_node (retry once)
        → confirm selection (UXP, not the UIA claim)
        → Add Interaction (idempotent) → Destination → Trigger → Action → Transition → Duration
        → complete_interaction (UI snapshot)
        → read-back (UXP) → classify → success / partial_success / failed
```

Every stage is recorded with its own ok/ms/evidence, so a failure names the
exact blocking point (`failure.code`, `failure.stage`, `failure.xdModified`).

Status vocabulary: `success` (created **and** verified), `partial_success`
(a wire exists but its properties do not match), `failed` (nothing created or
nothing detected), `already_exists` (document already matches, nothing done),
`conflict` (a different interaction already exists; never edited).

## Why no dragging and no coordinates

`canvasView` is a `ControlType.Custom` element with **zero** UIA children: the
canvas (artboards, shapes, connector handles) is not in the accessibility tree.
Two consequences:

1. Selection is done through the **Layers list** (`layersPaneOutlineView` →
   `layerItem` → `SelectionItemPattern.Select()`), which is semantic and
   resolution-independent. Verified: the UIA selection is confirmed by
   `xd_get_selection` on the document.
2. The wire is created through the **Interaction pane** (`Add Interaction` +
   `Destination` dropdown), which is exactly what XD's own UI writes when a user
   drags a connector — without needing the connector geometry.

`geometry.ts` exists because the task asked what to do if the connector were
canvas-only: it maps a document point to screen pixels from `viewport.bounds`,
`viewport.zoomFactor` and the `canvasView` rectangle, and refuses to answer when
the viewport is unreadable (`VIEWPORT_STATE_UNKNOWN`). It is deliberately **not**
on the happy path — blind clicking is worse than a structured failure.

## Verified behaviours (XD 61.0.12.1, live)

| Behaviour | Consequence in the adapter |
|---|---|
| The Interaction pane only exists in the Prototype workspace | workspace is switched first; failure → `PROTOTYPE_MODE_FAILED` |
| Design-mode / no-editor state keeps a detached, disabled copy of the controls in the tree | `editorOpen` requires the destination ComboBox to be **enabled**, not merely present |
| Re-selecting a node that already has an interaction opens the existing editor | `Add Interaction` returns `alreadyOpen: true` and is never pressed twice |
| The Destination dropdown is a virtualized popup (45 of 55 rows realised, no Scroll pattern) | rows are revealed with `{END}` list navigation, then `SelectionItemPattern.Select()` |
| Duration does not commit from `ValuePattern.SetValue` alone | focus + `{ENTER}`, then read back `0.3 s` (only synthetic key in the flow) |
| `SetForegroundWindow` alone is refused under the Windows foreground lock | `AttachThreadInput` + `SetForegroundWindow`, verified with `GetForegroundWindow()` |
| XD reuses the last duration for new interactions | every field is read back; defaults are never assumed |

Live evidence: [`automation/PrototypeAutomation/evidence/ACCEPTANCE-REPORT.md`](../automation/PrototypeAutomation/evidence/ACCEPTANCE-REPORT.md).

## Verification rules

* `created: true` requires the wire to be attempted **and** `classifyWire` to
  return `ok` on a fresh `get_prototype_state` read.
* Classification compares source GUID, destination GUID, trigger, action,
  transition and duration (tolerance 0.02 s for XD's float storage).
* A UI that reports success while the document disagrees produces
  `VERIFICATION_FAILED` with `created: false`, `verified: false` and the
  mismatch list.
* The adapter refuses to stack a second wire on a source that already has a
  different interaction (`recoverable: false`) — this layer never edits or
  deletes existing wiring.

## Failure codes

`XD_NOT_FOUND`, `XD_NOT_ACTIVE`, `PROTOTYPE_MODE_FAILED`, `SOURCE_NOT_FOUND`,
`SOURCE_SELECTION_FAILED`, `CONNECTOR_CREATION_FAILED`, `TARGET_NOT_FOUND`,
`TARGET_CONNECTION_FAILED`, `INTERACTION_CONFIGURATION_FAILED`,
`VERIFICATION_FAILED`, `VIEWPORT_STATE_UNKNOWN`, `UNSUPPORTED_XD_UI`,
`AUTOMATION_TIMEOUT`, `WORKER_UNAVAILABLE`, `INVALID_REQUEST`.

Each failure carries `stage`, `message`, `xdModified`, `recoverable` and a hint.

## MCP surface

| Tool | Purpose |
|---|---|
| `xd_create_prototype_interaction` | one edge: `{source, target, trigger?, action?, transition?, duration?, mode?}` → `created`/`verified` |
| `xd_create_prototype_graph` | many edges, serial + per-edge verified + final validation |
| `xd_probe_xd_automation` | diagnostic report of what XD exposes to UI Automation |

Existing tools are untouched: `xd_prototype_plan`, `xd_prototype_prepare`,
`xd_prototype_verify`, `xd_validate_prototype` remain the planning/manual/
verification path and keep returning `authoringSupported:false` for the plugin
API itself.

## Batch graph authoring

```
xd_prototype_plan (semantic planner, unchanged)
        ↓ planned / resolved edges
xd_create_prototype_graph
        ↓
runPrototypeGraphBatch (bridge/src/automation/batch.ts)
        ↓  edge 1 → adapter → UXP verify
        ↓  edge 2 → adapter → UXP verify
        ↓  … serial, never parallel
xd_validate_prototype (existing validator)
```

Input accepts any of:

* a flat edge list `[{source, target, trigger?, action?, transition?, duration?, mode?, sourceRole?}]`
* the resolved output of `xd_prototype_plan` (`sourceNode` / `targetArtboard`)
* a flow manifest `{name?, home?, edges[]}` — resolved with the existing planner;
  any unresolved edge aborts the batch before anything is authored (`unresolved_edges`)

Execution model:

| Rule | Behaviour |
|---|---|
| Serial | one adapter call at a time; the runner is single-flight by design |
| Per-edge truth | `created` / `already_exists` / `repaired` / `conflict` / `failed` / `skipped`, each with its own evidence |
| Idempotent | an existing identical edge returns `already_exists`; nothing is duplicated |
| Non-destructive by default | `mode=create` never edits or deletes existing wiring |
| Failure policy | `continue_on_error` (default) or `fail_fast`; skipped edges are reported, not dropped |
| Cancellation | checked **between** edges only (`shouldAbort`), never inside a UI transaction |
| Validation | runs the existing `xd_validate_prototype` with the GUIDs the edges actually resolved to |

### Modes

| Mode | Effect |
|---|---|
| `create` (default) | add missing wires only. A wire in the same trigger slot pointing elsewhere is a `conflict`, reported and left untouched. |
| `repair` | for a desired edge only: delete the blocking wire(s) in that trigger slot, **verify the deletion through UXP**, then create and verify the desired wire. Unrelated wires are never touched. |
| `reconcile` | same as `repair`, and non-desired same-slot wires from sources in the requested graph are treated as removable rather than blocking. |

Repair always executes `delete → verify deletion → create → verify creation`. A creation that fails
after a successful deletion is reported as `REPAIR_FAILED` with `xdModified: true` — the batch never
claims a graph it cannot read back.

### Platform constraints (verified live on XD 61.0.12.1)

These are Adobe XD's own rules, measured through the pane, not design choices:

| Constraint | Evidence |
|---|---|
| **One interaction per (source, trigger)** | With `tap` + `drag` already present, the trigger dropdown for a new interaction offered only `Time / Keys & Gamepad / Voice`; used triggers are not offered. A source therefore accepts at most one interaction per trigger (Tap, Drag, Time, Keys & Gamepad, Voice). |
| **The pane edits one interaction at a time** | A selection that already has wires shows only `Add Interaction` — existing interactions are never listed, and the property pane is not scrollable in that state (`PropertyPaneScrollView` reports not scrollable). |
| **No interaction deletion** | No delete/remove control exists in the Interaction pane, the `Object` menu has no interaction commands, and `Edit` only offers object Delete. A committed interaction's destination cannot be reset to the empty option (`(Choose an artboard)` is not offered once set). |
| **`Add Interaction` starts a fresh interaction** | It creates a new interaction whose destination is empty and whose trigger is the first unused one; it does not append a visible row. |
| **Trigger and action are coupled templates** | Setting the trigger to `Drag` immediately reset the action to `Auto-Animate`; setting the action back to `Transition` immediately reset the trigger to another free trigger (`Voice`) and cleared the transition. Only each trigger's default `(action, transition)` pair is authorable. |

Measured coupling sequence:

```
start:                 dest=Target10 trigger=Voice action=Transition transition=Dissolve duration=0.3 s
set trigger Drag    -> combo shows Drag
row now:               dest=Target10 trigger=Drag  action=Auto-Animate transition=      duration=
set action Transition -> combo shows Transition
row now:               dest=Target10 trigger=Voice action=Transition    transition=None  duration=
row settled (2.5 s):   dest=Target10 trigger=Voice action=Transition    transition=None  duration=
```

Consequences for the graph model: identity is correctly keyed by
`source | trigger | action | target | transition | duration`. "Many outgoing
interactions per source" is supported **per trigger**, not per arbitrary target.
Deleting or repointing an existing wire is not reachable through UI Automation,
so `mode=repair` / `reconcile` return `INTERACTION_DELETION_FAILED` with the
evidence above instead of pretending to delete.

Aggregate status: `success` (all edges verified **and** validation pass),
`already_exists` (nothing to create, everything present), `partial_success`
(any failure, conflict, skip, validation failure or source-scoped extra),
`failed` (nothing created and nothing already present).

Timing is reported per edge (`durationMs`) and in aggregate
(`timing.totalDurationMs / measuredEdges / averageEdgeDurationMs /
minEdgeDurationMs / maxEdgeDurationMs`). `timing.maxConcurrentEdges` is the
serial invariant measured inside the loop and must always be `1`.

**Graph shape constraint (current):** one outgoing interaction per source node.
XD supports several interactions on one node with different triggers, but this
stage deliberately does not author them: a second edge from the same source is
reported as `conflict` rather than stacked. Plans must therefore give each
source at most one edge (multi-action nodes are deferred).

### Measured baseline (XD 61.0.12.1, 16-screen planner-driven graph)

| Metric | Cold run | Warm run (identical graph) |
|---|---|---|
| Edges | 16 created, 16 verified | 16 already_exists |
| Total | 526.6 s | 0.15 s |
| Average edge | ~32.9 s | 7 ms |
| Min / Max edge | 32.5 s / 33.5 s | 6 ms / 8 ms |
| `maxConcurrentEdges` | 1 | 1 |
| Final validation | pass, coverage 1 | pass, coverage 1 |

The cold cost is dominated by per-edge UI transactions (focus, workspace check,
Layers selection, Add Interaction, destination paging, four field writes, UI
read-back) — each worker command is a process launch, and the destination list
paging is the slowest step. The warm run is pure document pre-check, which is
why idempotent re-runs are ~3 500× cheaper.

Extra detection: `validation.extraCount` is the validator's document-wide number
and is therefore reported verbatim; `validation.unexpected` is the graph-scoped
list of interactions **from a node this batch used as a source** that the batch
did not request (a genuine extra), while `validation.unexpectedOnTargets` lists
interactions from nodes that are only targets (context, not a graph error).
A non-empty `unexpected` prevents a `success` verdict.

## Known limitations

* **Batch scope: one interaction per source per run.** No multi-action nodes,
  overlays, component states, easing or scroll behaviour yet.
* **Serial execution only.** A batch of N edges costs N UI transactions; there is
  no bulk XD API to lean on, and parallel automation against XD is unsafe.
* **The document must be open.** The worker activates XD (`AttachThreadInput` +
  `SetForegroundWindow`) and verifies it; it fails with `XD_NOT_ACTIVE` instead
  of acting on a background window.
* **The Prototype workspace is required.** The Interaction pane does not exist in
  Design mode, so authoring switches workspace and reports
  `PROTOTYPE_MODE_FAILED` if the toggle is unavailable.
* **Artboard targets only.** Destination options are artboards; component states
  are not handled.
* **Virtualized destination list.** Only ~45 of N rows exist at once; the worker
  reveals later rows with `{END}` list navigation. A document with hundreds of
  artboards may need more paging than the current bounded loop (10 presses).
  `target_not_found` and `UI_CONTROL_MISSING` are reported separately, and a
  duplicate destination name is refused rather than guessed.
* **Duration is committed with Enter.** `ValuePattern.SetValue` alone does not
  commit XD's editable duration combo, so the worker focuses the field and sends
  `{ENTER}`. This is the only synthetic key in the flow.
* **Localised UI.** Only control AutomationIds and the English option labels
  (`Tap`, `Transition`, `Dissolve`) are matched; a localised XD build will report
  the available options in the failure message instead of guessing.
* **New MCP tools need a bridge restart** to appear in an already-running
  OpenCode session.
* XD's Layers list is virtualized; the worker reads realised rows and reports
  the row count it actually saw.
* **No deletion.** There is no supported way to remove a wire, so `conflict` is
  reported instead of overwriting, and an incomplete attempt must be finished or
  undone by hand. This also means a batch cannot "repair" a wrong edge.
* **Extras are scoped.** The validator's `extra` list is document-wide, so graph
  correctness additionally relies on the scoped `unexpected` list described
  above.

## Platform grammar (stage 6)

`bridge/src/automation/grammar.ts` is the single source of truth for what XD 61
can actually author. It is versioned (`xd-61.0.12.1/1`) and derived from live
runs, not from dropdown contents:

| Support | Meaning |
|---|---|
| `verified_supported` | UI accepted it, stayed stable, and two UXP read-backs agreed |
| `verified_unsupported` | the pane rejects or silently resets it (measured) |
| `conditionally_supported` | only the pane's default template for that trigger |
| `unverified` | never measured - treated as blocking by preflight |

Current rules (stage 7): `tap + Transition` (none/dissolve), `time + Transition`
(dissolve), `voice + Transition` (dissolve) are verified supported.
`drag + autoAnimate` is **conditionally supported** - the plugin reports it as
`action goToArtboard` + `transition autoAnimate` with **no duration**, and the
pane labels the Type as "Auto-Animate". `drag + dissolve/none/slide` is verified
unsupported (the pane resets one field when the other changes).
`Keys & Gamepad` is accepted by the request schema **only** so preflight can
classify it: the grammar marks it unauthorable and the adapter refuses it before
any UI command runs.

### Auto-Animate specifics (stage 7)

- Request it as `{ trigger: "drag", action: "goToArtboard", transition: "autoAnimate" }`.
- The adapter configures destination, trigger and Type ("Auto-Animate") and
  **skips the transition and duration steps** - setting them would reset the
  trigger (measured in stage 5).
- Verification compares the transition (`autoAnimate`) and skips the duration,
  which XD does not report for this interaction type.

Trigger slots are read from the grammar (`TRIGGER_SLOTS`), not hardcoded:
`tap, drag, time, keys, voice` exist, four are authorable. A source accepts one
interaction per trigger slot, so the planner must not emit two edges with the
same `(source, trigger)`.

## Preflight (stage 6)

`xd_validate_prototype_plan` classifies every planned edge **read-only**:

```
already_exists | safe_to_create | conflict | unsupported_combination |
unsupported_trigger | duplicate_trigger_slot | unresolved_source |
unresolved_target | unverified_combination
```

Every classification carries a reason and, where relevant, the blocking existing
interaction. `xd_create_prototype_graph` accepts `strictPreflight: true`, which
runs the same preflight and returns `status: "preflight_blocked"` with
`created: 0` when anything blocks - the document is never touched. The default
remains the backward-compatible non-strict behaviour.

## Performance (stage 6)

The worker runs as a **persistent process** (`-Serve`, JSON request per line,
one answer at a time). The one-shot process remains the fallback
(`XD_UIA_PERSISTENT=0` or after repeated spawn failures). Measured effect:
five consecutive `ping` commands took **12 ms** through the persistent runner
versus **945 ms** for a single one-shot spawn.

Per-edge timing is now split in every result:
`timing.resolveMs / focusMs / modeMs / selectMs / createMs / configureMs /
verifyMs`, aggregated from the stage records, alongside the existing batch
`timing` block (`maxConcurrentEdges` must stay 1).


### Keys & Gamepad (stage 7)

`keys` is now a legal input value in the plan/graph schema (`TRIGGERS`), but the
grammar keeps it unauthorable: no key-mapping control is exposed to UI
Automation and an interaction authored with that trigger never persisted.
Preflight returns `unsupported_trigger` for it, and the adapter refuses it at the
`platform_grammar` stage before touching the document.
