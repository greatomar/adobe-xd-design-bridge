# MCP operation schema reference

Authoritative reference for the `adobe-xd` MCP server, derived from
`bridge/src/tools.ts` and `bridge/src/operations.ts` (source of truth). Regenerate this file when
the tool registry changes.

## Response envelope

Success: `{ "ok": true, ...payload }`
Failure: `{ "ok": false, "code": "...", "error": "human-readable message" }`
Codes: `xd_not_connected`, `timeout`, `unsupported`, `plugin_error`, `plugin_exception`,
`validation failed before execution` (batch), plus plugin-side `no_active_document`,
`no_scenegraph_root`, `node_not_found`, `artboard_not_found`, `outside_edit_context`,
`invalid_parent`, `unsupported_reparent`, `user_cancelled`, `import_no_nodes`.

Mutating tool success is **not** a document change: `{ "ok": true, "queued": true, "op": "...",
"pending": N }` means the operations sit in the plugin panel queue.

## Validation limits

| Field | Constraint |
|---|---|
| `frame.width` / `frame.height` | 0.1 – 20000 |
| `style.strokeWidth` | 0 – 1000 (requires `stroke`) |
| `style.cornerRadius` | 0 – 10000 |
| `style.opacity` | 0 – 1 |
| `style.shadow` | `{x,y,blur>=0,color}` all required |
| `style.fill` / `style.stroke` | hex string (`#RGB`, `#RRGGBB`, `#RRGGBBAA`) |
| `text` | string, ≤ 8192 chars |
| `name` | string, ≤ 256 chars |
| `search.limit` | 1 – 500 (default 50) |
| `export.scale` | 0.5 – 4 (default 2) |
| `operations[]` (batch) | 1 – 100 |

## Read-only tools (execute immediately)

| Tool | Arguments | Response | Verification |
|---|---|---|---|
| `xd_health` | — | `bridge.version`, `link.{listening,port,xdConnected,pendingRequests,pluginInfo{version,capabilities},lastEvent}` | `xdConnected:true`, version check |
| `xd_get_capabilities` | — | `bridgeOperations[]`, `pluginCapabilities[]`, note | operation availability |
| `xd_get_document_info` | — | `document{name,guid,artboardCount,nodeCount,path:null,modified:null}`, `notes[]` | counts after batch |
| `xd_get_artboards` | — | `{documentName,count,artboards[{guid,name,frame{x,y,width,height}}]}` | child-count/parent checks |
| `xd_get_selection` | — | `selection[{guid,name,type,frame}]` | export target |
| `xd_inspect_node` | `guid` | `node{guid,name,type,frame,visible,locked,childCount,fill,stroke,opacity,markedForExport,children[],…text}` | LEVEL 4 read-back |
| `xd_search_nodes` | `query?`, `type?`, `limit?` (one of query/type required) | `nodes[]` | find by name/type |
| `xd_get_prototype_state` | — | `{flows[], interactions[]}` | read-only prototype inspection; authoring unavailable |
| `xd_validate_prototype` | `requiredConnections[{fromGuid,toGuid,trigger?,action?}]` | `valid`, per-edge results, `authoringSupported:false` | checks expected edges against existing XD wires; no edits |
| `xd_audit_screen` | `guid`, `requirements[{role,types?,requireNonEmptyText?}]` | `complete`, `roles[]`, `missingRoles[]`, stats | every listed type is required for that role; structural only, not visual QA |
| `xd_inspect_design_consistency` | `tokens?` | `findings[]`, `usage{colors,fontSizes}` | LEVEL 6 audit |
| `xd_validate_document` | — | `findings[]` (default-name, empty-group, zero-size) | structural gate |
| `xd_export_artboard` | `guid` **or** `name`, `scale?` | MCP image content + `{path,width,height,scale}` | LEVEL 5 |
| `xd_capture_design_preview` | `name` (required) | 1x PNG content + path | quick look |
| `xd_export_selection` | — | PNG of `selection.items[0]`; `ok:false` when empty | component spot-check |
| `xd_preview_operation` | `operations[]` | `{dryRun:true,count,previews[]}` | validate before queueing |

`xd_export_*` return image content; if the payload has no `base64`, no file was written — treat as
failure.

## Mutating tools (queued until panel execution)

