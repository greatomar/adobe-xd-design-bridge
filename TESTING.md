# Testing

## Automated test suite (passing: 156/156, 2026-11-11)

Run from `bridge/`:

```powershell
& C:\Users\Omar\AppData\Local\mise\installs\node\26.13.0\node.exe --test --test-timeout=30000 `
  ..\tests\mcp.test.ts ..\tests\protocol.test.ts ..\tests\plugin-ops.test.ts `
  ..\tests\agent-contract.test.ts ..\tests\agent-workflow.test.ts
```

### tests/agent-contract.test.ts (11 tests) — agent/skill policy lint

Asserts the global agent contract stays honest and complete: both modes + self-recursion blocked,
the 14-state machine in order, forbidden `QUEUE → READ_BACK` shortcuts, `Execute pending`
requirement, nested execution-result correlation, GUID harvesting, screen-specific semantic
manifests, 5–15 op batches, LEVEL 1–7 definitions and gates, supported scenegraph/prototype tools,
and skill facts (SceneNodeList, flat batch shape, `fontStyle`, queue-depth limitation). It also
fails if a known-false claim returns (nonexistent `xd_group_nodes`, "creates native styles").

### tests/agent-workflow.test.ts (20 tests) — executable execution contract

`tests/workflow-harness.ts` models the panel queue (in-memory, user-clicked, lost on reload), the
bridge envelope, a fake document, read-back and evidence levels.

| Case | Asserts |
|---|---|
| stops after artboards | LEVEL 4 max; empty export → `empty_export`; no LEVEL 5 claim |
| queues but does not wait | `VERIFY_EXECUTION`/`READ_BACK` are illegal from `WAIT_FOR_PANEL_EXECUTION` |
| user has not clicked | queue depth 1, no event, new batches blocked, nothing created |
| execution fails | → `RECOVER`, level unchanged, batch marked failed |
| panel reload with pending | `UNKNOWN_QUEUE_LOST`; blind retry refused; resolve by read-back; single re-queue |
| read-back missing node | `missing_node` → `RECOVER` |
| wrong parent | `wrong_parent` rejected |
| invalid dimensions | `invalid_dimensions` rejected |
| empty export | LEVEL 5 not achieved |
| premature claim | `premature_claim` at each level |
| text mapping | `fontStyle` + `fill` use documented keys; lineHeight is node-level |
| text continuation | text is read back in one verified content batch |
| multi-screen | 4 panel executions, LEVEL 7 only after 2 rendered screens |
| GUID provenance | parent must come from execution; invented GUID fails |
| rendered content | render gate is explicit when requested; no false visual claim |
| screen-only artboard | fails all screen roles |
| placeholder-only | fails missing text/chart/table semantic roles |
| missing section | screen-specific manifest flags the unbuilt section |
| completed screen | manifest passes; optional render gate remains separate |

**What these tests do not prove:** they simulate XD. They validate the *protocol and evidence
gates*, not live rendering, fonts, or the plugin's `editDocument` timing. Only the live checklist
below can establish LEVEL 5 against real Adobe XD.

### tests/plugin-ops.test.ts (55 tests) — real plugin handlers, fake XD runtime

Loads the actual `xd-plugin/ops.js` in a `vm` sandbox with a functional fake scenegraph
(`application`, `scenegraph`, `commands`, `uxp` all mocked). No real XD API is contacted; write
paths mutate the fake tree only.

| Area | Verifies |
|---|---|
| Document access | blank document returns zero counts; multiple artboards; nested groups/shapes traversal; `DocumentInfo` (`name`+`guid`, no `.root`) is a valid handle |
| Parent resolution | explicit parent guid, unknown parent (`node_not_found`), first-artboard default, root fallback |
| Creation | artboards, rectangle, ellipse, line, polygon, path, ImageFill, picker import (mock picker), text; group and mask-group commands |
| Mutation | update, move/resize, rotate, delete, duplicate, leaf reparent, ungroup, arrange/align/distribute, gradients/stroke effects, styles, text, tokens |
| Query/audit | search, validate document, consistency, semantic screen-role audit, prototype flow/edge inspection and required-edge validation |
| Export | `export_artboard` (rendition node/scale, base64, cleanup), `export_selection`, empty selection |
| Failure modes | missing document, missing root, malformed root → structured errors for every scene-dependent op |
| Regression | no handler reads `activeDocument.root`, `.path` or `.modified` (instrumented getters at 0) |
| Live shape | `children` as a `SceneNodeList` (not an Array, no `[i]` access) — all handlers still work |
| Contract | 40 handlers / 14 read-only; batch abort/async import semantics; diagnostics off by default and privacy-safe |

### tests/mcp.test.ts (11 tests) — MCP end-to-end, mock XD plugin

| Test | Verifies |
|---|---|
| MCP handshake and tool discovery | initialize returns protocol 2025-06-18; all 47 `xd_*` tools listed |
| xd_health | bridge status, port, plugin connected (mock) |
| xd_execute_batch e2e | artboard + rectangle creation flows through MCP → WS → plugin, guids returned |
| invalid operations rejected | unknown op, non-numeric frame, invalid hex color, unknown tool → structured errors before execution |
| dry-run | `xd_execute_batch {dryRun:true}` previews without executing |
| point-text normalized validation | omitted text width/height survive repeat batch validation |
| native ops schema | line/polygon/path/import/delete/align arguments validated before queueing |
| export returns image content | image MIME content + saved path under `exports/` |
| xd_apply_design_tokens | contrast report computed (AA pass ≥ 4.5:1, bad pair < 2.5:1) |
| capabilities + op status | capability list, bridge request depth, last event |
| token file | exists, `xdbr-` prefix, ≥ 30 chars |

### tests/protocol.test.ts (7 tests) — wire protocol, real WS server

| Test | Verifies |
|---|---|
| invalid token | close 4004 |
| non-hello first message | close 4001 |
| invalid JSON | close 4003 |
| silence > 3s | close 4001 (auth window) |
| valid handshake | `ready` message; second simultaneous connection refused (4002) |
| request timeout | unresponsive plugin → structured `{ok:false, code:"timeout"}` (800ms test timeout) |
| no plugin connected | structured `{ok:false, code:"xd_not_connected"}` |

## Adobe XD runtime verification

Adobe XD 61.0.12.1 (MSIX, `Adobe.XD_61.0.12.1_x64__pc75e8sa7ep4e`) and UXP Developer Tool
are installed. Last live read-only audit: the **1.0.2** plugin is connected to
`OpenCode-Bridge-Test` (document GUID `49cf0a87-…`), `xd_get_document_info` and
`xd_get_artboards` succeed, and 19 artboards are present. `xd_search_nodes` returned zero
Rectangles, Texts, and Groups. The last execution event was the earlier `PROOF / B1` artboard;
the previously queued 24-op Dashboard batch has no matching execution event. The panel queue
depth is not exposed, so its present state is unknown. Do not reload the panel until that queue
is explicitly executed or discarded by the user.

The v1.0.3 source changes and all automated tests are **not yet live-verified**. After the user
resolves that pending panel work: reload the source in UXP Developer Tool, verify health reports
1.0.3, then test new operations on the scratch document. Mocked tests do not prove real XD
compatibility or visual output.

## Sample design pipeline (ready to execute once XD is connected)

`examples/sample-mobile-design.json` contains the "Solstice Wallet" sample: token set plus
ordered batch operations for a 390×844 screen, with usage steps (create artboard → substitute
guid → run remaining batch → export → critique loop).
