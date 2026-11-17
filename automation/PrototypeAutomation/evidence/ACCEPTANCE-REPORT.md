# Live acceptance report — prototype interaction via Windows UI Automation

Date: 2026-11-17
Host: Windows, Adobe XD 61.0.12.1 (MSIX: `C:\Program Files\WindowsApps\Adobe.XD_61.0.12.1_x64__pc75e8sa7ep4e\XD.exe`)
Automation provider: **Windows UI Automation** (`System.Windows.Automation`, in-box .NET Framework, driven by PowerShell 5.1)
Verification authority: **DesignBridge UXP read-back** (`xd_get_prototype_state`, `xd_validate_prototype`)

## Stage 5 — multi-interaction sources, deletion, repair (fresh document)

Document: `Untitled — November 17, 9.34.46 PM` (`abc10fc5-5006-4532-bd82-37b62d9a7dea`), initially one empty artboard.
Fixture: `PrototypeMultiTest/` — 21 artboards (SourceA, Target1…Target17, ConflictSource, WrongTarget,
CorrectTarget) created with one queued `execute_batch` + one panel Apply.

### Result: partially delivered — two capabilities are blocked by Adobe XD itself

| Capability | Outcome |
|---|---|
| Multiple outgoing interactions from one source | **WORKS**, but one per trigger. `SourceA` holds 4 verified interactions: `tap→Target1`, `drag→Target2`, `time→Target3`, `voice→Target5`. |
| 17 × Tap from one source | **NOT EXPRESSIBLE in XD.** With tap+drag present, the trigger dropdown for a new interaction offered only `Time / Keys & Gamepad / Voice`. |
| Conflict detection | **WORKS** (identity keyed by source\|trigger\|action\|target\|transition\|duration). |
| Wire deletion | **BLOCKED.** No delete/remove control in the pane, no interaction commands in the `Object`/`Edit` menus, and a committed destination cannot be reset to the empty option. |
| Conflict repair | **BLOCKED** as a direct consequence: repair requires deletion. `mode=repair` fails with `INTERACTION_DELETION_FAILED` and the evidence above. |

### Exact evidence

Pane state for a selection that already has wires (no list of them):

```json
{"ok":true,"result":{"rows":[]},"cmd":"list_rows"}
```
(subtree of `kInteractionPaneContainerId` = `INTERACTION` label + `Add Interaction` button only)

Trigger options for a new interaction while `tap` + `drag` exist:

```json
{"ok":false,"error":{"code":"option_not_found","message":"'Tap' is not an option of trigger. Realised options: Time | Keys & Gamepad | Voice"}}
```

Destination cannot be cleared back to the empty option:

```json
{"ok":false,"error":{"code":"option_not_found","message":"'(Choose an artboard)' is not an option of destination. Realised options: None | iPhone 14 Pro Max - 1 | PrototypeMultiTest/Target1 | …"}}
```

Resulting document state (UXP read-back, authoritative):

```json
{"source":"PrototypeMultiTest/SourceA","interactions":[
  {"trigger":"tap","destination":"PrototypeMultiTest/Target1","transition":"none"},
  {"trigger":"drag","destination":"PrototypeMultiTest/Target2","transition":"autoAnimate"},
  {"trigger":"time","destination":"PrototypeMultiTest/Target3","transition":"dissolve","duration":0.3},
  {"trigger":"voice","destination":"PrototypeMultiTest/Target5","transition":"dissolve","duration":0.3}]}
```

Note: a `Keys & Gamepad` interaction was created and configured to `Target4`, but it did not persist
in the document (no `keys` record in the read-back); an unconfigured key mapping is the likely cause
and is not yet investigated.

### What this means for the graph model

The implemented identity key (`source|trigger|action|target|transition|duration`) is the correct
grammar for XD: several interactions per source are legal **as long as each uses a different
trigger**. A desired graph asking for 17 taps from one node is not authorable in XD by any means,
UI automation or plugin API.

Deletion/repair remain implemented up to the platform boundary: the adapter re-reads UXP after any
delete attempt and reports `INTERACTION_DELETION_FAILED` / `REPAIR_FAILED` with `xdModified`
accurate, so a caller is never told a wire was removed when it was not.

## Stage 4 — real planner-driven graph (16 screens, through the real MCP server)

Fixture: `PrototypeIntegrationTest/` — 16 isolated artboards at y = 15000, created with one
queued `execute_batch` + one panel Apply.

