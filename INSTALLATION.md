# Installation

Two paths: the installer (recommended) or a manual setup. Both assume **Windows
10/11** — the prototype-authoring and panel-Apply features use Windows UI
Automation, so macOS and Linux are not supported.

| Component | Version | Why |
|---|---|---|
| Adobe XD | 61.x | The host application |
| UXP Developer Tool | current | Loads the panel plugin (one time) |
| Node.js | ≥ 22.6 | Runs the TypeScript bridge directly; no build step |
| PowerShell | 5.1+ (7 recommended) | Installer and the UIA worker |
| OpenCode | current | Hosts the MCP server and the agent |
| Git | any | Clone/update |

---

## 1. Installer

```powershell
git clone https://github.com/greatomar/adobe-xd-design-bridge.git
cd adobe-xd-design-bridge
pwsh -File .\install.ps1
```

What it does, in order:

1. **Prerequisites** — Windows, Node ≥ 22.6, `bridge/bin/bridge.ts`,
   `xd-plugin/manifest.json`; reports Adobe XD and the UXP Developer Tool if found.
   A missing XD is a warning, not a failure.
2. **Dependencies** — `npm install` inside `bridge/` (the only dependency is `ws`).
3. **Token** — runs `node bin/bridge.ts --show-token`, which creates
   `bridge/.bridge-token` (mode 0600) if missing.
4. **MCP registration** — copies `opencode.json` to
   `opencode.json.bak-<timestamp>`, then merges:

   ```jsonc
   "mcp": { "servers": { "adobe-xd": { ... } } }
   ```

   `scripts/merge-mcp.mjs` accepts JSONC (comments, trailing commas) and preserves
   every other key. If your config cannot be parsed, the installer stops with a
   message and prints the block to add by hand — it never overwrites blind.
5. **Agent and skills** — copies `agents/design.md` and `skills/*` into
   `%USERPROFILE%\.config\opencode\`. Existing files are kept unless `-Force`.
6. **Next steps** — prints the UXP load instructions, the token and a smoke test.

### Flags

| Flag | Effect |
|---|---|
| `-SkipOpenCodeConfig` | Do not modify `opencode.json`; print the block |
| `-SkipSkills` | Install the agent only |
| `-Force` | Overwrite existing agent/skill files |
| `-WhatIf` | Show planned actions, change nothing |

### Where things end up

| Path | Contents |
|---|---|
| `bridge/` | MCP server, `node_modules`, `.bridge-token`, `bridge.log` |
| `xd-plugin/` | UXP panel source (loaded by reference, not copied) |
| `%USERPROFILE%\.config\opencode\opencode.json` | `mcp.servers["adobe-xd"]` |
| `%USERPROFILE%\.config\opencode\agents\design.md` | design agent |
| `%USERPROFILE%\.config\opencode\skills\<7 skills>` | XD, UX, tokens, visual, QA, prototyping, accessibility |
| `exports/` | PNG exports requested by tools (git-ignored) |
| `asset-cache/` | downloaded icons/fonts with a sha256 manifest (git-ignored) |

---

## 2. Manual setup

### 2.1 Dependencies and token

```powershell
cd bridge
npm install
node bin\bridge.ts --show-token
```

Node must be ≥ 22.6 for native TypeScript execution. Keep the printed token.

### 2.2 Register the MCP server

Edit (or create) `%USERPROFILE%\.config\opencode\opencode.json` and merge — do not
replace — this block:

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
  },
  "plugins": ["...keep your existing entries..."]
}
```

Why each field matters:

- **absolute Node path** — OpenCode spawns MCP servers from its own environment;
  a bare `node` may resolve to nothing or to a different version.
- **`cwd`** — relative imports, `.bridge-token`, logs and exports resolve from
  `bridge/`.
- **`execution: 600000`** — prototype graph authoring drives XD's UI one wire at a
  time and can take minutes.
- **`XD_BRIDGE_VERBOSE=0`** — keeps stderr quiet; set `1` while diagnosing.

