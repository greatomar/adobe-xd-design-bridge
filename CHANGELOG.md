# Changelog

## 1.1.6 - 2026-11-18 (Mutation contracts: no more silent no-ops)

Stage 9 visual work exposed operations that returned `ok:true` without performing the mutation.
Every case was traced through schema -> validation -> plugin handler -> read-back and closed.

### Fixed
- **`update_node` rejects geometry.** `frame`/`x`/`y`/`width`/`height` now return
  `UNSUPPORTED_PROPERTY` naming `move_node`/`resize_node`; unknown keys return `UNKNOWN_PROPERTY`;
  validation is atomic, so a rejected payload queues nothing.
- **`update_node` dropped `visible` and `locked`.** The validated shape was nested one level too
  deep, so those two properties never reached the plugin while the op reported success. This is the
  root cause of the suspected "defect E" (`{visible:false}` changing nothing).
- **`move_node` states and verifies its coordinate contract.** Both coordinates are required and
  parent-relative; the result returns `coordinateSystem`, `before`/`after`/`delta`, `moved`, and a
  `placement`/`safe` verdict that flags a node pushed outside its own artboard.
- **`resize_node` verifies the applied size.** Reads the bounds back, compares within a documented
  0.5 px tolerance, returns `MUTATION_VERIFICATION_FAILED` when the host ignored the request, and
  treats text reflow as `reflowed` instead of a failure. Relative scale factors are validated
  separately from absolute dimensions.
- **`reparent_node` verifies the relationship.** Checks the actual parent, membership in the new
  parent, absence from the old one, and geometry preservation; a host that accepts `addChild`
  without moving the node now fails loudly instead of returning success.
- **`inspect_node` no longer truncates silently.** The plugin re-enumerates children and returns
  `childrenTotal`/`childrenReturned`/`childrenOffset`/`childrenLimit`/`hasMore`/`nextOffset`;
  `childCount` is preserved. `limit` (1..500) and `offset` (>= 0) are validated bridge-side, and the
  default page (100) covers reasonably sized nodes completely.

### Documentation
- New `docs/mutation-contracts.md` records the measured contracts and the queued/applied/verified
  distinction the agent must respect.

### Live acceptance (stage 9.1 fixture, XD 61.0.12.1)
- `Stage9.1-Geometry-Test` / `Stage9.1-Reparent-Test` artboards at y=4200/5000, isolated from every
  existing artboard; 39 fixture children created in one queued batch, 39/39 applied.
- `move_node`: (20,4220) -> (40,4280), `delta {20,60}`, `placement.inside:true`, `safe:true`;
  the same node moved to artboard y=2000 reported `inside:false`, `safe:false`.
- `resize_node`: 80x40 -> 120x70 with `verified:true` (tolerance 0.5).
- `update_node` frame / unknown keys rejected through live MCP, queue still idle afterwards.
- `inspect_node`: 38-child artboard returns `childrenTotal:38`; page 2 = 8 children with
  `hasMore:false`; a page beyond the end returns 0 children.
- Reparenting into a group that lives inside the old parent exposed two host truths: a recursive
  old-parent search produces a false failure, and the placement origin is the artboard, not the
  group bounds (20 px drift). Both are fixed and covered by tests.

### Tests
- 14 new tests (319/319 passing): plugin-side pagination boundaries, move placement and
  off-artboard reporting, resize verification failure and text reflow, reparent nested-parent and
  geometry-drift cases, artboard-space placement, and bridge-side rejection of geometry/unknown
  properties, pagination validation and queue-free rejection through a real `XdLink`.

## 1.1.5 - 2026-11-16 (Shape geometry is verified, not assumed)

Live work on the login screen found `create_ellipse` returning `ok:true` with a GUID for a node it
had created at 0×0. Root cause: XD 61 drops `width`/`height` assigned to a shape *before* it is
attached to a parent; the handler set size pre-attach and never checked the result.

