---
name: adobe-xd-specialist
description: "Technical reference for driving Adobe XD 61.0 through the AdobeXD-DesignBridge MCP tools: scenegraph facts, tool schemas, the panel execution queue, style mappings, failure modes, export and validation. Load before the first XD tool call and when diagnosing any XD failure."
---

# Adobe XD Specialist

Verified against the official XD 61 UXP reference and live runtime (plugin 2.0.0). The execution
contract (state machine, verification levels, stop conditions) lives in `agents/design.md` and is
not repeated here.

## 1. Document model — the two APIs that matter

| Need | Correct API | Never use |
|---|---|---|
| Document metadata | `application.activeDocument` → **`DocumentInfo` `{name, guid}`** | `.root`, `.path`, `.modified` (do not exist) |
| Scene root | **`scenegraph.root`** → `RootNode` | `activeDocument.root` |
| Selection | `scenegraph.selection.items` | — |
| Node by GUID | `scenegraph.getNodeByGUID(guid)` (lowercase) | tree walk only if that fails |

**`SceneNode.children` is a `SceneNodeList`, not an Array.** Verified: `Array.isArray()` is
`false`; `children[i]` does not work; use `children.at(i)`, `children.length`, and
`children.forEach()`. `filter/map/slice/find` are not guaranteed. The bridge normalises this
internally; the agent must not assume Array semantics when reasoning about counts.

Subclasses: Artboard, Rectangle, Ellipse, Polygon, Line, Path, BooleanGroup, Text, Group,
SymbolInstance, RepeatGrid, ScrollableGroup, LinkedGraphic, Lottie, Video, RootNode.
There is **no Component master class**.

## 2. Execution model — the panel queue

`application.editDocument(fn)` may only be called from a **panel UI event** (click, keydown,
mousedown, input, change, drop…) with the handler on the stack. Therefore:

1. Mutating operations are **queued** by the bridge and return `{queued:true, pending:N}`.
2. The panel executes the **entire queue** in one `editDocument` batch — one undo step — when the
   user clicks **"Execute pending (N)"** (or on the next panel interaction if auto-execute is on).
3. Results arrive as a `batchExecuted` event readable through `xd_get_operation_status`
   (`lastEvent.data.results[]`, per-op `ok`, `guid`, `error`).

Hard facts:

- The queue is **in panel memory**. Closing/reloading the panel **discards it silently**.
- `xd_get_operation_status` reports **bridge** `pendingRequests` and `lastEvent` only. It does
  **not** expose panel queue depth. A queued batch is invisible until it executes.
- There is no batch ID. Correlate by result shape + `lastEvent.at`.
- Read-only operations execute immediately, outside the queue.

## 3. Tool reference (verify against `docs/mcp-operation-schema.md`)

Read-only — execute immediately:

| Tool | Args | Returns |
|---|---|---|
| `xd_health` | — | bridge status, `xdConnected`, plugin version, last event |
| `xd_get_capabilities` | — | supported operations + plugin capabilities |
| `xd_get_document_info` | — | `{document:{name, guid, artboardCount, nodeCount, path:null, modified:null}}` |
| `xd_get_artboards` | — | artboards with `guid`, `name`, `frame` |
| `xd_get_selection` | — | selected nodes (empty array when nothing selected) |
| `xd_inspect_node` | `guid` | name, type, frame, fill, children summary, text props |
| `xd_search_nodes` | `query` and/or `type`, `limit` | matching nodes |
| `xd_inspect_design_consistency` | `tokens?` | off-token colours/sizes, small targets |
| `xd_get_prototype_state` | — | read-only flows + interactions with trigger/action/destination/transition details |
| `xd_prototype_plan` | `manifest{name?,home?,edges[{source,target,sourceRole?,trigger?,action?,transition?,overlay?}]}` | resolves semantic names → GUIDs; `source-not-found` / `source-ambiguous` / `target-not-found`; immediate |
| `xd_prototype_verify` | `sourceGuid`, `targetGuid`, `trigger?`, `action?` | per-edge verdict `ok` / `missing` / `incomplete` / `wrong-destination` / `wrong-trigger` / `wrong-action` / `ambiguous` |
| `xd_validate_prototype` | `requiredConnections[{fromGuid,toGuid,trigger?,action?}]` | full report: `expected`, `detected`, `missing`, `incorrect`, `extra`, `summary.coverage`, `verdict`; read-only |
| `xd_audit_screen` | `guid`, `requirements[{role,types?,requireNonEmptyText?}]` | semantic role coverage + real GUIDs/types/frames; structural only |
| `xd_validate_document` | — | default names, empty groups, zero-size nodes |
| `xd_export_artboard` | `guid` or `name`, `scale` 0.5–4 | base64 PNG + saved path + dimensions |
| `xd_export_selection` | — | base64 PNG of selection |
| `xd_preview_operation` | `operations[]` | dry-run validation/preview, no document change |

