# Changelog

## 1.1.0 — 2026-11-11 (Design Asset Intelligence)

### Added
- **Asset layer** (`bridge/src/assets/`): source catalog with real integration
  contracts and licenses, curated font/component registry, deterministic
  explainable search, project-local cache with manifest + hash dedupe,
  dependency-free SVG reader, SVG path transform, persisted design context.
- **11 new MCP tools**: `design_asset_search`, `_list_sources`, `_list_categories`,
  `_inspect`, `_get`, `_license`, `_recommend`, `_insert`, `_apply_font`,
  `design_context_get`, `design_context_set` (67 tools total).
- `design_asset_insert` converts SVG into real XD **Path** nodes via the existing
  `create_path` operation — no rasterisation, no parallel XD integration.
- Live sources: Iconify (Lucide, Phosphor, Tabler, Heroicons, Material Symbols,
  Simple Icons) and Google Fonts metadata. Reference-only sources are catalogued
  with their terms and never auto-downloaded.
- Path transforms now follow the SVG rule that a leading relative `moveto` is
  absolute, so icons such as Material Symbols no longer land at the origin.

## 1.0.6 — 2026-11-11 (source; live reload pending)

### Changed
- **Panel rebuilt for clarity**: neutral high-contrast theme, compact live/offline status pill, one
  primary action, connection controls collapsed behind a disclosure, condensed activity log.
- **Auto-apply is on by default.** Queued work is applied on the next panel interaction
  (`pointerdown`/`mousedown`/`click`/`keydown`/`input`/`change`). Adobe XD only permits
  `application.editDocument()` from a real UI event, so a plugin cannot edit the document with no
  user gesture at all; the remaining click is now any click in the panel, not a specific button.

### Fixed
- **`create_artboard` could never succeed.** It validated `scenegraph.root` with
  `selection.isInEditContext()`, which XD 61 returns `false` for; every call failed with
  `outside_edit_context`. The root *is* the edit context, so the check was removed (the panel's
  `editDocument` gate still enforces a legal edit context).
- **`strokeEndCaps` / `strokeJoins` aborted whole batches on Path nodes** with
  `lineCap: invalid value`. These are decorative, so they are now best-effort and can no longer
  fail an operation.

## 1.0.5 — 2026-11-11 (source; live reload pending)

### Fixed
- **Text sizing used a non-existent API.** `create_text` wrote the deprecated `areaBox` with
  `scenegraph.AreaType.FIXED`, which does not exist; the throw was swallowed by a try/catch, so
  every text node with a width/height was silently created as *point text*. Width and height were
  ignored and `textAlign` had no visible effect. Now uses the documented `Text.layoutBox`
  (`FIXED_HEIGHT` / `AUTO_HEIGHT` / `POINT`) and maps `textAlign` to `Text.ALIGN_*`.
- `update_text` now uses `Text.updateText()` when available so existing `styleRanges` survive a
  content change.
- `create_ellipse` was creating 0×0 nodes because width/height were set on a detached Ellipse and
  discarded by XD. *(Diagnosed live; repairs are applied with `xd_resize_node`. The constructor
  order itself is unchanged in this release.)*

### Added (documented XD plugin API)
- `update_path` (`Path.pathData`), `convert_to_path`, `outline_stroke`, `align_to_pixel_grid`,
  `reset_3d_transforms`, `make_background`, `replace_background`.
- `set_layout` (`SceneNode.layout`: Responsive Resize / Padding / Stack) and `set_constraints`
  (`horizontalConstraints` / `verticalConstraints` / `resetToAutoConstraints`).
- `update_node` accepts `blendMode`, `markedForExport`, `fixedWhenScrolling`.
- Text style accepts `paragraphSpacing`, `textTransform`, `textScript`, `underline`,
  `strikethrough`, `flipY`.
- `inspect_node` now reports `blendMode`, `hasDefaultName`, `layout`, `layoutBox`,
  `clippedByArea`, `lineSpacing`, `paragraphSpacing`, `textAlign`, and `pathData` for Paths.