### Fixed
- **`ensureShapeSize` + `shapeGeometryFailure`**: shapes are sized *after* `addChild` (preferring
  `resize()`), then verified to within 0.5 px. A shape that still does not match returns
  `{ok:false, code:"geometry_mismatch", width, height, expected, removed}` and is removed from the
  parent, so a 0×0 node is never left behind and never reported as success.
- Applied to `create_rectangle`, `create_ellipse` and `create_polygon` (the frame-sized shapes).
  `create_line` (start/end), `create_path` (path data) and `create_text` (auto height) derive their
  geometry differently and are unchanged.
- Successful creation ops now also return `width`/`height`, so callers can assert real geometry
  instead of trusting `ok:true`.
- **`create_screen` inherits the fix**: a child that cannot be sized fails the child result, aborts
  the remaining children, and never appears as a zero-size node.

### Tests
- The fake runtime now models the host quirk (detached writes dropped; `"always"` mode for
  unresizable hosts) and `resize()` updates `width`/`height` like real XD.
- 3 new tests: repair path, honest failure with node removal, and child-geometry failure inside
  `create_screen`. 196/196 passing.

## 1.1.4 - 2026-11-16 (`create_screen`: one transaction per screen)

Editing friction had a structural cause: children need the artboard GUID, which only exists after
the artboard is created, so building a screen always cost two panel interactions.

### Added
- **`create_screen`** (plugin + `xd_create_screen` MCP tool): one queued operation creates the
  artboard *and* its children inside a single `editDocument` transaction. The handler holds the new
  artboard object, so `parent` is forced and the dependency disappears. Artboard name, frame and
  background fill are applied in the same transaction.
- Children are restricted to creation ops (`create_rectangle`, `create_ellipse`, `create_text`,
  `create_line`, `create_polygon`, `create_path`); nesting, `create_artboard` and `execute_batch` are
  rejected before anything reaches XD.
- Per-child results are returned (`children[{op,name,ok,guid,error}]`) with `aborted` when a child
  fails, matching `execute_batch` semantics.

### Notes
- 54 operations, 72 MCP tools. Plugin 1.0.11.
- The one-click floor is unchanged in nature: XD requires one panel interaction per
  `editDocument`. `create_screen` removes the *second* interaction a new screen used to need; it
  cannot remove the first.

### Tests
- 2 new plugin tests (whole screen in one call; abort-after-failure). 193/193 passing.

## 1.1.3 - 2026-11-16 (Selection persistence: pan-first, select-last)

A live diagnostic proved that XD **does** honour a selection assigned inside `editDocument`, but
only when the assignment is the last scenegraph-affecting step of the transaction. 1.1.2 assigned
first and then panned, which silently discarded the selection.

### Fixed
- **Order reversed** in `prototype_focus` and `prototype_prepare_connection`: `focusViewport(node)`
  now runs before `attemptSelection(node)`, so selection is the final step.
- **`focused` removed from the operation payload.** The handler cannot observe post-commit state, so
  it reports `focusState:"selection-assigned"` with `assignedTo` / `selectedInTransaction` /
  `wasSelectedBefore` and `confirmationRequired:"read xd_get_selection after execution"`. Focus is
  an agent-level conclusion backed only by an independent post-commit `xd_get_selection`.
- States are now `selection-assigned` | `selection-failed` | `focus-unverified` | `not-attempted`;
  the overlapping `focused` / `already-selected` booleans are gone.
- Instruction text no longer asserts that the source node is already selected.
- The temporary `selection_probe` diagnostic operation was **removed** from the plugin and the
  bridge registry; the behaviour it discovered is now covered by normal tests.

### Tests
- Fake runtime logs an ordered `order[]` of scenegraph-affecting operations and models post-commit
  persistence, so the pan-before-select rule and the surviving selection are asserted directly.
- 191/191 passing.

## 1.1.2 - 2026-11-16 (Prototype focus: live-verified corrections)

Live acceptance against XD 61 disproved three assumptions in 1.1.1. Fixed:

