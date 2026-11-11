# Architecture

## Topology

```
┌─────────────────────────── Windows host ───────────────────────────┐
│                                                                    │
│  OpenCode service                                                  │
│   └─ sessions (Build / Plan / Design agent …)                      │
│        └─ Code Mode → tools["adobe-xd"].xd_*                       │
│              │                                                     │
│              │ MCP over stdio (JSON-RPC 2.0, newline-delimited)    │
│              ▼                                                     │
│  bridge/bin/bridge.ts            (spawned per directory by OpenCode)│
│   ├─ src/mcp-server.ts   — MCP protocol, tools/list, tools/call    │
│   ├─ src/tools.ts        — 47 tool definitions + handlers          │
│   ├─ src/operations.ts   — 41-operation whitelist + validation     │
│   ├─ src/xd-link.ts      — WebSocket SERVER on 127.0.0.1:27183     │
│   │                         token auth, serial queue, timeouts     │
│   └─ src/util.ts         — token, logging, WCAG contrast math      │
│              │                                                     │
│              │ WebSocket (JSON messages; UXP hosts clients only)   │
│              ▼                                                     │
│  Adobe XD 61.0 — UXP panel plugin                                  │
│   ├─ main.js  — WS client, token persistence, execution control    │
│   └─ ops.js   — SceneNode/commands + user-picked asset handlers    │
│              │                                                     │
│              ▼                                                     │
│  XD Document (Artboards, shapes, text, components)                 │
└────────────────────────────────────────────────────────────────────┘
```

## Key design decisions

### 1. The bridge hosts the WebSocket server, the plugin is the client
UXP supports WebSocket **clients**, not servers (verified against Adobe UXP docs). The bridge
therefore listens on `127.0.0.1:27183` and the XD plugin connects out. Local-only binding; no
external exposure.

### 2. Verified edit-context execution model
Adobe's official `application` module reference states `editDocument()` may only be called in
response to a UI event (click, keydown, mousedown, input, …) with the handler on the call stack.
The plugin therefore: executes **read-only operations immediately** (inspection, search,
`application.createRenditions` exports, audits), **queues mutating operations**, and executes the
whole queue inside **one** `editDocument` batch when the user clicks "Execute pending (N)" or —
with the Auto toggle — on the next documented UI event inside the panel (single undo step).
This is the legal execution path; the bridge does not bypass XD's editing restrictions. The
panel executor awaits Promise-returning edit callbacks, as required for native file-picker asset
imports.

### 3. Whitelist registry, not a generic eval surface
`src/operations.ts` defines every allowed operation with strict per-field validation (types,
ranges, hex colors, guid shape, length caps). Anything else is rejected with `invalid_params`
**before** leaving the bridge. There is no operation that forwards arbitrary code, paths, or
commands to XD.

### 4. Serial single-flight queue with timeouts
XD edits run one at a time: the bridge queues requests, sends them one by one, and times out
after 30s (60s for exports, configurable via `XD_BRIDGE_REQUEST_TIMEOUT_MS`). In-flight requests
are failed fast with structured errors if the plugin disconnects.

### 5. Batches are one edit step, not database transactions
`xd_execute_batch` validates every operation before execution, then the plugin awaits the serial
list inside **one** `editDocument` context (one XD undo entry). If a handler fails, the plugin
aborts remaining operations, but earlier successful mutations are not rolled back. Read back the
document after partial failure and never blind-retry. Point-text absent dimensions remain absent
through normalized validation.

### 6. Real image content in MCP responses
`xd_export_artboard` / `xd_export_selection` return the PNG as base64 **image content** to the
calling model (so a vision-capable model can critique it directly) plus a saved file path under
`exports/` for human reference.

### 7. Honest capability reporting
`xd_get_capabilities` reports bridge ops and, when connected, plugin capabilities. Component
masters/variants and prototype wire authoring remain unsupported. Prototype inspection is
read-only. `xd_audit_screen` checks screen-specific semantic role coverage; it does not claim
visual quality.

## Agent/skill layer (OpenCode side)

- `~/.config/opencode/agents/design.md` — the `design` agent, `mode: all` (primary + subagent),
  ask-gated edit/shell, full skill access.
- `~/.config/opencode/skills/` — design, architecture, systems, visual-direction, accessibility,
  XD and frontend craft skills. The global agent owns the state machine and screen construction.
- `~/.config/opencode/opencode.json` — registers the `adobe-xd` MCP server with an absolute
  Node path so it starts reliably without shell initialization.

## Visual QA loop (hybrid vision)

```
xd_execute_batch → xd_export_artboard (image content) → vision-capable model critique
      ▲                                                        │
      └────── validated correction batch ◄── structured findings ◘
```

Iteration is capped (3 critique cycles per artboard by default, enforced by the
`visual-qa-and-critique` skill and the agent prompt) to prevent endless loops.