| Tool | Required | Optional | Notes |
|---|---|---|---|
| `xd_create_artboard` | `frame` | `name` | appended to root; `fill:null` |
| `xd_create_rectangle` | `frame` | `parent`, `name`, `style` | parent defaults to first artboard — always pass one |
| `xd_create_ellipse` | `frame` | `parent`, `name`, `style` | circle when w==h |
| `xd_create_line` | `start{x,y}`, `end{x,y}`, `style.stroke` | `parent`, `name`, `style.strokeWidth` | visible stroke required; endpoints parent-relative |
| `xd_create_polygon` | `frame` | `parent`, `name`, `cornerCount`, `starRatio`, `style` | native polygon/star |
| `xd_create_path` | `pathData`, `x`, `y` | `parent`, `name`, `style` | SVG path data only, not SVG/XML or arbitrary code |
| `xd_create_image` | `parent`, `frame` | `name`, `scaleBehavior` | user selects PNG/JPEG/GIF; creates native ImageFill Rectangle under explicit parent |
| `xd_replace_image` | `guid` | `scaleBehavior` | user selects PNG/JPEG/GIF; replaces ImageFill while preserving shape GUID/frame |
| `xd_import_asset` | Artboard `parent` | `name`, `x`, `y` | native file picker + `application.import`; accepts PNG/JPEG/GIF/BMP/TIF/TIFF/AI/PSD/Lottie JSON/MP4/TXT; no paths accepted |
| `xd_create_text` | `text` | `parent`, `name`, `frame{x,y[,w,h]}`, `style` | point text without frame; area text with w+h |
| `xd_create_group` | `guids[]` (≥2, same parent) | `name` | `commands.group()`; selection restored |
| `xd_create_mask_group` | `guids[]` (≥2, same parent) | — | highest-z selected node is the mask |
| `xd_ungroup` | `guid` | — | `commands.ungroup()` |
| `xd_duplicate_node` | `guid` | `name`, `offset{x,y}` | `commands.duplicate()`; XD positions Artboard copies automatically |
| `xd_delete_node` | `guid` | — | destructive exact-node removal; use only with explicit scope; XD undo is available in the host |
| `xd_reparent_node` | `guid`, `parent` | — | leaf, unrotated 2D only; position preserved |
| `xd_rotate_node` | `guid`, `angle` | — | clockwise rotation delta |
| `xd_arrange_nodes` | `guids[]`, `action` | — | bring/send front/back |
| `xd_align_nodes` | `guids[]` (≥2), `action` | — | same parent |
| `xd_distribute_nodes` | `guids[]` (≥3), `action` | — | same parent |
| `xd_update_node` | `guid` | `name`, `style`, `visible`, `locked`, `blendMode`, `markedForExport`, `fixedWhenScrolling` | artboard background via `style.fill`; `blendMode` accepts documented `BLEND_MODE_*` names |
| `xd_move_node` | `guid`, `x`, `y` | `relative` | parent-relative |
| `xd_resize_node` | `guid` | `width`, `height`, `relative` | at least one dimension |
| `xd_apply_style` | `style` | `guid` or `guids[]` | the reliable way to colour Text |
| `xd_update_text` | `guid` | `text`, `style` | text node only |
| `xd_update_path` | `guid`, `pathData` | — | rewrites an existing Path; pathData must start with `M/m` or `Z/z` |
| `xd_convert_to_path` | `guids[]` (≥1) | — | `commands.convertToPath()`; leaf nodes / boolean groups |
| `xd_outline_stroke` | `guids[]` (≥1) | — | `commands.outlineStroke()` (XD 42+); returns the new outline nodes |
| `xd_align_to_pixel_grid` | `guids[]` (≥1) | — | `commands.alignToPixelGrid()` |
| `xd_reset_3d_transforms` | `guids[]` (≥1) | — | `commands.reset3DTransforms()` (XD 47+) |
| `xd_make_background` | `guid` | — | `commands.makeBackground()`; node must be a stack cell |
| `xd_replace_background` | `guid` | — | `commands.replaceBackground()`; stack must already have a background |
| `xd_set_layout` | `guid`, `layout` | — | Responsive Resize / Padding / Stack via `SceneNode.layout`; `layout.type` = `none|responsive|padding|stack`, plus `stack{orientation,spacings}`, `padding` (number or per-side), `resizeConstraints{type:auto|manual, values}` |
| `xd_set_constraints` | `guid` | `horizontal`, `vertical`, `reset` | `SceneNode.horizontalConstraints` / `verticalConstraints`; positions `left|right|both|proportional` / `top|bottom|both|proportional`, sizes `fixed|resizes`; `reset:true` calls `resetToAutoConstraints()` |
| `xd_apply_design_tokens` | `tokens` | — | stores on `root.pluginData`; contrast report pairs `text/*` ↔ `bg/*` |
| `xd_create_component` | `guid` | `name` | **unsupported** → `supported:false` |
| `xd_create_component_variants` | `guid`, `variants[]` | — | **unsupported** → `supported:false` |
| `xd_execute_operation` | `operation{}` | — | single op; mutating → queued |
| `xd_execute_batch` | `operations[]` | `dryRun` | validates all first, then one editDocument/undo entry; runtime errors do not roll back earlier ops |