Mutating — queued until panel execution:

| Tool | Key args | Notes |
|---|---|---|
| `xd_create_artboard` | `name`, `frame{x,y,width,height}` | no background fill by default |
| `xd_prototype_focus` | `guid`, `targetGuid?` | QUEUED: `selection.items` throws outside `editDocument` in live XD. Pans first, selects last; returns `focusState` + `assignedTo` + `confirmationRequired`, never `focused` |
| `xd_prototype_prepare` | `sourceGuid`, `targetGuid`, `trigger?`, `action?`, `transition?`, `overlay?` | QUEUED: pan → select → instruction, reports `ready` / `already-wired` / `wrong-*-present`; creates no wire |
| `xd_create_rectangle` / `xd_create_ellipse` | `parent`, `name`, `frame`, `style` | solid or linear/radial/angular gradient fill; stroke, dash, caps, joins, radius, opacity, shadow, inner shadow, blur |
| `xd_create_line` | `parent?`, `start{x,y}`, `end{x,y}`, `style.stroke` | endpoints are parent-relative; stroke required |
| `xd_create_polygon` | `parent?`, `name`, `frame`, `cornerCount?`, `starRatio?`, `style?` | native Polygon or star |
| `xd_create_path` | `parent?`, `name`, SVG `pathData`, `x`, `y`, `style?` | path commands/coordinates only; not arbitrary SVG/XML |
| `xd_create_image` | `parent`, `frame`, `name?`, `scaleBehavior?` | native ImageFill Rectangle from user-selected PNG/JPEG/GIF; precise parent/frame |
| `xd_replace_image` | `guid`, `scaleBehavior?` | replace a native shape's ImageFill in place, preserving node GUID/frame |
| `xd_import_asset` | Artboard `parent`, `name?`, `x?`, `y?` | native XD importer/file picker on panel execution; no filesystem path accepted |
| `xd_create_text` | `parent`, `text`, `frame{x,y[,w,h]}`, `style` | see §4 for which style keys actually apply |
| `xd_create_group` / `xd_create_mask_group` | `guids[]` (≥2, same parent), `name?` | native commands; mask uses highest-z selected node |
| `xd_ungroup` | `guid` | `commands.ungroup()` |
| `xd_duplicate_node` | `guid`, `name?`, `offset?{x,y}` | `commands.duplicate()`; Artboard copies auto-place |
| `xd_delete_node` | `guid` | exact node removal; destructive, use only with explicit scope |
| `xd_reparent_node` | `guid`, `parent` | leaf nodes; unrotated 2D only, preserves position |
| `xd_rotate_node` | `guid`, `angle` | clockwise delta about local center |
| `xd_arrange_nodes` | `guids[]`, `action` | documented z-order commands |
| `xd_align_nodes` | `guids[]`, `action` | same-parent selection |
| `xd_distribute_nodes` | `guids[]`, `action` | ≥3 same-parent nodes |
| `xd_update_node` | `guid`, `name?`, `style?`, `visible?`, `locked?` | set artboard background via `style.fill` |
| `xd_move_node` | `guid`, `x`, `y`, `relative?` | artboard-relative coordinates |
| `xd_resize_node` | `guid`, `width?`, `height?`, `relative?` | |
| `xd_apply_style` | `guid` or `guids[]`, `style` | also the way to colour Text |
| `xd_update_text` | `guid`, `text?`, `style?` | same style caveats as `create_text` |
| `xd_apply_design_tokens` | `tokens{}` | stores tokens in `root.pluginData` only — see §5 |
| `xd_execute_operation` | `operation{}` | one op; queued for mutations |
| `xd_execute_batch` | `operations[]`, `dryRun?` | **flat** ops; one editDocument batch |

