# PrototypeAutomation (Windows UI Automation worker)

Small, isolated worker that performs the one operation Adobe XD's public plugin
API refuses to do: **creating a prototype interaction**.

```
DesignBridge (bridge/src/automation/adapter.ts)
        │  JSON command over a child process
        ▼
automation/PrototypeAutomation/uia-worker.ps1   (Windows PowerShell 5.1)
        │  UI Automation patterns only (Invoke / SelectionItem / Toggle /
        │  ExpandCollapse / Value) — no coordinate clicks
        ▼
Adobe XD 61 (MSIX, WinUI/XAML UI)  →  real prototype interaction
        ▲
        │  UXP read-back (get_prototype_state / validate_prototype)
        └── DesignBridge decides PASS/BLOCKED
```

## Why PowerShell 5.1 and not pywinauto/FlaUI

| Candidate | Verdict |
|---|---|
| **Microsoft UI Automation via `System.Windows.Automation`** (this worker) | **Chosen.** The same COM/UIA stack the other libraries wrap, in-box on every Windows install, no runtime to install. |
| pywinauto | Rejected: needs a Python runtime (not installed here) and would only wrap the same UIA providers. |
| FlaUI | Rejected: needs a .NET SDK (`dotnet` is absent; only the .NET Framework compiler is present) and adds a binary dependency for no extra capability over UIA. |
| AutoHotkey / raw SendInput | Rejected: coordinate/screen-scraping automation is exactly what must be avoided. |

The worker is not a framework: ~650 lines, one file, one command per invocation.

## What XD actually exposes (verified live on XD 61.0.12.1)

Exposed and addressable by AutomationId:| AutomationId | Control | Used for |
|---|---|---|
| `titlebarDesignButton` / `titlebarPrototypeButton` | ToggleButton | workspace switching |
| `toolbarNavigationPaneButton` | ToggleButton | open the Layers pane |
| `layersPaneOutlineView` | List | **semantic node selection** |
| `layersHeaderBackButton` | Button | navigate to the artboard list |
| `layerItem` (+ child `displayText`) | ListItem / Text | one row per node, name = layer name |
| `kInteractionPaneAddButtonId` | Button ("Add Interaction") | create the connector |
| `interactionPopoverTriggerEventPopup` | ComboBox | trigger (Tap/Drag/Time/Voice) |
| `interactionPopoverActionPopup` | ComboBox | action (Transition/Overlay/…) |
| `interactionPopoverTargetPopup` | ComboBox | destination artboard |
| `interactionPopoverTransitionPopup` | ComboBox | animation (None/Dissolve/…) |
| `interactionPopoverDurationCombo` | Edit | duration ("0.3 s") |
| `interactionPopoverPreserveScrollPositionCheckbox` | CheckBox | preserve scroll |

**Not** exposed: `canvasView` is a single `ControlType.Custom` element with
**0 children** — artboards, shapes and connector handles are canvas-rendered and
invisible to accessibility. That is why the wire is created through the
Interaction pane (Add Interaction + Destination) rather than by dragging a
connector, and why no screen coordinates are needed at all.

Two behaviours discovered live shape the implementation:

* the Interaction pane exists **only** in the Prototype workspace, and XD keeps a
  detached, **disabled** copy of its controls in the tree — so `editorOpen`
  requires the destination ComboBox to be *enabled*;
* the Destination dropdown is a **virtualized** popup (45 of 55 rows realised, no
  Scroll pattern), so later rows are revealed with `{END}` list navigation before
  `SelectionItemPattern.Select()`.

## Protocol

One invocation = one command:

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File uia-worker.ps1 -Base64 <base64 of {"cmd":"...","args":{...}}>
```

stdout is exactly one JSON line:

```json
{ "ok": true,  "cmd": "select_node", "result": { "uiaSelected": true, ... } }
{ "ok": false, "cmd": "set_field",   "error": { "code": "option_not_found", "message": "...", "stage": "..." } }
```

Commands: `ping`, `probe`, `focus_xd`, `ensure_mode`, `select_node`,
`read_interaction`, `add_interaction`, `list_options`, `set_field`,
`set_duration`.

Every action is followed by a bounded `Wait-Until` poll on an observable state
(toggle state, `ValuePattern`, selection state) — not a fixed sleep.

## Running things

```powershell
# diagnostics only (read-only, no document change)
powershell -NoProfile -ExecutionPolicy Bypass -File uia-worker.ps1 `
  -Base64 ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"cmd":"probe"}')))

# live acceptance: automation half only
powershell -NoProfile -ExecutionPolicy Bypass -File live-acceptance.ps1 `
  -Source "PrototypeTest/Source" -Target "PrototypeTest/Target"

# live acceptance: verification half (must be run through DesignBridge)
#   xd_validate_prototype { requiredConnections: [{ fromGuid: <source>, toGuid: <target>,
#                                                 trigger: "tap", action: "goToArtboard" }] }
```

`live-acceptance.ps1` writes every step's raw worker response to `evidence/`.
It prints `status: "AUTOMATION_ONLY"`, `verified: false` — by design. Only the
UXP read-back can report `verified: true`.

## Removal

Delete this directory and the two MCP tools (`xd_create_prototype_interaction`,
`xd_probe_xd_automation`) plus `bridge/src/automation/`. Nothing in the UXP
plugin, the scenegraph operations or the existing prototype tools depends on it.