## Batch operation shape

Flat. Parameters are siblings of `op`, never nested:

```json
{ "op": "create_rectangle", "parent": "<guid>", "name": "Card/Base",
  "frame": { "x": 24, "y": 120, "width": 342, "height": 180 },
  "style": { "fill": "#14171D", "cornerRadius": 12 } }
```

Rejected: `{ "op": "create_rectangle", "params": { ... } }` →
`validation failed before execution: [create_rectangle] frame must be an object`.

## Style objects

`style` = `{ fill?, gradient?, stroke?, strokeWidth?, strokePosition?, strokeEndCaps?,
strokeJoins?, strokeDashArray?, strokeDashOffset?, cornerRadius?, opacity?, shadow?, innerShadow?, blur? }`
text `style` adds `fontFamily?`, `fontSize?`, `fontStyle?`, `fontWeight?` (compatibility alias),
`lineHeight?`, `charSpacing?`, `textAlign?` (`left|center|right`), `paragraphSpacing?`,
`textTransform?` (`none|uppercase|lowercase|titlecase`), `textScript?`
(`none|superscript|subscript`), `underline?`, `strikethrough?`, `flipY?`.

Plugin 1.0.5 mapping:

- `fontStyle` (and compatible `fontWeight`) → documented `styleRanges.fontStyle`.
- text `fill` → documented `styleRanges.fill`.
- `lineHeight` → `Text.lineSpacing`; `paragraphSpacing` → `Text.paragraphSpacing` (both node-level).
- **Text sizing uses `Text.layoutBox`** (XD 34+): `{x,y,width,height}` → `FIXED_HEIGHT`, `{x,y,width}` → `AUTO_HEIGHT`, `{x,y}` → `POINT`. The deprecated `areaBox` is no longer written — the previous code set it with a non-existent `scenegraph.AreaType`, which threw and silently produced point text.
- `textAlign` is mapped to the documented `Text.ALIGN_*` constants, so alignment is honoured on area/auto-height text.
- `Rectangle.cornerRadius` → documented `setAllCornerRadii()`.
- Gradient fill supports `linear`, `radial`, and `angular` with 2–32 ordered color stops; Text
  remains solid-color only. Stroke position/caps/joins/dash settings map to documented GraphicNode
  properties.
- `layout` / `constraints` map to the documented `SceneNode.LAYOUT_*`, `STACK_*`,
  `RESPONSIVE_RESIZE_*`, `FIXED_*`, `SIZE_*` and `POSITION_PROPORTIONAL` constants.

Unsupported `xd_create_component` and `xd_create_component_variants` return `supported:false`
immediately; they do not enter the panel queue.

## Execution status

| Tool | Returns | Limitation |
|---|---|---|
| `xd_get_operation_status` | `{xdConnected, pendingRequests, lastEvent{name,data{results[],error,at}}}` | `pendingRequests` = bridge in-flight only; **panel queue depth is not exposed**. Correlate `lastEvent` with the batch just executed. |

## Panel execution requirement

Every mutating call needs the user to click **Execute pending (N)** in the XD plugin panel. The
queue is in panel memory and is lost if the panel closes. Never treat `{queued:true}` as applied;
never blind-retry when execution state is unknown.

`xd_create_image`, `xd_replace_image`, and `xd_import_asset` are asynchronous inside
`editDocument`; the panel opens a native picker after the user click and waits for a file
selection. The bridge grants these operations a longer timeout. `xd_create_image` is the
exact-parent raster fill path; `xd_replace_image` preserves the target shape GUID/frame; generic
`application.import` is explicitly Artboard-targeted. Cancel returns `user_cancelled`.
