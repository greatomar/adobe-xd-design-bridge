# Apply Pending automation (Windows UI Automation)

DesignBridge queues every mutating UXP operation and executes the queue inside one
`application.editDocument` batch when the panel's **Apply** control is activated.
`xd_apply_pending` activates that control through Windows UI Automation so an
agent can complete a mutation cycle without the user clicking.

## What the panel exposes (measured, XD 61.0.12.1)

The panel is a UXP webview inside the right sidebar. Once the **Plugins** pane is
the active tab its DOM appears in the UIA tree with stable AutomationIds:

| AutomationId | Type | Values |
|---|---|---|
| `execBtn` | Button | `Apply` · `Apply N change(s)` · `Applying.` — disabled when the queue is empty or a batch is running |
| `queueInfo` | Custom | `Idle - nothing queued` · `N change(s) waiting` · `N change(s) ready - click anywhere in this panel to apply` · `Applying.` |
| `autoChk` | CheckBox | `Apply automatically` (default **On**) |

Two quirks shape the implementation:

- the panel **host** element reports `IsOffscreen=true` with an empty rect even
  when realised, so realisation is detected by the presence of `execBtn`
  (if absent, `toolbarPluginsPaneButton` is toggled to open the Plugins pane);
- `autoChk` is **On** by default, so any click inside the panel can execute the
  queue; the Apply click remains the explicit, deterministic trigger.

## State machine

```
idle             queueInfo "Idle..." or execBtn disabled   -> refuse, no click
pending          queueInfo "N change(s)..." + button enabled -> click
applying         queueInfo "Applying."                      -> refuse (duplicate guard)
completed        batchExecuted, results, all ok
partial_success  batchExecuted, results, some failed
failed           batchExecuted, results, all failed
timeout          no batchExecuted within timeout            -> never click again
unknown          panel missing / empty results / unreadable
```

A click alone is never success. Completion requires a `batchExecuted` event
**newer than the moment of the click**; the event carries no batch id, so
correlation is by timestamp — documented, not hidden. An event with
`results: []` is reported as `unknown`, never as success.

## Tools

| Tool | Returns |
|---|---|
| `xd_pending_status` | panel availability, `pendingCount` (from `queueInfo` only), button enabled/name, applying flag, last event age, and the source of each field |
| `xd_apply_pending` | `status`, `clicked`, `pendingBefore/After`, `executionStarted/Completed`, `executionResult`, `verification` (document counts), `timeout`, `errors`, `durationMs` |
| `xd_verify_pending` | event + per-op summary + document counts + verdict (`completed` / `stale-event` / `no-execution-event` / …) |

`pendingRequests` from the bridge is **not** the panel queue and is never used as
the pending count.

## Measured live run (UIA worker, before the MCP reload)

```
panel_state  : execBtn enabled, "Apply 1 change(s)",
               queueInfo "1 change(s) ready - click anywhere in this panel to apply"
click_apply  : clicked=true, observedStateChange="queue-changed",
               executionStartedObserved=true
panel_state  : execBtn disabled, "Apply", queueInfo "Idle - nothing queued"
batchExecuted: execute_batch ok -> create_artboard ok (guid fc7fe1bf-7c8f-4e28-b77e-48a55eeb36e0)
UXP read-back: 10 artboards, "ApplyPendingProbe" at 2400,1200 200x200
```

## Limitations

- Correlation is timestamp-based (the plugin emits no batch id).
- The panel must be realised; a closed panel is opened by toggling the Plugins
  pane, which changes XD's sidebar tab (a UI change, not a document change).
- Auto-apply can execute the queue on any panel interaction, so apply
  immediately after queueing.
- A timeout is reported, never retried automatically.