Batch shape — flat, never nested:

```json
{ "operations": [
  { "op": "create_rectangle", "parent": "<artboardGuid>", "name": "Card/Base",
    "frame": { "x": 24, "y": 120, "width": 342, "height": 180 },
    "style": { "fill": "#14171D", "cornerRadius": 12 } }
] }
```

Nesting params (`{"op":..., "params":{...}}`) is rejected by validation.

`xd_create_image` and `xd_import_asset` are asynchronous inside `editDocument`: click Execute
pending, choose a file in the native XD picker, then await the batch result. `create_image` builds
an ImageFill Rectangle under the exact parent. `import_asset` targets an Artboard through
`application.import`; supported picker types include PNG/JPEG/GIF/BMP/TIF/TIFF/AI/PSD/Lottie
JSON/MP4/TXT. SVG is not in `application.import`'s documented file list; use `create_path` for
editable vector geometry.

Unsupported (returns `supported:false`, do not plan around it): programmatic component masters
(`xd_create_component`) and component variants (`xd_create_component_variants`). The official
`interactions` module provides **read-only** prototype data; no documented public API creates,
edits, or deletes a wire. What *is* supported is a wiring assistant: `xd_prototype_plan` resolves a
manifest to GUIDs, `xd_prototype_prepare` (queued) pans then selects the source so a human can drag
the connector, and `xd_prototype_verify` / `xd_validate_prototype` prove the result afterwards.
`scenegraph.selection.items` is writable **only inside `editDocument`**, and live XD keeps the
selection only if it is the last scenegraph-affecting step of that transaction — pan first, select
last. The handler cannot observe the post-commit state, so `focusState:"selection-assigned"` is a
statement about the transaction, not a focus claim: confirm with an independent `xd_get_selection`.
`viewport.scrollIntoView(node)` pans; `viewport.bounds` / `viewport.zoomFactor` are the only readable
evidence of movement. Wire authoring is not exposed at all. Existing SymbolInstances can be inspected,
edited as overrides, and duplicated, but this is not equivalent to creating a master.

## 4. Style mapping — what actually applies

`Text.styleRanges` keys: `length`, `fontFamily`, `fontStyle`, `fontSize`, `fill`, `charSpacing`,
`underline`, `strikethrough`, `textTransform`, `textScript`. `lineSpacing` is a Text property.

| Intent | Works | Workaround when it does not |
|---|---|---|
| Text colour | `Text.styleRanges[].fill` or `xd_apply_style {style:{fill:"#RRGGBB"}}` | v1.0.3 applies the documented fill key |
| Text weight | `style.fontStyle` → `Text.styleRanges[].fontStyle`; `fontWeight` compatibility alias | prefer `fontStyle`; verify font availability |
| Line height | `style.lineHeight` → `Text.lineSpacing` | separate text nodes for independently styled lines |
| Letter spacing | `style.charSpacing` (1/1000 em) | — |
| Shape fill/stroke/radius/opacity/shadows/blur | `style` on create, or `xd_apply_style` | `strokeWidth` needs `stroke`; inner shadow is unsupported on some node types |
| Gradient fill | `style.gradient {type,colorStops,...geometry}` | linear/radial/angular; not valid on Text; `fill` and `gradient` cannot be combined in one style |
| Artboard background | `xd_update_node {style:{fill}}` | artboards created by the bridge have `fill:null` |
| Alignment | `style.textAlign` (left/center/right) | XD docs do not list justify |

