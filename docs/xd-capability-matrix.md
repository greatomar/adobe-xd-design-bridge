# Adobe XD Design Bridge Capability Matrix

**Audit date:** 2026-11-10. Host is Adobe XD 61.0.12.1.

## Release status

- Live XD panel checked at start of this mission: plugin **1.0.2**, connected.
- Source now has planned v1.0.3 changes in `xd-plugin/` and `bridge/`.
- Source registry contains **50 XD operations / 56 MCP tools** (the additional tools include
  health, capability discovery, preview, export wrappers and queue status).
- **The panel has not been reloaded** (reload would discard a previously queued Dashboard
  batch). New operations below are therefore source/mock-tested only until a deliberate reload
  and live verification.
- The live scratch document is `OpenCode-Bridge-Test` (GUID
  `49cf0a87-cfea-4b3d-9120-c522a4114ffe`); its 19 artboards are user state and have not been
  modified during this source audit/repair.

## Local SDK, skills and model/tool audit

- XD 61 and UXP Developer Tool are installed; in the inspected plugin, UXP Developer Tool, and
  common UXP folders, no standalone XD SDK, XD `.d.ts` package, or XD-specific sample project was
  found. API claims cite Adobe's online XD reference, not inferred UXP internals.
- Global design skills: `frontend-design` (Anthropic source, locally adapted), `ui-ux-pro-max`
  (security notes identify v2.15.0; CLI requires Python, not installed), `impeccable` (v4.8.2;
  its UI-code scripts/hooks are not run for XD-only work), plus local XD/UX/accessibility skills.
  No duplicate skills were installed.
- The OpenCode tool catalog exposes the Adobe XD MCP tools. The global design agent is
  `mode: all`, but implementation remains in the owning session to preserve document and panel
  queue context.
- The model catalog includes a vision-named `Nemotron 3.5 Super VL` candidate and Gemini
  candidates; catalog metadata does not guarantee image-input support in every session. The
  image generator is not a vision inspector or native XD authoring engine. Claim visual review
  only when image input was actually received.

## Capability status legend

- **Live verified:** executed/read from the actual XD 61 runtime.
- **Source + mocked:** mapped to a documented public API and covered by fake-runtime tests; not
  proof of live behavior.
- **Partial:** only a documented subset/workflow is available.
- **Unavailable:** no documented public XD UXP API; do not simulate success.

## Document and artboards

| Capability | Status | Tool / boundary |
|---|---|---|
| Read document name/GUID and counts | **Live verified** | `xd_get_document_info`; `DocumentInfo` does not expose path/modified. |
| List artboards and frames | **Live verified** | `xd_get_artboards`; `SceneNodeList` normalized with `at(i)`. |
| Create artboard | **Live verified** | `xd_create_artboard`; user panel execution required; `guid` returned after execution. |
| Rename/move/resize/background | Source + mocked | `xd_update_node`, `xd_move_node`, `xd_resize_node`; artboards have fill (background) but ignore stroke/shadow/blur; resize via documented width/height. |
| Duplicate artboard | Source + mocked | `xd_duplicate_node` uses `commands.duplicate()`; XD auto-places artboard copies to avoid overlap. |
| Delete artboard | Source + mocked | `xd_delete_node` via `removeFromParent`; destructive, explicit scope required. |
| Viewport pan/zoom | **Unavailable in current MCP/API** | No bridge operation; report off-canvas coordinates. |

## Scenegraph authoring and editing

