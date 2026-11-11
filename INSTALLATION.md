# Installation

## 1. What is already installed (completed 2026-11-10)

Everything on the OpenCode side is installed and verified:

| Component | Location | Status |
|---|---|---|
| MCP bridge (Node 26, TypeScript) | `%LOCALAPPDATA%\OpenCode\AdobeXD-DesignBridge\bridge` | Tested, connected |
| OpenCode MCP registration | `~\.config\opencode\opencode.json` (`adobe-xd` server) | `✓ connected` |
| Design agent | `~\.config\opencode\agents\design.md` | Discovered, mode `all` |
| 10 design skills | `~\.config\opencode\skills\` | All discovered |
| UXP plugin source | `%LOCALAPPDATA%\OpenCode\AdobeXD-DesignBridge\xd-plugin` | Implemented, pending UDT load |

Backup of the pre-existing configuration: `~\.config\opencode\backup-2026-11-10\`.

Dependencies: only `ws` (isolated inside `bridge/` via pnpm). Node used is the mise-managed
`C:\Users\Omar\AppData\Local\mise\installs\node\26.13.0\node.exe` (any Node ≥ 22.6 works).

## 2. Adobe XD 61.0 and UXP Developer Tool (verified installed — 2026-11-10 reconciliation)

> **Correction:** an earlier version of this document said XD 61.0 was missing. That was wrong —
> the initial audit only checked conventional install paths (Program Files, registry
> uninstall entries, Start Menu folders), which MSIX packages bypass. Verification from the
> same user context (`desktop-dqp5dd3\omar`):

- **Adobe XD 61.0.12.1** — MSIX package `Adobe.XD_61.0.12.1_x64__pc75e8sa7ep4e`
  - Install location: `C:\Program Files\WindowsApps\Adobe.XD_61.0.12.1_x64__pc75e8sa7ep4e`
  - Executable: `XD.exe` in that location; observed **running** (process `XD`)
  - Package data: `%LOCALAPPDATA%\Packages\Adobe.XD_pc75e8sa7ep4e`
- **Adobe UXP Developer Tools** — conventional install at
  `C:\Program Files\Adobe\Adobe UXP Developer Tools\Adobe UXP Developer Tools.exe`
  (Electron app, listed in Start Menu as "Adobe UXP Developer Tools"; observed running)
- **Plugin infrastructure present** (created by the shared UXP host services):
  - Dev-plugin registry: `%APPDATA%\Adobe\UXP\PluginsInfo\v1\XD.json` (currently `{"plugins":[]}`)
  - Staging target: `%APPDATA%\Adobe\UXP\Plugins\External\`

No MSIX-specific limitation was found: XD 61 registers a UXP plugin registry and UDT's
"Add Plugin → Load" flow stages dev plugins into the paths above. UDT offers **no CLI for
plugin loading** (verified by inspecting its app bundle; only debug args exist), so the load
step below is a one-time manual action.

## 3. Load the Design Bridge plugin into XD (one-time, ~1 minute)

1. Open **Adobe UXP Developer Tools** (Start Menu → "Adobe UXP Developer Tools").
2. Click **Add Plugin** → select
   `%LOCALAPPDATA%\OpenCode\AdobeXD-DesignBridge\xd-plugin\manifest.json`.
3. In the plugin list, click **Load** next to "OpenCode Design Bridge"
   (focuses/launches XD; the panel appears under **Plugins → Panels → OpenCode Design Bridge**).
4. Get the bridge token (the MCP server that OpenCode launches hosts the WebSocket server; this
   command only prints the token):
   ```powershell
   C:\Users\Omar\AppData\Local\mise\installs\node\26.13.0\node.exe `
     C:\Users\Omar\AppData\Local\OpenCode\AdobeXD-DesignBridge\bridge\bin\bridge.ts --show-token
   ```
5. Paste the token into the panel and click **Connect**. Status shows
   `Bridge: connected (127.0.0.1:27183)`.
6. Mutating operations are queued by design (XD's documented edit-context rule): click
   **Execute pending (N)** in the panel — or enable **Auto-execute on next panel interaction** —
   to run them inside a single undoable batch.

> If the panel cannot reach the bridge: keep an OpenCode session open (it spawns the bridge), or
> run a standalone bridge for testing: `node bridge\bin\bridge.ts`. Only one plugin connection
> is accepted at a time (see TROUBLESHOOTING).

## 4. Smoke test (disposable document)

1. In XD, create a **new empty document** (never use a real project for tests).
2. In OpenCode, select the **design** agent and ask: "Run xd_health, then create a test artboard
   named BridgeTest 200x200 and export it."
3. Expected: artboard appears in XD, a PNG lands in `exports/`, and the returned message includes
   image content.

## 5. Run the automated test suite

```powershell
cd %LOCALAPPDATA%\OpenCode\AdobeXD-DesignBridge\bridge
& C:\Users\Omar\AppData\Local\mise\installs\node\26.13.0\node.exe --test --test-timeout=30000 ..\tests\mcp.test.ts ..\tests\protocol.test.ts
```

Expected: 16 pass, 0 fail (does not require XD; uses an in-process mock plugin).

## 6. Optional: Python 3 (for ui-ux-pro-max search scripts)

The `ui-ux-pro-max` skill works without Python (falls back to its Quick Reference data), but its
BM25 search scripts need Python 3 (standard library only). Install from
https://www.python.org/downloads/ (user scope) if you want the search features; the skill
explicitly instructs agents never to install Python themselves.
