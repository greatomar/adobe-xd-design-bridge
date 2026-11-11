# Troubleshooting

## MCP server

**`opencode mcp list` shows the server but not connected**
- Run the entry directly to see the error:
  `C:\Users\Omar\AppData\Local\mise\installs\node\26.13.0\node.exe C:\Users\Omar\AppData\Local\OpenCode\AdobeXD-DesignBridge\bridge\bin\bridge.ts`
- Common causes: port 27183 already bound by another bridge instance (stop it or set
  `XD_BRIDGE_PORT` in the MCP config `environment`), or Node path moved (update the absolute
  path in `~\.config\opencode\opencode.json`).

**Tools missing in an OpenCode session**
- Config changes hot-reload; force with `/reload`. Tools appear in Code Mode under
  `tools["adobe-xd"]`.

## Plugin ↔ bridge connection

**Panel says "unreachable"**
- The bridge process only exists while OpenCode has started the MCP server (it starts
  automatically). Keep an OpenCode session open, or run a standalone bridge for manual testing:
  `node bridge\bin\bridge.ts`.

**"invalid token" / closes with 4004**
- Token mismatch. Print the current token (`--show-token`), re-paste it in the panel, click
  Connect. The panel stores it in the plugin data folder.

**Closes with 4002**
- Another plugin connection is already authenticated (only one is allowed). Close duplicate XD
  windows/panels.

**Connection works, then drops**
- Check `bridge\bridge.log` for the exact sequence. The panel auto-reconnects every 4 s.

## Operations

**`xd_not_connected`**
- XD is not open or the panel is not connected. Connect first, then re-run.

**`unsupported` / `supported:false`**
- The connected XD runtime lacks the API (e.g., programmatic component creation). Use the
  documented alternative in the reason field; record the limitation in the delivery report.

**`timeout`**
- XD was busy (modal dialog open, document saving). Close dialogs; large exports may need more
  time — increase `XD_BRIDGE_REQUEST_TIMEOUT_MS` in the MCP config.

**Fonts look wrong after a text operation**
- The chosen font is not installed; XD falls back silently. Install the font or pick an
  installed family, then re-apply via `xd_apply_style`/`xd_update_text`.

## Logs

- Bridge: `%LOCALAPPDATA%\OpenCode\AdobeXD-DesignBridge\bridge\bridge.log` (set
  `XD_BRIDGE_VERBOSE=1` in the MCP config environment to mirror to stderr).
- OpenCode MCP/connection: `~\.local\share\opencode\log\opencode.log`.
- UXP Developer Tool shows the plugin's console (useful for plugin-side exceptions).

## Recovery

1. Bridge misbehaves: stop all bridge processes (`Get-Process node | where ...`), then let
   OpenCode restart it (config reload or session restart).
2. Plugin stuck: In UXP Developer Tool → ⋯ → **Reload** the plugin.
3. Token compromised: delete `bridge\.bridge-token`, restart the bridge (new token generated),
   re-paste in the panel.