| Capability | Status | Tool / boundary |
|---|---|---|
| Rectangle / ellipse / text creation | Source + mocked; limited live write proof in prior sessions | `xd_create_rectangle`, `xd_create_ellipse`, `xd_create_text`; always pass explicit parent GUID. |
| Line / polygon / path creation | Source + mocked | New `xd_create_line`, `xd_create_polygon`, `xd_create_path`, documented SceneNode constructors / setters. Path takes path-data only, not XML. |
| Rename/style/visibility/lock | Source + mocked | `xd_update_node`, `xd_apply_style`. |
| Text edit / typography | Source + mocked | `xd_update_text`; `fontStyle`, `fill`, and node `lineSpacing` mapped to documented API keys. Font availability still host-dependent. |
| Move / resize / rotate | Source + mocked | `xd_move_node` (`moveInParentCoordinates`), `xd_resize_node` (`resize` or Artboard dimensions), `xd_rotate_node` (`rotateAround`). |
| Duplicate / delete / reparent leaf nodes | Source + mocked | `xd_duplicate_node` (`commands.duplicate`), `xd_delete_node` (`removeFromParent`), `xd_reparent_node` (leaf nodes only; rotated/3D transforms refused). |
| Group / mask / ungroup | Source + mocked | `xd_create_group`, `xd_create_mask_group`, `xd_ungroup`; selection-driven, nodes must share parent/edit context. |
| Z-order, align, distribute | Source + mocked | `xd_arrange_nodes`, `xd_align_nodes`, `xd_distribute_nodes`; documented `commands` selection APIs. |
| Search / inspect / selection | **Live verified read path** | `xd_search_nodes`, `xd_inspect_node`, `xd_get_selection`; reads actual scenegraph. |
| Fill/stroke/opacity/corner radius/shadow/inner shadow/blur/gradient | Source + mocked | Solid + Linear/Radial/Angular gradient fills, stroke position/caps/joins/dash, radius via documented `setAllCornerRadii`, opacity/shadow/inner shadow/blur. Gradients are not valid on Text; inner shadow is host-restricted on some nodes. |

## Assets, components, tokens

| Capability | Status | Tool / boundary |
|---|---|---|
| Raster image fills / replacement / general asset import | Source + mocked | `xd_create_image` creates a native ImageFill Rectangle at an explicit parent/frame; `xd_replace_image` swaps fill while preserving GUID/frame; `xd_import_asset` uses native importer on an Artboard. No arbitrary paths. Live picker behavior pending. |
| ImageFill | Documented partial | `ImageFill` accepts PNG/JPEG/GIF; fill can use data URI or UXP File. Cropping controls are not exposed. |
| SVG | Partial | Create editable vectors through `Path.pathData`; no documented SVG file import in `application.import`. |
| Component masters / new SymbolInstances | **Unavailable** | Official `SymbolInstance` reference says plugins cannot create them; existing instances may be inspected/edited/duplicated. Grouped nodes are not linked components. |
| Component variants | **Unavailable** | `xd_create_component_variants` honestly returns `supported:false`. |
| Design tokens | Partial | `xd_apply_design_tokens` stores JSON on root `pluginData`; no native swatches/character styles. Per-node styling is real scenegraph styling. |

## Prototype and interaction

| Capability | Status | Tool / boundary |
|---|---|---|
| Read flows, interactions, triggers, actions, destinations, transitions | Source + mocked | New read-only `xd_get_prototype_state` backed by official `interactions.flows` / `allInteractions`. Not yet live verified. |
| Audit required user-flow edges against existing wires | Source + mocked | New read-only `xd_validate_prototype`; reports missing source/destination/connection. Not yet live verified. |
| Create / edit / delete wires or transitions | **Unavailable through documented public UXP API** | Official interactions module is read-only; no commands setter exists in the documented API. Use XD Prototype UI manually; do not claim clickable connections from a flow spec. |

## Structural / semantic quality

| Capability | Status | Tool / boundary |
|---|---|---|
| Default names, empty groups, zero-size nodes | Source + mocked; existing live tool available | `xd_validate_document` checks these limited conditions. |
| Token/color/font-size/target-size consistency | Source + mocked | `xd_inspect_design_consistency`; token naming and node properties constrain coverage. |
| Screen-specific required content roles | Source + mocked | New read-only `xd_audit_screen` checks a designer-specified semantic role manifest, type and nonempty text. It is a structural gate, **not** a fixed node quota or visual/professionalism score. |
| Pixel-perfect visual quality | Model/export dependent | Exported image is supplemental QA; claim actual visual inspection only if image content was available to the model. |

