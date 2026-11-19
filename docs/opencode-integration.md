# OpenCode Integration

Everything OpenCode needs to make the bridge useful, and nothing it does not.

## 1. What OpenCode must provide

| Capability | Detail |
|---|---|
| **Local MCP servers** | The bridge is a stdio MCP server (`bridge/bin/bridge.ts`), spawned by OpenCode at session start |
| **Code Mode** | Tools are exposed as `tools["adobe-xd"].xd_*`; the agent calls them through its code runtime |
| **Agents** | `agents/design.md`, mode `all` — selectable as primary and invocable as a subagent |
| **Skills** | `skills/<id>/SKILL.md`; loaded by the agent when a task matches |
| **Long tool timeouts** | `execution: 600000` ms, because prototype authoring drives a UI one wire at a time |

No API keys, no cloud account and no network access are required for the design
path. Asset search uses the network when available.

## 2. MCP registration

`%USERPROFILE%\.config\opencode\opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "adobe-xd": {
        "type": "local",
        "command": ["C:\\Program Files\\nodejs\\node.exe",
                    "C:\\path\\to\\adobe-xd-design-bridge\\bridge\\bin\\bridge.ts"],
        "cwd": "C:\\path\\to\\adobe-xd-design-bridge\\bridge",
        "environment": { "XD_BRIDGE_VERBOSE": "0" },
        "timeout": { "startup": 30000, "catalog": 30000, "execution": 600000 }
      }
    }
  }
}
```

Notes:

- Use an **absolute Node path** — OpenCode starts the server from its own
  environment, where a bare `node` may not resolve.
- `cwd` must be `bridge/`: relative imports, `.bridge-token`, `bridge.log` and
  `exports/` are resolved from there.
- The bridge process hosts the WebSocket server for the XD plugin, so it lives as
  long as the MCP connection.
- The current source defines **78 MCP tools** (`tools.ts`). A session started
  before a config change keeps the old catalog — restart OpenCode.

`scripts/merge-mcp.mjs` performs this merge safely (JSONC-aware, preserves other
servers and plugins).

## 3. Design agent

`agents/design.md` → installed to `%USERPROFILE%\.config\opencode\agents\`.

- ID `design`, mode `all`, color `#7C6BFF`.
- Permissions: read/skill/web allowed; `edit` and `shell` are **ask-gated**; no
  backend/deployment permissions; no self-recursion.
- Body: identity, phase-by-phase skill loading map, execution state machine,
  XD write protocol, verification levels (1-7), stop conditions, delivery report.

**Select as primary:** press Tab / use the agent selector and choose `design`.
**Invoke as subagent:** "Use the design agent to …", or via the `subagent` tool.

**Design → Build handoff:** the delivery report is the contract; Build implements
from it and must not silently replace the approved XD design. When asked, the
design agent also writes machine-readable token JSON into the project.

## 4. Skills

Bundled (original content, MIT with the repository):

| Skill | Purpose |
|---|---|
| `adobe-xd-specialist` | XD document model, tool workflow, queue mechanics, failure codes — load before the first XD call |
| `ux-architecture` | Personas, task inventory, flows, IA, state matrix |
| `design-system-engineering` | Token JSON, component spec cards, scales, cross-artboard consistency |
| `visual-design-direction` | Art direction, anti-generic discipline, composition |
| `visual-qa-and-critique` | Screenshot critique dimensions, findings format, iteration cap |
| `prototyping-and-interaction` | Flow specs, transition vocabulary, XD prototype limits |
| `accessibility-design` | WCAG 2.2 contrast, targets, states, XD representability |

Optional, **not** bundled (upstream licenses): `frontend-design` (Anthropic,
locally adapted), `ui-ux-pro-max` (NextLevelBuilder), `impeccable` (pbakaus).
Install them from their own repositories; see `docs/skills-and-updates.md`.

## 5. Permissions and execution model

The agent never talks to XD directly. Its constraints:

1. **Queued ≠ applied.** `xd_execute_*` returns `{queued:true}`; the panel applies
   the queue inside one `editDocument` transaction.
2. **Ask for panel execution, not design approval.** Panel clicks, ambiguity and
   destructive actions belong to the user.
3. **Read-back before claiming success.** `xd_get_operation_status`,
   `xd_verify_pending`, `xd_validate_document` and exports are the evidence.

`allow` the `adobe-xd` tools in your OpenCode permission config if you use
per-tool rules; otherwise the default (MCP tools allowed) is fine.

## 6. Vision guidance

Keep operation planning on the session's working model; route screenshot critique
through the strongest vision-capable model available in `opencode models`. No new
provider or key is required by this project.

## 7. Reload checklist

After changing `opencode.json`, the agent, a skill, or the plugin:

1. Reload the plugin in UXP Developer Tool (plugin code changes only).
2. Restart the OpenCode session (MCP catalog, agent and skills are read at start).
3. Run `xd_health` and confirm `xdConnected: true` before doing design work.
