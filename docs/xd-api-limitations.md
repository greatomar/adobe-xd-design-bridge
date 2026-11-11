# Adobe XD 61.0 Plugin API — Verified Facts and Limitations

Verified against Adobe's official XD UXP API reference and the installed/live host. Host:
**Adobe XD 61.0.12.1**. Current source plugin is being upgraded from 1.0.2 to 1.0.3; until
UXP Developer Tool reloads it, the live panel remains on 1.0.2 and does not expose new tools.
See [`xd-capability-matrix.md`](xd-capability-matrix.md) for the current full inventory.

## Document and scenegraph facts

| API fact | Verified behavior |
|---|---|
| `application.activeDocument` | `DocumentInfo {name, guid}` only; no `root`, `path`, `modified`, or active-window indicator. |
| `scenegraph.root` | Current document `RootNode`; artboards and pasteboard content are its children. |
| `SceneNode.children` | Immutable `SceneNodeList`, not Array. Use `length`, `at(i)`, `forEach`; never assume `[i]`, `filter`, `map`, `find`, or `slice`. |
| `scenegraph.getNodeByGUID(guid)` | Documented fast lookup (XD 28+); detached nodes return undefined. |
| `SceneNode.removeFromParent()` | Documented node removal/deletion. This is destructive and undo recovery is via XD UI, not MCP. |
| `commands` | Selection-driven API: `group`, `ungroup`, `duplicate`, arrange, align, distribute, `createMaskGroup`; nodes must be in current edit context. |
| Shapes | Documented scenegraph constructors include Artboard, Rectangle, Ellipse, Polygon, Line, Path and Text. Path accepts SVG path-data syntax. |
| `application.editDocument` | From a panel, call in response to a UI event. Its edit callback may return a Promise. Plugin queues requests for the panel's Execute button. |
| `application.import` | Documented since XD 45; imports user-selected PNG/JPEG/GIF/BMP/TIF/TIFF/AI/PSD/Lottie JSON/TXT. The file picker pattern is documented inside async `editDocument`. |
| `application.createRenditions` | Documented export API for PNG/JPG/PDF/SVG; not `exportAsync`. |

## Prototype API boundary

Official [`interactions` reference](https://developer.adobe.com/xd/uxp/develop/reference/interactions/)
describes its module as **read-only**. It exposes `flows`, `allInteractions`, node
`triggeredInteractions`, and artboard `incomingInteractions`, including trigger/action/transition
details. The official `commands` reference has no wire-authoring command. No supported public XD
UXP API to create, modify, or delete wires was found. The bridge can therefore inspect/validate
existing flows, but prototype connections still require manual work in XD's Prototype workspace.
Do not use undocumented internal state or simulated UI automation to claim otherwise.

## Component boundary

`SymbolInstance` exists, and existing instances may be inspected, edited as overrides, or
duplicated. The official [`SymbolInstance` reference](https://developer.adobe.com/xd/uxp/develop/reference/symbol-instance/)
explicitly says plugins cannot create a new component definition or SymbolInstance node, aside
from duplicating existing instances. Therefore grouped native elements are visually reusable
structures but **not linked component masters**; token `pluginData` is not a native style library.

## Remaining host limitations

- No public font-enumeration API; fonts can silently fall back. Verify font appearance when an
  image export is available.
- `ImageFill` supports PNG/JPEG/GIF; image crop controls are not exposed to plugins. Asset file
  import is broader than ImageFill, but SVG is not among `application.import`'s documented types.
- `xd_get_operation_status` exposes bridge requests and last execution event, not the panel's
  in-memory pending queue. Reloading/closing the panel loses queued writes; no batch ID exists.
- XD does not move its viewport to a programmatically created artboard; no exposed bridge tool
  controls viewport position.
- `xd_apply_design_tokens` stores JSON on root `pluginData`; it does not create native swatches,
  character styles, or component assets.

## Live-vs-mock verification rule

Plugin handler tests run the actual `ops.js` in a VM with mocked XD modules. MCP/protocol tests use
an in-process mock plugin. They prove validation/control flow only, not live host compatibility.
Only an XD 61.0.12.1 session with the reloaded plugin can verify newly added authoring operations.