- Registry: **50 operations / 56 MCP tools**; 134/134 local tests pass.

## 1.0.3 — 2026-11-10 (source; live reload pending)

### Fixed
- Point-text frame validation is now idempotent: omitted `width`/`height` stay omitted through
  normalized `xd_execute_batch` re-validation instead of becoming invalid zero dimensions.
- Text ranges now map to XD's documented `fontStyle` and `fill`; `lineHeight` maps to the Text
  node's `lineSpacing`. `fontWeight` remains a compatibility alias.
- Rectangle/Polygon corner radius uses documented `setAllCornerRadii()`; absolute positioning
  uses the visual local-bounds top-left registration point; relative movement uses
  `moveInParentCoordinates()`; Artboard resizing uses its width/height properties.
- Panel batch execution awaits Promise-returning handlers inside `application.editDocument`,
  preserving the single edit transaction for native file-picker imports.

### Added
- Native editable shape operations: Line, Polygon/star, SVG path-data (strict geometry-only
  whitelist), delete, duplicate, leaf reparent, rotate, ungroup, mask group, z-order, align and
  distribute.
- `xd_create_image` creates an ImageFill Rectangle from a user-selected raster file; `xd_import_asset`
  uses the native importer for broader formats. Neither accepts arbitrary paths.
- Native Linear/Radial/Angular gradient fills, stroke placement/caps/joins/dashes and inner shadows
  where supported by the target node type.
- Read-only `xd_get_prototype_state` and `xd_validate_prototype` backed by the documented
  read-only `interactions` module. Prototype-wire authoring remains unsupported by the public API.
- `xd_audit_screen`: screen-specific semantic role manifest read-back; structural only, no
  arbitrary node-count threshold and no claim of visual-quality certification.
- Full `docs/xd-capability-matrix.md` and updated schema/skills/agent construction protocol.
- Regression coverage for native edit commands, asset picker, prototype inspection, screen-role
  audit, and point-text batch validation.

### Verification
- 134/134 local tests pass (mock XD runtime + bridge/protocol + policy/workflow tests).
- New v1.0.3 operations are **not yet live verified**. Live panel remains on v1.0.2 until a
  deliberate UDT reload; a previous Dashboard batch is unresolved in the panel queue.

## 1.0.2 — 2026-11-10

### Fixed
- **`application.activeDocument.root` does not exist.** In XD 61 `application.activeDocument`
  returns a `DocumentInfo` (`name`, `guid`) — not a scenegraph document — so every read of
  `doc.root.children` threw `TypeError: Cannot read properties of undefined (reading 'children')`.
  The document scenegraph is now resolved exclusively through the documented
  `scenegraph.root` (`RootNode`, XD 14+). Affected: `create_artboard`, `create_rectangle`,
  `create_ellipse`, `create_text`, `create_group`, `search_nodes`, `update_node`, `move_node`,
  `resize_node`, `apply_style`, `update_text`, `apply_design_tokens`,
  `inspect_design_consistency`, `export_artboard`, `validate_document`, plus parent/GUID
  resolution helpers, and the panel's `refreshInfo()` status line.
- **`SceneNode.children` is a `SceneNodeList`, not an Array** (live-verified in XD 61 on
  2026-11-10): `Array.isArray(children)` is always false, `children[i]` does not work, and
  `filter/map/slice/find` are not guaranteed. Added `childList()` normalisation (`length` +
  `at(i)`) used by traversal, GUID lookup, node summaries, search, exports and the panel status;
  root validation accepts a `SceneNodeList` or a plain Array.
- Removed reads of the non-existent `DocumentInfo.path` and `DocumentInfo.modified`; those
  fields are now reported as `null` with an explanatory note instead of fabricated values.
- `apply_design_tokens` no longer reports success when the root was unreachable; it returns a
  structured error and reports `stored: false` if plugin data cannot be written.