Verify typography by exporting and looking at the image — XD falls back silently for missing
fonts and ignores unknown range keys.

## 5. Design tokens — honest scope

`xd_apply_design_tokens` validates the token JSON, then stores it on the root node's
`pluginData` (`stored:true`). It does **not** create XD colour swatches, character styles or
document assets — the public API exposes no such creation. Report it as "tokens recorded +
applied per node", never as native styles.

Contrast report: the bridge pairs keys named `text/*` with `bg/*`. Use that naming or the report
is empty. Every token entry needs a string `value`; typography entries also need numeric
`fontSize` for `xd_inspect_design_consistency` audits.

## 6. Verified failure modes and their codes

| Code / symptom | Meaning | Correct response |
|---|---|---|
| `no_active_document` | plugin instance has no document | re-open/attach the panel; re-check `xd_get_document_info` |
| `no_scenegraph_root` | `scenegraph.root` unavailable/malformed | reload the plugin; do not retry writes |
| `node_not_found` | GUID not in the tree | re-read artboards; never guess a replacement |
| `artboard_not_found` | export target missing | list artboards, fix name/guid |
| `unsupported` | XD API cannot do it | document the limitation, use the documented alternative |
| `xd_not_connected` | panel not connected to the bridge | ask the user to connect the panel |
| `timeout` | plugin did not answer | treat execution state as **unknown**; read back before any retry |
| `plugin_exception` | handler threw inside XD | read the message, fix the argument, re-queue only unapplied work |

## 7. Geometry, export and canvas notes

- Child coordinates are artboard-relative; artboard children start at `(0,0)`.
- Artboards created programmatically appear at the requested x/y but XD does not scroll there;
  no MCP operation moves the viewport. Report coordinates to the user.
- Exports use `application.createRenditions` (not `exportAsync`), written to a temp file, read as
  bytes, returned as base64 and saved under `exports/`. Scale is 0.5–4.
- `xd_validate_document` checks default names, empty groups and zero-size nodes only (no guides,
  no overflow detection).

## 8. Quality gate

Before any delivery claim: every referenced GUID exists, every screen has ≥1 exported PNG whose
image was actually inspected, no default layer names, colours/sizes from the token set, no empty
groups, and the verification level (1–7) is stated per screen.

## Prototype grammar and preflight (XD 61.0.12.1, measured)

- **One interaction per trigger slot per source.** Slots: `tap`, `drag`,
  `time`, `keys` (Keys & Gamepad), `voice`. Only four are authorable.
- **Trigger, action and transition are coupled templates.** Changing the trigger
  resets the action to that trigger's default; changing the action resets the
  trigger. Measured: `tap/Transition`, `time/Transition`, `voice/Transition` are
  `verified_supported`; `drag/Transition` is `verified_unsupported` (drag only
  authors its default Auto-Animate).
- **Existing wires are not addressable.** A selection that already has
  interactions shows only `Add Interaction`; there is no delete control and no
  interaction commands in the Object/Edit menus. Deletion and automatic repair
  are therefore unavailable - say so instead of promising them.
- **Always preflight first.** `xd_validate_prototype_plan` is read-only and
  classifies every edge (`already_exists`, `safe_to_create`, `conflict`,
  `unsupported_combination`, `unsupported_trigger`, `duplicate_trigger_slot`,
  `unresolved_source`, `unresolved_target`, `unverified_combination`).
  `xd_create_prototype_graph { strictPreflight: true }` creates nothing when a
  blocker exists.
- **Timing**: ~30 s per cold edge, ~7 ms per already-existing edge; the worker is
  persistent, so repeated commands inside one batch are much faster than
  process-per-command.