```
Welcome → Login → Home → Search → SearchResults → Details → Booking → BookingDetails
        → Payment → Success → Home
Favorites → Details · Profile ⇄ Settings · Notifications → Home · Help ⇄ HelpArticle
```

16 nodes / 16 edges (one outgoing edge per node — multi-action nodes are deferred).

Planner: `xd_prototype_plan` → `edgeCount 16, readyCount 16, blockedCount 0, problems []`.
The resolved `edges[]` array is what `xd_create_prototype_graph` consumed (one mechanical
unwrap of `transition: {type,duration}` → `type`, because the running server's schema predates
object transitions; the schema has since been widened and the batch normaliser accepts both).

| Run | created | already_exists | conflicts | failed | skipped | wall clock |
|---|---|---|---|---|---|---|
| Cold, half 1 (edges 1–8) | 8 | 0 | 0 | 0 | 0 | 263.8 s |
| Cold, half 2 (edges 9–16) | 8 | 0 | 0 | 0 | 0 | 262.8 s |
| Cold, combined | **16** | 0 | 0 | 0 | 0 | **526.6 s** |
| Identical repeat | **0** | **16** | 0 | 0 | 0 | **150 ms** |

Per-edge timing (cold): average 32 970 ms / 32 843 ms per half, min 32 525 ms, max 33 491 ms.
`timing.maxConcurrentEdges = 1` in every run. Warm run: average 7 ms (document pre-check only).

Final validation on the planner's 16 resolved GUID pairs:

```json
{ "verdict": "pass", "coverage": 1, "expectedCount": 16, "okCount": 16,
  "missingCount": 0, "incorrectCount": 0, "extraCount": 77 }
```

`extraCount` is document-wide and is not used as the graph criterion; graph-scoped
`unexpected = 0` and `unexpectedOnTargets = 0` for the planned graph. Every one of the 16 graph
nodes holds exactly one interaction (no duplicates); the document totals 93 interactions
(71 pre-existing + 2 + 4 + 16) and 75 artboards.

### Conflict + policy (live, after reload)

| Request | Policy | Result |
|---|---|---|
| `Details → Payment` (exists: `Details → Booking`) | `continue_on_error` | `conflict` with the actual wire, next 2 edges `already_exists`, `partial_success`, validation `coverage 0.667 / incorrect 1`, scoped `unexpected` 1 |
| same | `fail_fast` | `aborted: true`, `processed: 1`, remaining 2 `skipped` ("fail_fast stopped at edge 1 (conflict)"), no authoring |
| 3 edges, middle source missing | `continue_on_error` | `already_exists`, `SOURCE_NOT_FOUND`, `already_exists` — neighbours verified, validation `pass / coverage 1` |

## Stage 3 — batch graph authoring (through the real MCP server)

Fixture (isolated, created with one queued `execute_batch` + one panel Apply):

| Node | GUID |
|---|---|
| `PrototypeBatchTest/ScreenA` | `2fe19812-863a-41de-a980-81381cbf4841` |
| `PrototypeBatchTest/ScreenB` | `b04e76a2-71d2-4dcc-bd86-95d0ed9a3991` |
| `PrototypeBatchTest/ScreenC` | `44d6de66-2ce7-4d9c-b887-cb58d3230ba2` |
| `PrototypeBatchTest/ScreenD` | `28b795c7-9bc0-41fe-8856-d601003d2e55` |

Requested graph: `A→B, B→C, C→D, D→A` — tap / transition / dissolve / 0.3 s.

| Run | Result | Summary | Validation |
|---|---|---|---|
| 1 (first attempt) | `failed` (reported) | 0 created / 0 already / 0 conflict / 4 failed | `fail`, coverage 0.75, missing 1 |
| 2 (after transport fix) | `success` | **1 created**, 3 already_exists, 0 failed | `pass`, coverage 1, missing 0, incorrect 0, unexpected 0 |
| 3 (identical repeat) | `already_exists` | **0 created**, 4 already_exists | `pass`, coverage 1, missing 0, incorrect 0 |

Run 1 is the most valuable evidence of the verification rule: the automation reported four
failures, but `xd_validate_prototype` showed three of the four wires existed with exactly the
requested properties (coverage 0.75). The automation was wrong, the document was not — and the
UXP read-back is what caught it. Root cause: the worker's `Wait-Until` helper used a local
`$value`, which PowerShell treats as the same variable as the caller's expected `$Value`
(case-insensitive), so every destination comparison ran against `$null`. Fixed by renaming the
helper's local and adding an editor-reopen recovery inside `set_field` / `set_duration`.