### Fixed
- **Selection requires the edit gate.** `scenegraph.selection.items = [...]` throws
  *"not permitted to make changes from the background. Use editDocument() for panel
  UI handlers"* when assigned outside `editDocument`. `prototype_focus` and
  `prototype_prepare_connection` are therefore now **queued** operations (`mutating:true`,
  removed from the panel's `nonMutating` set): they run inside the normal
  `application.editDocument` callback after **Execute pending**. No new execution
  mechanism was introduced and the whitelist/queue/authentication path is unchanged.
- **Viewport API corrected.** The non-existent `viewport.scrollToRect` was replaced with
  the documented `viewport.scrollIntoView(node)`. `viewport.bounds` and `viewport.zoomFactor`
  are snapshotted before/after, and `scrolled:true` is reported only when `bounds` actually
  changed. New honest codes: `viewport_moved`, `already-in-view`,
  `viewport_change_unverified`, `viewport_unsupported`, `viewport_unavailable`, `viewport_error`.
- **False-positive focus removed.** `focused:true` could previously coexist with a
  `selectionError` because it was derived from read-back alone. Selection is now classified as
  `focusState`: `focused` (genuine change), `already-selected` (was selected before the call),
  `selection-failed` (write threw or did not apply), `focus-unverified` (state unreadable).
  `focused` is `true` only for `focused`.

### Tests
- Fake XD runtime now enforces the live rule: selection writes outside `editDocument` throw
  when `enforceEditContext` is on, so tests cannot pass on behaviour XD forbids.
- 10 new regression tests (selection rejected in background, selection applied through
  `editDocument`, `already-selected` vs `focused`, error/focused exclusivity, focus-unverified,
  `scrollIntoView(node)` usage, evidence-based `scrolled`, `already-in-view`, unsupported viewport,
  queue routing). Suite: 190/190.

## 1.1.1 - 2026-11-16 (Prototype Wiring Assistant)

### Added
- **3 new XD operations** (`ops.js`, plugin **1.0.7**, 53 total):
  `prototype_focus`, `prototype_prepare_connection`, `prototype_verify_connection`.
  All are read-only: they change selection and canvas scroll, never the document.
- **4 new MCP tools** (71 total): `xd_prototype_plan`, `xd_prototype_focus`,
  `xd_prototype_prepare`, `xd_prototype_verify`.
- **Flow manifest** (`bridge/src/prototype.ts`): `{name?, home?, edges[{source,target,
  sourceRole?,trigger?,action?,transition?,overlay?,preserveScrollPosition?,note?}]}`,
  validated structurally then resolved against the live document — semantic names
  (`Home/PrimaryCTA`) become GUIDs, with `source-not-found`, `source-ambiguous`,
  `target-not-found` and `home-not-found` diagnostics instead of guesses.
- **`xd_prototype_focus`** selects a node with the documented writable
  `scenegraph.selection.items` and scrolls with `viewport.scrollToRect(bounds, false)`,
  confirming the selection by read-back and reporting `selected:false` honestly.
- **`xd_validate_prototype` is now a real report**: `verdict` (`pass`/`fail`),
  `expected[]`, `detected[]`, `missing[]`, `incorrect[]`, `extra[]`,
  `summary{…,coverage}` — with source/target GUIDs and semantic names.
  Backwards compatible: `valid`, `results[]` and `actualConnectionCount` are unchanged.
- **7-way per-edge verdicts**: `ok`, `missing`, `incomplete`, `wrong-destination`,
  `wrong-trigger`, `wrong-action`, `ambiguous`.
- `docs/prototype-wiring-workflow.md` and a §7A section in the Design Agent contract.

### Unchanged by design
- **Prototype wires still cannot be authored through XD's public UXP API.** The
  `interactions` module is read-only and no documented command creates, edits or
  deletes a connection. Every prototype tool returns `authoringSupported:false` and
  `createdWire:false`; manual wiring in XD Prototype mode is required. No undocumented
  internal state, file-format injection or UI automation was introduced.

### Tests
- 24 new tests (180 total, all passing): manifest validation, plan resolution, focus,
  preparation states, every verification verdict, complete/incomplete/extra reports,
  and non-mutating registration.

## 1.1.0 - 2026-11-11 (Design Asset Intelligence)

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
