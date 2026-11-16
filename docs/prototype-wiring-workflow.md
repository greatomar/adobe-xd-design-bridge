# Prototype Wiring Workflow

XD's public UXP API cannot create, edit or delete a prototype wire. The `interactions` module is
read-only and `commands` has no wire setter. The bridge therefore ships a **wiring assistant**:
it resolves intent, moves the canvas to the right node, tells the human exactly what to draw, and
then proves whether the wire actually exists.

| Capability | Status |
|---|---|
| Prototype inspection — `xd_get_prototype_state` | Supported |
| Prototype validation — `xd_validate_prototype` | Supported |
| Wire authoring through the public XD API | **Unsupported — no API exists** |
| Manual wiring in XD Prototype mode | **Required** |
| MCP-assisted focusing, per-edge guidance and verification | Supported |

Every prototype tool returns `authoringSupported: false` and `createdWire: false`. If any output
ever suggests otherwise, it is a bug.

## Pipeline

```
design screens
→ name semantic interaction nodes      (Home/PrimaryCTA, Details/BookButton)
→ write the flow manifest
→ xd_prototype_plan                    resolve names → GUIDs, report ambiguity   [immediate]
→ xd_prototype_prepare                 QUEUED: select + pan to ONE source
→ the user clicks Execute pending, then draws the wire in XD Prototype mode
→ xd_prototype_verify                  per-edge verdict                          [immediate]
→ xd_validate_prototype                final pass/fail report                    [immediate]
```

`xd_prototype_plan`, `xd_prototype_verify` and `xd_validate_prototype` are read-only, so they run
immediately. `xd_prototype_focus` and `xd_prototype_prepare` must move the selection, and live XD
refuses `scenegraph.selection.items = [...]` outside `editDocument` with *"not permitted to make
changes from the background"*. They are therefore ordinary queued edits: the immediate reply is
`{queued:true, pending:N}` and the executed result arrives in `xd_get_operation_status`.

## Flow manifest schema