Final document state after run 3:

```json
{
  "perSourceEdges": {
    "A": ["ScreenB (tap/dissolve/0.30s)"],
    "B": ["ScreenC (tap/dissolve/0.30s)"],
    "C": ["ScreenD (tap/dissolve/0.30s)"],
    "D": ["ScreenA (tap/dissolve/0.30s)"]
  },
  "validation": { "verdict": "pass", "okCount": 4, "missingCount": 0, "incorrectCount": 0, "coverage": 1 },
  "totalInteractions": 77,
  "document": { "artboards": 59, "nodes": 2449 }
}
```

One interaction per fixture node → the repeated run created no duplicates. 77 interactions =
71 pre-existing + 2 (`PrototypeTest`) + 4 (`PrototypeBatchTest`); the user's design was untouched.

### Conflict and failure policy (live)

| Scenario | Result |
|---|---|
| `A→C` while `A→B` exists, `continue_on_error` | edge 0 **conflict** with the actual interaction (`A→B`), edge 1 `already_exists`, status `partial_success`, validation `fail / coverage 0.5 / incorrect 1`, source-scoped `unexpected` = 1 |
| `DoesNotExist→A` first, `fail_fast` | `aborted: true`, `processed: 1`, remaining edges `skipped` with reason, `validationSkippedReason` explaining nothing resolved |
| `fail_fast` + conflict | unit-tested (`fail_fast also stops on a conflict`); the running MCP server still holds the previous batch module, so this specific combination becomes live on the next restart |

### Scalability note

The destination list carried 59 artboards (60 options incl. the placeholder); the fixture screens
were the last created and were reached by the bounded `{END}` paging path, i.e. the virtualized
list handling works beyond the 55-artboard case it was built against.

## Stage 2 — single interaction (through the real MCP server)

`xd_create_prototype_interaction { source: "PrototypeTest/Source", target: "PrototypeTest/Target" }`

```json
{ "ok": true, "status": "already_exists", "created": false, "verified": true,
  "verification": { "verdict": "ok", "problems": [] },
  "stages": ["resolve_source", "resolve_target", "precheck"] }
```

<!-- Legacy stage-1 evidence retained below. -->

## Fixture (stage 1)

| Role | Name | GUID | Frame |
|---|---|---|---|
| Source | `PrototypeTest/Source` | `9066bbbe-df3b-4c08-8b7d-d96731e7b924` | 0,13000 320×480 |
| Target | `PrototypeTest/Target` | `a490da3e-fc77-4ddd-b57c-35039cd0c576` | 520,13000 320×480 |

Both artboards were created through the existing DesignBridge creation path (one queued
`execute_batch`, one panel "Execute pending" click — the only user interaction required).

## Result: PASS

Two native interactions now exist in the document, created without dragging a connector and
without manual configuration:

```json
[
  {
    "source": "PrototypeTest/Source", "sourceGuid": "9066bbbe-df3b-4c08-8b7d-d96731e7b924",
    "trigger": "tap", "action": "goToArtboard",
    "destination": "PrototypeTest/Target", "destinationGuid": "a490da3e-fc77-4ddd-b57c-35039cd0c576",
    "transition": "dissolve", "duration": 0.30000001192092896, "easing": "linear"
  },
  {
    "source": "PrototypeTest/Target", "sourceGuid": "a490da3e-fc77-4ddd-b57c-35039cd0c576",
    "trigger": "tap", "action": "goToArtboard",
    "destination": "PrototypeTest/Source", "destinationGuid": "9066bbbe-df3b-4c08-8b7d-d96731e7b924",
    "transition": "dissolve", "duration": 0.30000001192092896, "easing": "linear"
  }
]
```

`xd_validate_prototype` with both required connections:

```json
{
  "verdict": "pass",
  "summary": { "expectedCount": 2, "okCount": 2, "missingCount": 0, "incorrectCount": 0, "coverage": 1 },
  "expected": [
    { "from": "PrototypeTest/Source", "to": "PrototypeTest/Target", "ok": true, "status": "ok" },
    { "from": "PrototypeTest/Target", "to": "PrototypeTest/Source", "ok": true, "status": "ok" }
  ]
}
```