## Batch, error, and security behavior

- MCP operation schema is a whitelist; batches are flat `{op, ...args}` at the MCP boundary and
  normalized to `{op, params}` for the plugin batch handler.
- Point-text validator is now idempotent: absent `width`/`height` remain absent rather than
  normalizing to `0` and failing the second batch validation.
- Plugin writes remain user-mediated via `application.editDocument` panel click. The panel queue
  remains volatile, and status still does not expose its depth. No arbitrary code or path
  execution has been added.
- Import uses a native file picker; request input never supplies a path.
- Delete is a whitelist operation requiring an exact GUID; the Design Agent must ask before
  destructive changes to user work.

## v1.0.5 documented-API gap closure (2026-11-11)

Source audit against Adobe's published XD plugin reference (scenegraph, SceneNode, Text, Path,
commands, BooleanGroup). Added, validated and unit-tested in source:

| Operation | Documented API | Value |
|---|---|---|
| `update_path` | `Path.pathData` (writable) | edit an existing vector path instead of recreating it |
| `convert_to_path` | `commands.convertToPath()` | flatten shapes to editable paths |
| `outline_stroke` | `commands.outlineStroke()` | turn strokes into fills / paths |
| `align_to_pixel_grid` | `commands.alignToPixelGrid()` | crisp 1x rendering |
| `reset_3d_transforms` | `commands.reset3DTransforms()` | undo accidental 3D rotation |
| `make_background` / `replace_background` | `commands.makeBackground()` / `replaceBackground()` | Stack backgrounds |
| `set_layout` | `SceneNode.layout` (`LAYOUT_*`, `STACK_*`, padding, resize constraints) | real auto-layout, not manual x/y |
| `set_constraints` | `SceneNode.horizontalConstraints` / `verticalConstraints` / `resetToAutoConstraints()` | Responsive Resize behaviour |
| `update_node` (extended) | `blendMode`, `markedForExport`, `fixedWhenScrolling` | compositing + export + scroll pinning |
| text style (extended) | `paragraphSpacing`, `textTransform`, `textScript`, `underline`, `strikethrough`, `flipY` | full documented typography surface |

**Defect fixed in the same pass:** `create_text` wrote the deprecated `areaBox` with a
non-existent `scenegraph.AreaType`, which threw and was swallowed — every "fixed frame" text node
was silently created as point text, so `textAlign` did nothing and width/height were ignored. It
now uses `Text.layoutBox` (`FIXED_HEIGHT` / `AUTO_HEIGHT` / `POINT`) and maps `textAlign` to the
documented `Text.ALIGN_*` constants.

Still unavailable through documented public APIs (unchanged, not simulated):

- **Creating BooleanGroup nodes** — the reference states plugins cannot create them (only
  duplicate existing ones). `pathOp` is read-only.
- **Component masters / linked variants** — no Component class; `SymbolInstance` cannot be created.
- **Prototype wires** — the `interactions` module is read-only.
- **Native colour swatches / character styles** — no creation API; tokens stay in `root.pluginData`.
- **Viewport scroll/zoom to a node** — no documented plugin API; off-canvas artboards must be
  reported by coordinate.

Not assessed in this pass (documented classes whose constructibility was not verified):
`RepeatGrid`, `ScrollableGroup`, `Lottie`, `Video`, `LinkedGraphic`.

## Verification status

Read path was live-verified with plugin 1.0.2 in the prior session. The v1.0.3 fixes
(`createShapeTool` link closure, panel async completion) were **live-verified on plugin 1.0.4**
with a single controlled acceptance rectangle: non-empty `batchExecuted` result plus independent
scenegraph read-back. The v1.0.5 additions above are covered by local unit tests only and require
a reload plus live smoke tests before being marked Live verified.