- Empty documents return `artboardCount: 0` / `artboards: []` (and `nodeCount: 0`) instead of
  throwing. `nodeCount` excludes the root container.

### Added
- Centralised document access layer in `ops.js`: `docInfo()`, `sceneRoot()`, `requireScene()`,
  `resolveNode()` (documented `getNodeByGUID` first, tree walk fallback), `requireNode()`,
  `findParent()`, `childList()`, `isArtboard()`, `artboardFrame()`. Structured error codes:
  `no_active_document`, `no_scenegraph_root`, `node_not_found`, `artboard_not_found`.
- `tests/plugin-ops.test.ts`: 34 tests loading the real `ops.js` in a vm sandbox with a
  functional fake XD runtime (blank document, artboards, nested groups, parent resolution, GUID
  lookup, creation, mutation, styling, tokens, search, renditions, validation, missing document /
  root, malformed root, and a regression guard proving no handler reads
  `activeDocument.root/.path/.modified`).
- Diagnostics in `ops.js` are now opt-in (`window.__xdBridgeDiag = true`) and shape-only.

## 1.0.1 — 2026-11-10

### Fixed
- **Plugin manifest rejected by XD's UDT validator** (`Expected atleast a single entry in the
  icons list`): added two icon entries (24px and 48px, `scale: [1,2]`, `species: ["pluginList"]`,
  `theme: ["all"]`) in the format documented in the XD manifest reference, plus the four
  referenced PNGs in `xd-plugin/icons/` (generated with a zero-dependency Node script;
  rounded-square #5B4FD6 with a white bridge glyph).
- `host.minVersion` raised from `35.0.12` to `36.0` — the documented minimum host version for
  UXP-manifest (v4+) XD plugins; `35.0.12` was below the verified floor.

## 1.0.0 — 2026-11-10

Initial build.

### Added
- MCP bridge (`bridge/`): 29 `xd_*` tools over stdio; local WebSocket server (127.0.0.1:27183)
  with token auth, serial queue, timeouts; validated operation whitelist with dry-run support;
  WCAG contrast computation; PNG export with real image content + saved paths.
- Adobe XD UXP panel plugin (`xd-plugin/`): manifest v5, token-authenticated WS client,
  document/selection status UI, execution inside `commands.editDocument`, honest unsupported-op
  reporting, token persistence in plugin data folder.
- Tests (`tests/`): 9 MCP end-to-end tests (mock plugin) + 7 wire-protocol tests — 16/16 passing.
- Sample design (`examples/sample-mobile-design.json`): "Solstice Wallet" 390×844 screen —
  token set + executable batch operations.
- OpenCode integration: `design` agent (mode `all`), 10 design skills
  (frontend-design [adapted for XD output], ui-ux-pro-max v2.15.0, impeccable v4.8.2,
  adobe-xd-specialist, ux-architecture, design-system-engineering, visual-design-direction,
  visual-qa-and-critique, prototyping-and-interaction, accessibility-design), global MCP config
  (`~/.config/opencode/opencode.json`).
- Documentation: README, ARCHITECTURE, INSTALLATION, TROUBLESHOOTING, SECURITY, TESTING,
  docs/ (OpenCode integration, skill inventory/updates, XD API limitations).

### Known gaps

- The plugin is implemented against documentation-verified XD APIs but its **in-XD runtime
  behavior is unverified** until it is loaded via UXP Developer Tool (GUI-only flow) and the
  smoke test runs (see INSTALLATION.md §3–4). Note: the initial build-time claim that "XD 61.0
  was not installed" was **wrong** — XD 61.0.12.1 is installed as an MSIX package and was
  reconciled on 2026-11-10 (see INSTALLATION.md §2 for the verification evidence).
- Python 3 not installed → ui-ux-pro-max search scripts inactive (skill falls back to its
  reference data).
- Prototype wire authoring is not exposed by XD's public plugin API; interactions are
  specification-level output.