```json
{
  "name": "Main",
  "home": "Onboarding",
  "edges": [
    {
      "source": "Onboarding/GetStarted",
      "target": "Home",
      "sourceRole": "Onboarding/GetStarted",
      "trigger": "tap",
      "action": "goToArtboard",
      "transition": { "type": "dissolve", "duration": 0.3, "easing": "ease-out" },
      "note": "first-run entry"
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | no | flow name, echoed in reports |
| `home` | no | home artboard GUID or exact name; unresolved homes are reported |
| `edges[].source` | yes | source node GUID **or** exact semantic name (`Home/PrimaryCTA`) |
| `edges[].target` | yes | destination artboard GUID **or** exact artboard name |
| `edges[].sourceRole` | no | human label kept in reports |
| `edges[].trigger` | no | `tap` \| `drag` \| `time` \| `voice` (defaults to `tap` in the resolved plan) |
| `edges[].action` | no | `goToArtboard` \| `overlay` (defaults to `goToArtboard`) |
| `edges[].transition` | no | `{type, duration (0–10 s), easing}` — instruction text only |
| `edges[].overlay` | no | `{x, y}` — instruction text only |
| `edges[].preserveScrollPosition` | no | boolean |
| `edges[].note` | no | free text |

Limits: 1–500 edges; `source`/`target` ≤ 256 chars.

**Name nodes first.** The manifest refers to layer names, so renaming a node after planning silently
breaks that edge. `xd_prototype_plan` fails loudly when a name is missing, duplicated or ambiguous.

## 1. Plan — `xd_prototype_plan`

Resolves every edge against the live document using one `get_artboards` listing plus one
`search_nodes` per semantic source.

Returns:

- `edges[]` with `sourceNode{guid,name,type,resolvedBy}` and `targetArtboard{guid,name,resolvedBy}`
- `problems[]` with per-edge codes: `source-not-found`, `source-ambiguous`, `target-not-found`,
  `home-not-found`, `document_unavailable`
- `stats{edgeCount, readyCount, blockedCount, artboardCount}`

Ambiguity is reported, never guessed: two nodes sharing a name must be disambiguated with a GUID.

## 2. Prepare — `xd_prototype_prepare` (queued)

One connection at a time. Because it changes the selection, it runs inside `application.editDocument`
and therefore needs the panel's **Execute pending** click.

1. Validates the source node and the target artboard (the target must be an `Artboard`, not a group).
2. Reads the existing wires and classifies the intended edge.
3. Pans to the source with `viewport.scrollIntoView(node)`.
4. Selects the source node — **last**, because XD discards a selection followed by further work.
5. Reads the selection back inside the transaction and captures the viewport evidence.
6. Returns the instruction, e.g.:

```
In XD, switch to Prototype mode (the source node is already selected).
Drag the blue connector from "Home/PrimaryCTA" on artboard "Home" onto artboard "Details".
Set Trigger = tap, Action = Transition → "Details".
Transition = dissolve, duration 0.3s, easing ease-out.
This operation does not create the wire; it only prepares it.
```

### Selection states — `focusState`

The operation can only observe the state **inside** the edit transaction. It never reports `focused`.

| focusState | Meaning |
|---|---|
| `selection-assigned` | the assignment applied and the in-transaction read-back shows the node — `assignedTo` is set |
| `selection-failed` | the write threw or the read-back did not show the node — `selectionError` set |
| `focus-unverified` | `scenegraph.selection` is unreadable |
| `not-attempted` | prepare skipped focus because the wire already existed |

`wasSelectedBefore:true` means the node was already selected, so the call did not change anything.

**Ordering rule:** live XD keeps the selection only when it is the *last* scenegraph-affecting step
of the transaction. The operation therefore pans first and selects last; a pan after the assignment
silently discards it.

**Confirmation rule:** `focusState:"selection-assigned"` is not a focus claim. The result carries
`confirmationRequired:"read xd_get_selection after execution"`, and only that independent
post-commit read — performed after the batch returned — establishes that the node is selected.

### Viewport evidence

Panning uses the documented `viewport.scrollIntoView(node)`. `scrolled` is only `true` when
`viewport.bounds` actually changed between the before/after snapshots:

| code | Meaning |
|---|---|
| `viewport_moved` | `bounds` changed — `scrolled:true` |
| `already-in-view` | the node was already fully inside `bounds`; `scrollIntoView` is documented to do nothing |
| `viewport_change_unverified` | `bounds` readable but unchanged on synchronous read-back (the pan is animated) |
| `viewport_unsupported` / `viewport_unavailable` | method or module missing |
| `viewport_error` | the call threw |

An API call that merely did not throw is never reported as movement.

`status` tells you what to do next:

| status | Meaning | Next action |
|---|---|---|
| `ready` | no wire from this node | draw it |
| `already-wired` | the exact edge exists | nothing; verify and move on |
| `wrong-wire-present` | a wire exists to another destination | re-point it in XD |
| `wrong-trigger-present` | correct destination, wrong trigger | change the trigger |
| `wrong-action-present` | correct destination and trigger, wrong action | change the action |
| `incomplete-wire-present` | a wire with no destination | complete it |
| `ambiguous-wire-present` | duplicate matching wires | remove the duplicate |

## 3. Verify — `xd_prototype_verify`

Called after the human draws the wire. Treat "I created it" as a claim, not evidence.

| status | Meaning |
|---|---|
| `ok` | the exact edge exists |
| `missing` | no wire from this source at all |
| `incomplete` | a wire exists with no destination |
| `wrong-destination` | wires exist from this source but none to the target |
| `wrong-trigger` | reaches the target with a different trigger |
| `wrong-action` | reaches the target with a different action |
| `ambiguous` | more than one matching wire |

## 4. Validate — `xd_validate_prototype`

The final report is a real pass/fail gate, not a summary:

```json
{
  "verdict": "fail",
  "valid": false,
  "authoringSupported": false,
  "expected":  [{ "fromGuid": "…", "fromName": "Home/PrimaryCTA", "toGuid": "…", "toName": "Details", "trigger": "tap", "action": "goToArtboard", "status": "ok", "ok": true }],
  "detected":  [{ "fromGuid": "…", "fromName": "Home/PrimaryCTA", "toGuid": "…", "toName": "Details", "trigger": "tap", "action": "goToArtboard", "transition": null }],
  "missing":   [{ "fromGuid": "…", "toGuid": "…", "trigger": "tap" }],
  "incorrect": [{ "required": {}, "status": "wrong-destination", "candidates": [] }],
  "extra":     [{ "fromGuid": "…", "fromName": "Confirmation/Done", "toGuid": "…", "trigger": "tap", "action": "goToArtboard" }],
  "summary":   { "expectedCount": 7, "detectedCount": 6, "okCount": 6, "missingCount": 1, "incorrectCount": 0, "extraCount": 0, "coverage": 0.857 }
}
```

`extra` lists wires the manifest never declared — reported, never auto-deleted. `coverage` is the
share of expected edges that read `ok`.

## Concrete example: a 5-screen app

Screens: **Onboarding → Home → Details → Booking → Confirmation**.

1. Build all five screens as artboards, with tappable elements named by role:
   `Onboarding/GetStarted`, `Home/PrimaryCTA`, `Home/FeatureCard`, `Details/BackButton`,
   `Details/BookButton`, `Booking/ConfirmButton`, `Confirmation/Done`.
2. Write the manifest:

```json
{
  "name": "Main",
  "home": "Onboarding",
  "edges": [
    { "source": "Onboarding/GetStarted", "target": "Home", "trigger": "tap", "action": "goToArtboard", "transition": { "type": "dissolve", "duration": 0.3 } },
    { "source": "Home/PrimaryCTA", "target": "Details", "trigger": "tap", "action": "goToArtboard", "transition": { "type": "push", "easing": "ease-out" } },
    { "source": "Home/FeatureCard", "target": "Details", "trigger": "tap", "action": "goToArtboard" },
    { "source": "Details/BackButton", "target": "Home", "trigger": "tap", "action": "goToArtboard", "transition": { "type": "push", "easing": "ease-in" } },
    { "source": "Details/BookButton", "target": "Booking", "trigger": "tap", "action": "goToArtboard" },
    { "source": "Booking/ConfirmButton", "target": "Confirmation", "trigger": "tap", "action": "goToArtboard" },
    { "source": "Confirmation/Done", "target": "Home", "trigger": "tap", "action": "goToArtboard" }
  ]
}
```

3. `xd_prototype_plan` → expect `stats.readyCount === 7`. Fix any `source-ambiguous` first: two
   nodes named `Home/FeatureCard` is a naming bug, not a wiring problem.
4. For edge 0: `xd_prototype_prepare` → reply is `{queued:true, pending:1}` → click **Execute
   pending** → XD selects `Onboarding/GetStarted` and panning is attempted → read the executed result
   from `xd_get_operation_status` → draw the wire → `xd_prototype_verify` → `ok`.
5. Repeat for edges 1-6. `already-wired` means skip; `wrong-*-present` means fix in XD first.
6. Finish with `xd_validate_prototype` over all seven edges. Deliver only when `verdict: "pass"`.
   Otherwise report the exact remaining edges as manual wiring outstanding.

## What the assistant cannot do

- Create, re-point, retime or delete a wire or transition.
- Set the flow home artboard or publish a prototype link.
- Select a node without a panel execution click: XD forbids background selection writes.
- Prove that a smooth pan finished; only `viewport.bounds` deltas are evidence.
- Confirm that a drag visually "took" without a read-back — that is what `xd_prototype_verify` is for.

Live verification status: selection and viewport behaviour were exercised against a live XD 61
session. `scenegraph.selection.items` is rejected outside `editDocument`, which is why focus/prepare
are queued. A selection-only transaction was observed to **persist** after commit, while the same
selection followed by a `scrollIntoView` pan was **not** preserved — hence pan-first/select-last.
`viewport.scrollIntoView` exists and is animated, so a synchronous `bounds` read often cannot prove
movement and the result is reported as `viewport_change_unverified` rather than claimed as success.
