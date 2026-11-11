# OpenCode Integration

## Design Agent

`~\.config\opencode\agents\design.md`

- ID: `design` — mode `all` (selectable as a primary agent AND invocable as a subagent).
- Color `#7C6BFF`; description visible to parent agents choosing subagents.
- Permissions: full read/skill/web access; `edit` and `shell` are **ask-gated**; subagent use
  restricted to `design` (review delegation). No backend/database/deployment permissions.
- Body: identity, phase-by-phase skill loading map, 15-step workflow, XD execution rules,
  delivery-report contract (10 sections).

**Select as primary:** In OpenCode press Tab (or use the agent selector) and choose `design`.
**Invoke as subagent:** "Use the design agent to …" from Build/Plan, or via the `subagent` tool
with agent `design`. Other agents can launch it because `subagent` permission rules on *their*
side control spawning (the built-in agents allow it by default).

**Handoff workflow (Design → Build):** the design agent's delivery report is the contract; Build
implements from it and must not silently replace the approved XD design. When the design agent
is asked, it also writes a machine-readable token JSON into the project for Build.

## MCP server

`~\.config\opencode\opencode.json` (global, merged — this file did not exist before; the only
pre-existing file, `service.json`, was preserved and backed up to `backup-2026-11-10\`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "adobe-xd": {
        "type": "local",
        "command": ["C:\\Users\\Omar\\AppData\\Local\\mise\\installs\\node\\26.13.0\\node.exe",
                    "C:\\Users\\Omar\\AppData\\Local\\OpenCode\\AdobeXD-DesignBridge\\bridge\\bin\\bridge.ts"],
        "cwd": "C:\\Users\\Omar\\AppData\\Local\\OpenCode\\AdobeXD-DesignBridge\\bridge",
        "environment": { "XD_BRIDGE_VERBOSE": "0" },
        "timeout": { "startup": 30000, "catalog": 30000, "execution": 600000 }
      }
    }
  }
}
```

Notes:
- Absolute Node path → starts reliably regardless of shell/mise initialization.
- The bridge process hosts the WebSocket server; it runs for the lifetime of the MCP connection.
- Tools appear in Code Mode as `tools["adobe-xd"].xd_*`. Source v1.0.3 defines 47 MCP tools;
  the currently connected MCP process may still expose the previous 29-tool catalog until it is
  reloaded.

## Skill discovery verification (2026-11-10)

`GET /api/skill` returned, without duplicates:
`accessibility-design, adobe-xd-specialist, design-system-engineering, frontend-design,
impeccable, prototyping-and-interaction, ui-ux-pro-max, ux-architecture,
visual-design-direction, visual-qa-and-critique` + built-ins (`browser`, `opencode`, `report`).

`GET /api/agent` returned all built-ins unchanged (`build`, `plan`, `general`, `explore`, hidden
maintenance agents) plus `design` — nothing removed or overridden.

## Vision model guidance (hybrid critic)

Keep operation planning on the session's working model; route screenshot critique through the
strongest available vision-capable model configured in OpenCode (e.g. a frontier multimodal
model among the configured `opencode`/`opencode-go` providers). Check `opencode models` for what
is currently configured; no new providers or API keys were created for this project.