## Stage checklist (from the last full run, `evidence/live-20261117-203807.json`)

| Stage | Result | Evidence |
|---|---|---|
| probe (XD window detected) | PASS | `xdWindowFound: true`, processId 1272, `canvasChildCount: 0` |
| focus_xd | PASS | `foregroundVerified: true`, `keyboardFocus: true`, hwnd 394234 |
| switch to Prototype workspace | PASS | `toggleAfter: "On"`, `otherToggle: "Off"` |
| source selection (Layers row) | PASS | `uiaSelected: true`, rowText `PrototypeTest/Source` |
| selection confirmed by UXP | PASS | `xd_get_selection` → `9066bbbe…` |
| Add Interaction | PASS | `alreadyOpen: true, added: false` (idempotent — no duplicate) |
| destination selection | PASS | combo value `PrototypeTest/Target` |
| trigger configuration | PASS | UI value `Tap` |
| action configuration | PASS | UI value `Transition` |
| transition configuration | PASS | UI value `Dissolve` |
| duration configuration | PASS | UI value `0.3 s` |
| native interaction exists | PASS | UXP read-back above |
| semantic verification | PASS | `xd_validate_prototype` verdict `pass`, coverage 1 |

A from-scratch creation through the same sequence
(`evidence/live-20261117-203847.json`, source `PrototypeTest/Target`) produced the second edge.

## What the live run discovered (and the adapter now relies on)

1. **The Interaction pane exists only in the Prototype workspace.** In Design mode the pane
   subtree is absent and the controls are not usable (`enabled: false`). The adapter switches
   workspace first and reports `PROTOTYPE_MODE_FAILED` if it cannot.
2. **A detached, disabled copy of the editor controls stays in the visual tree.** Presence is
   not evidence; `editorOpen` requires the destination ComboBox to be *enabled*.
3. **`Add Interaction` is safe to retry.** Re-selecting a node that already has an interaction
   shows the existing editor, and the worker returns `alreadyOpen: true` instead of pressing
   Add again — no duplicate wires (C8 proved this at the document level: one edge per source).
4. **The Destination dropdown is a virtualized ComboBox popup** containing 45 realised rows of
   55 artboards, with no Scroll pattern exposed. Later rows are reached with `{END}` keyboard
   navigation (documented list navigation), then `SelectionItemPattern.Select()` commits.
5. **Duration commits with Enter.** `ValuePattern.SetValue("0.3 s")` alone does not commit; the
   worker focuses the field and sends `{ENTER}` — the only synthetic key in the flow.
6. **Window activation needs `AttachThreadInput` + `SetForegroundWindow`.** Plain
   `SetForegroundWindow` is refused by the Windows foreground lock while the terminal holds
   focus; activation is verified with `GetForegroundWindow() == hwnd`.
7. **XD remembers the last used duration** as the default for new interactions (0.3 s after the
   first run), so the editor must always be read back rather than assumed.
8. **`canvasView` has zero UIA children** — canvas objects and connector handles are not in the
   accessibility tree, which is why selection uses the Layers list and wiring uses the
   Interaction pane instead of a drag.

## Reproduce

```powershell
# automation half (writes evidence/live-<ts>.json)
powershell -NoProfile -ExecutionPolicy Bypass -File `
  automation/PrototypeAutomation/live-acceptance.ps1 `
  -Source "PrototypeTest/Source" -Target "PrototypeTest/Target"

# verification half (through the running DesignBridge MCP server)
#   xd_validate_prototype { requiredConnections: [
#     { fromGuid: "9066bbbe-df3b-4c08-8b7d-d96731e7b924",
#       toGuid:   "a490da3e-fc77-4ddd-b57c-35039cd0c576",
#       trigger: "tap", action: "goToArtboard" } ] }
```

## Limitations of this acceptance

* The one-call MCP entry point (`xd_create_prototype_interaction`) is implemented and
  integration-tested, but the MCP server that this session is connected to was started before the
  tool existed, so the live run above drives the same worker commands through
  `live-acceptance.ps1`. Restarting the DesignBridge MCP server loads the tool and the identical
  flow runs from a single call (against these fixtures it will report `already_exists`).
* One interaction per call; no multi-edge or full-graph authoring yet.
* English option labels only (`Tap`, `Transition`, `Dissolve`); a localised build reports the
  real option list instead of guessing.