Alternatively, run the merge helper directly:

```powershell
node scripts\merge-mcp.mjs `
  --config "$env:USERPROFILE\.config\opencode\opencode.json" `
  --node (Get-Command node).Source `
  --bridge "$PWD\bridge\bin\bridge.ts" `
  --cwd "$PWD\bridge"
```

### 2.3 Agent and skills

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\agents" | Out-Null
Copy-Item agents\design.md "$env:USERPROFILE\.config\opencode\agents\" -Force
Copy-Item skills\* "$env:USERPROFILE\.config\opencode\skills\" -Recurse -Force
```

`adobe-xd-specialist` is effectively mandatory: it carries the verified XD API
facts (document model, `SceneNodeList` semantics, style mappings, failure codes).
The other six are design-quality skills the agent loads by phase.

### 2.4 Load the plugin (one time, ~1 minute)

1. Open **Adobe UXP Developer Tool** (Start Menu → "Adobe UXP Developer Tools").
2. **Add Plugin** → select `xd-plugin\manifest.json`.
3. Click **Load** next to "OpenCode Design Bridge". XD opens the panel under
   **Plugins → Panels → OpenCode Design Bridge**.
4. Paste the token and press **Connect** → `Bridge: connected (127.0.0.1:27183)`.
5. Mutating operations are queued by design: press **Apply N** in the panel, or
   enable **Auto-apply on next panel interaction**.

> The bridge process is hosted by OpenCode (it is the MCP server). If the panel
> cannot connect, keep an OpenCode session open or run a standalone bridge:
> `node bridge\bin\bridge.ts`. Only one plugin connection is accepted at a time.

---

## 3. Verify

1. In XD, create a **new empty document** (never test on a real project).
2. Restart OpenCode and pick the **design** agent.
3. Ask: *"Run `xd_health`, then `xd_get_capabilities`."*
   Expected: `ok: true`, bridge version `2.0.0`, `xdConnected: true`.
4. Smoke test: *"Create an artboard `BridgeTest` 390×844, add a rectangle and a
   text label, then export it."*
   Expected: the artboard appears in XD, a PNG lands in `exports/`, and the tool
   result includes the image content.

---

## 4. Run the test suite

The suite does not need Adobe XD (it uses an in-process fake plugin):

```powershell
cd bridge
node --test --test-timeout=60000 ..\tests\
```

Expected: **320 pass, 0 fail** (~11 s).

---

## 5. Optional extras

- **Python 3** — only for the `ui-ux-pro-max` skill's search scripts (standard
  library only). The skill degrades gracefully without it.
- **Third-party skills** (`frontend-design`, `impeccable`, `ui-ux-pro-max`) are
  **not** bundled: they are not this project's content and carry their own
  licenses. Install them from their upstream repositories if you want them.
- **A vision-capable model** — screenshot critique is far more reliable with one.

---

## 6. Upgrade / uninstall

**Upgrade:**

```powershell
git pull
cd bridge; npm install
# restart OpenCode; reload the plugin in UDT if the manifest changed
```

**Uninstall:**

1. Remove the `"adobe-xd"` entry from `opencode.json` (a backup exists next to it).
2. Delete `%USERPROFILE%\.config\opencode\agents\design.md` and the seven bundled
   skill folders.
3. Remove the plugin from UXP Developer Tool.
4. Delete the repository folder (this also removes the token, logs and caches).

---

## 7. Known environment facts

- Adobe XD 61 often installs as an MSIX package
  (`C:\Program Files\WindowsApps\Adobe.XD_61.*`). Conventional install-path checks
  can miss it — use `Get-AppxPackage Adobe.XD`.
- UXP Developer Tool has **no CLI** for loading plugins; the load step is manual by
  design.
- The UIA worker refuses to act when XD is minimised, locked or behind a UAC
  prompt, and reports that instead of clicking blind.
- Windows shows the panel's WebSocket only on `127.0.0.1:27183` (configurable via
  `XD_BRIDGE_PORT`); the token is never transmitted off-machine.