### Schema notes (stage 7)

- `drag` interactions are requestable as `{ trigger: "drag", transition: "autoAnimate" }`.
  XD shows the Type as "Auto-Animate", reports `action goToArtboard` +
  `transition autoAnimate`, and has **no duration** - so the adapter configures
  destination, trigger and type only.
- `keys` is accepted by the schema so preflight can classify it, but it is
  `unsupported_trigger`: never author it, and never invent a key mapping.

## Apply Pending (stage 8, measured)

The panel's queue is in the UXP webview; the bridge cannot read it. The live
view is Windows UI Automation on the panel DOM:

| AutomationId | Type | Values |
|---|---|---|
| `execBtn` | Button | `Apply` · `Apply N change(s)` · `Applying.` (disabled when idle/executing) |
| `queueInfo` | Custom | `Idle - nothing queued` · `N change(s) waiting` · `N change(s) ready - click anywhere in this panel to apply` · `Applying.` |
| `autoChk` | CheckBox | `Apply automatically` (default ON) |

- The panel host reports `IsOffscreen=true` with an empty rect even when
  realised - detect realisation by the presence of `execBtn`. If missing, toggle
  `toolbarPluginsPaneButton` to open the Plugins pane.
- Completion is the plugin's `batchExecuted` event. It carries **no batch id**:
  correlate by "newest event newer than the click". An event with `results: []`
  is NOT success - report it as unknown.
- Auto-apply is ON by default: any click inside the panel can execute the queue.
- Tools: `xd_pending_status` (read), `xd_apply_pending` (state-driven click +
  wait), `xd_verify_pending` (event + document evidence).

## Visual quality + geometry pitfalls (stage 9, measured)

- `update_node` has no `frame` parameter. Before 1.1.6 it accepted `frame` and
  reported `ok:true` without changing anything; 1.1.6+ rejects geometry with
  `UNSUPPORTED_PROPERTY` (and unknown keys with `UNKNOWN_PROPERTY`). Use
  `move_node` / `resize_node`.
- `update_node {visible}`/`{locked}` were also silently dropped by a nested-value
  bug in the same validation; fixed in 1.1.6 and covered by a test. Re-read the
  node after toggling visibility.
- `move_node` / `resize_node` coordinates are artboard-relative. For a direct
  artboard child that equals parent-relative; for a child of a Group it does NOT
  (measured: group child in an artboard at y=5000 moved to y=20 landed at 5020).
  Absolute document coordinates put an artboard child outside its artboard and
  reparent it to the pasteboard.
- Geometry results carry `before`/`after`/`delta`, `coordinateSystem`
  (`artboard-relative`) and `origin`; a move result with `safe:false` means the
  node is outside its artboard.
- `resize_node` verifies the applied size within 0.5 px and returns
  `MUTATION_VERIFICATION_FAILED` when the host ignored it; text reflow is
  reported as `reflowed:true`.
- `reparent_node` reads the parent back and returns `verified:true` only when the
  relationship actually changed; otherwise `MUTATION_VERIFICATION_FAILED`.
  Membership is checked directly (a recursive old-parent search falsely fails
  when the new parent is nested inside the old one), and `geometryPreserved` /
  `positionPasses` report the absolute-position outcome.
- `xd_inspect_node` is paginated: `childrenTotal` is authoritative,
  `hasMore`/`nextOffset` say whether the page is complete, and `limit`/`offset`
  are validated (1..500 / >= 0). Never treat a page as the full list.
- RTL text frames must satisfy `x + width = right margin` (370 for a 390 pt
  artboard with 20 pt margins), otherwise right-aligned Arabic looks centred.
- Image import (`create_image`, `replace_image`, `import_asset`) requires the
  native XD file picker: not automatable unattended. Placeholders stay flat
  colour shapes and must be described as such.
- Visual acceptance requires exporting and looking at the PNG; API geometry and
  `xd_validate_document` cannot prove visual quality.
