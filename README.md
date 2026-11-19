# OpenCode · Adobe XD Design Bridge — v2.0

**A local-first MCP bridge that lets an AI design agent build real, editable Adobe XD documents — including authoring prototype wires that XD's plugin API refuses to create — plus a design-asset intelligence layer for icons, type and component patterns.**

[![Version](https://img.shields.io/badge/version-2.0.0-blueviolet)](#whats-new-in-20)
[![Tests](https://img.shields.io/badge/tests-320%2F320-brightgreen)](#testing)
[![MCP tools](https://img.shields.io/badge/MCP%20tools-78-blue)](#mcp-tool-surface)
[![XD plugin](https://img.shields.io/badge/XD%20plugin-2.0.0-purple)](#the-xd-plugin)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.6-339933)](#requirements)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**العربية:** [README.ar.md](README.ar.md) — شرح كامل بالعربية.

---

## Why this exists

Most "AI + design tool" integrations stop at generating HTML/CSS mockups or text
descriptions. This project does the opposite: every design decision becomes a
**real scenegraph node** inside Adobe XD — rectangles, paths, text, groups — that
a designer can open, edit and export.

Three hard rules shape the architecture:

1. **No fake success.** A queued operation is not an executed operation. The
   bridge only reports what the XD plugin actually did, with per-operation
   results read back from the document.
2. **No bypassing XD.** Writes run inside `application.editDocument`, triggered
   by a real panel gesture. The plugin cannot silently mutate a file.
3. **No pretending about platform limits.** Where XD's public API has a hard
   ceiling (prototype wires, component masters, gradient-on-text), the bridge
   either uses a documented fallback — Windows UI Automation driving XD's own UI
   — or says plainly that it cannot.

---

## What's new in 2.0

Version 2.0 is the first release where the bridge can **author prototype
interactions**, not just verify them.

| Area | 1.x | 2.0 |
|---|---|---|
| Prototype wires | read/verify only | `xd_create_prototype_interaction` + `xd_create_prototype_graph` via Windows UI Automation, every wire proven by a UXP read-back |
| Panel execution | manual only | `xd_pending_status` / `xd_apply_pending` / `xd_verify_pending` drive the real Apply button and confirm `batchExecuted` |
| Mutation safety | partial | verified contracts for `move_node`, `resize_node`, `reparent_node`, `update_node`; `MUTATION_VERIFICATION_FAILED` instead of silent no-ops |
| Screens | one node per call | `xd_create_screen` builds a whole screen in one undoable transaction |
| Capability discovery | none | `xd_get_capabilities`, `xd_get_prototype_grammar`, `xd_probe_xd_automation` |
| Install | manual, machine-specific | `install.ps1` + bundled `design` agent and 7 original skills |
| Tool surface | 72 | **78** |
| Tests | 196 | **320** |

Full history: [CHANGELOG.md](CHANGELOG.md).

---

## Architecture

```
┌──────────────────────────┐        MCP (stdio, JSON-RPC 2.0)
│  OpenCode design agent   │◄───────────────────────────────────┐
└────────────┬─────────────┘                                    │
             │ tools["adobe-xd"].*                             │
┌────────────▼──────────────────────────┐                       │
│  bridge (Node.js, TypeScript)         │                       │
│  ├ tools.ts        78 MCP tools       │                       │
│  ├ operations.ts   whitelist + schema │                       │
│  ├ automation/     UIA worker client  │──┐                    │
│  └ assets/         registry · search  │  │                    │
└────────────┬──────────────────────────┘  │ PowerShell + UIA   │
             │ ws://127.0.0.1:27183        │                    │
┌────────────▼──────────────────────────┐  │  ┌──────────────────▼──┐
│  XD plugin (UXP panel, plain JS)      │  │  │ XD's own UI:        │
│  ├ ops.js       55 document operations│  │  │ Layers list +       │
│  ├ executor.js  batch driver          │  │  │ Interaction pane    │
│  └ main.js      queue, UI, reconnect  │  │  └─────────────────────┘
└────────────┬──────────────────────────┘  │
             │ application.editDocument     │
┌────────────▼──────────────────────────┐◄─┘
│  Adobe XD 61 · live scenegraph        │
└───────────────────────────────────────┘
```

**Division of responsibility:** the plugin owns all document knowledge; the
bridge owns validation, orchestration, assets and the UIA fallback; the agent
owns design judgement.

---

## Requirements

### Software

| Component | Minimum | Notes |
|---|---|---|
| **Windows** | 10 21H2 / 11 | Windows UI Automation is required for prototype authoring and panel Apply |
| **Adobe XD** | 61.x | MSIX or Creative Cloud install both work |
| **UXP Developer Tool** | current | Needed once, to load the panel plugin |
| **Node.js** | ≥ 22.6 | Native TypeScript execution — no build step |
| **OpenCode** | current | Must support local MCP servers + Code Mode |
| **PowerShell** | 5.1+ (7 recommended) | The UIA worker is a PowerShell script |
| Git | any | Only to clone/update |

Only one runtime dependency: `ws`.

### What OpenCode specifically needs

This is the part most people get wrong. The bridge is a **local MCP server**; the
rest of the setup is what makes the agent actually useful.

| Requirement | Why | Installed by |
|---|---|---|
| **MCP server registration** in `~/.config/opencode/opencode.json` → `mcp.servers["adobe-xd"]` | Without it the tools never appear in the session | `install.ps1` (or manual step 2) |
| **Absolute Node path** in `command` | OpenCode spawns MCP servers from its own environment; a bare `node` may not resolve | `install.ps1` resolves it with `Get-Command node` |
| **`cwd` set to `bridge/`** | Relative imports, `.bridge-token`, logs and exports resolve from there | `install.ps1` |
| **Long execution timeout** (`600000` ms) | Prototype graph authoring drives a UI one wire at a time | `install.ps1` default config |
| **The `design` agent** at `~/.config/opencode/agents/design.md` | Holds the execution contract: queued ≠ applied, verification levels, stop conditions | Bundled in `agents/`, copied by installer |
| **The 7 original skills** at `~/.config/opencode/skills/` | `adobe-xd-specialist` is the API reference; the others cover UX, tokens, visual direction, QA, prototyping, accessibility | Bundled in `skills/`, copied by installer |
| **XD running with the panel loaded and connected** | The MCP tools are lifeless without a plugin holding the WebSocket | Manual, one time |
| **A vision-capable model** (recommended) | Screenshot critique needs to actually see the exported PNG | Your OpenCode model config |

**Not required:** API keys, cloud accounts, internet access, Python. (Asset
search uses the network when available; everything else works offline. Python is
only needed for the optional `ui-ux-pro-max` search scripts.)

---

## Install (5 minutes)

### Option A — one command

```powershell
git clone https://github.com/greatomar/adobe-xd-design-bridge.git
cd adobe-xd-design-bridge
pwsh -File .\install.ps1
```

The installer:

1. checks Windows, Node ≥ 22.6, Adobe XD and the UXP Developer Tool;
2. installs the single dependency (`ws`) in `bridge/`;
3. generates `bridge/.bridge-token` if missing;
4. **backs up** `~/.config/opencode/opencode.json`, then merges the `adobe-xd`
   MCP server entry (existing servers and plugins are preserved);
5. copies `agents/design.md` and the bundled skills into `~/.config/opencode/`;
6. prints the exact remaining manual steps (UDT load, token paste, smoke test).

Useful flags:

| Flag | Effect |
|---|---|
| `-SkipOpenCodeConfig` | Do not touch `opencode.json`; print the block to add yourself |
| `-SkipSkills` | Only install the agent, not the skills |
| `-Force` | Overwrite existing agent/skill files |
| `-WhatIf` | Show what would change |

### Option B — manual

```powershell
# 1. dependency + token
cd bridge
npm install
node bin\bridge.ts --show-token
```

```jsonc
// 2. ~/.config/opencode/opencode.json  (merge, do not replace)
{
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

```powershell
# 3. agent + skills
Copy-Item agents\design.md $env:USERPROFILE\.config\opencode\agents\ -Force
Copy-Item skills\*        $env:USERPROFILE\.config\opencode\skills\ -Recurse -Force
```

**4. Load the plugin (one time).** Open **Adobe UXP Developer Tool** →
**Add Plugin** → select `xd-plugin/manifest.json` → **Load**. In XD open
**Plugins → Panels → OpenCode Design Bridge**, paste the token, press **Connect**.

### Verify

Restart OpenCode, start a session, choose the **design** agent (or any agent
with the MCP server enabled), and ask:

> Run `xd_health`, then check `xd_get_capabilities`.

Expected: `bridge.ok: true`, a `link` object, and `xdConnected: true` once the
panel is connected. Then the smoke test:

> Create an artboard named `BridgeTest` 390×844, add a rectangle and a text
> label, then export it.

The artboard must appear in XD and a PNG must land in `exports/`.

Detailed, failure-by-failure instructions: [INSTALLATION.md](INSTALLATION.md).

---

## How OpenCode uses the bridge

### 1. Tools appear only after the MCP server starts

Tool names are exposed as `tools["adobe-xd"].xd_*` in Code Mode. If a session
was started before you edited `opencode.json`, restart OpenCode — MCP servers are
spawned at session start.

### 2. Reads are immediate, writes are queued

This is the contract every agent must respect:

| Call | Meaning |
|---|---|
| `xd_create_rectangle` → `{queued: true, operationId}` | The plugin *holds* the work. The document has **not** changed |
| Panel **Apply** / auto-apply | The plugin drains the queue inside one `editDocument` transaction (one undo step) |
| `xd_get_operation_status` / `xd_verify_pending` | Proves what actually applied |
| `xd_execute_batch` | Whole screen in one transaction, with per-operation results |

The bridge will never report a mutation as applied without a read-back. If a
host ignores a request, you get `MUTATION_VERIFICATION_FAILED`, not `ok: true`.

### 3. Prototype authoring is the one UI-automated path

XD's plugin API is **read-only** for interactions. The bridge therefore drives
XD's own interface through Windows UI Automation:

- `xd_create_prototype_interaction` — one wire (`source → target`, tap, dissolve,
  duration). Returns `created: true` **and** `verified: true` only when the
  document contains it.
- `xd_create_prototype_graph` — many edges, serial, each verified, idempotent
  (`already_exists`), non-destructive (`conflict`), `fail_fast`/`continue_on_error`.
- `xd_validate_prototype_plan` — read-only preflight that reports every blocker
  before anything is authored.
- `xd_get_prototype_grammar` — the measured set of authorable trigger/action/
  transition combinations.

Constraints worth knowing:

- XD exposes **no delete API** for interactions, and no read/write of slide
  direction. Removing or re-timing a wire is a manual edit in XD.
- The UIA worker needs XD **visible, unlocked and not behind a UAC prompt**; it
  refuses rather than clicking blind.
- One interaction per call — the graph tool serialises and verifies each edge.

### 4. Design work is batched

`xd_execute_batch` is the recommended path for anything larger than a few nodes:
one panel execution, one undo entry, per-operation results. The agent is
instructed to build screens this way and then export for visual QA.

---

## MCP tool surface

**78 tools**, all validated against a schema registry before they reach XD.

| Area | Tools |
|---|---|
| Connection & discovery | `xd_health`, `xd_get_capabilities`, `xd_get_document_info`, `xd_get_artboards`, `xd_get_selection`, `xd_search_nodes`, `xd_inspect_node` |
| Build | `xd_create_screen`, `xd_create_artboard`, `xd_create_rectangle`, `xd_create_ellipse`, `xd_create_line`, `xd_create_polygon`, `xd_create_path`, `xd_create_text`, `xd_create_image`, `xd_create_group`, `xd_create_mask_group` |
| Components | `xd_create_component`, `xd_create_component_variants` |
| Edit | `xd_update_node`, `xd_update_text`, `xd_move_node`, `xd_resize_node`, `xd_rotate_node`, `xd_reparent_node`, `xd_duplicate_node`, `xd_delete_node`, `xd_ungroup`, `xd_arrange_nodes`, `xd_align_nodes`, `xd_distribute_nodes`, `xd_align_to_pixel_grid`, `xd_reset_3d_transforms` |
| Style & systems | `xd_apply_style`, `xd_apply_design_tokens`, `xd_set_layout`, `xd_set_constraints`, `xd_make_background`, `xd_replace_background` |
| Vectors | `xd_update_path`, `xd_convert_to_path`, `xd_outline_stroke` |
| Execution | `xd_execute_batch`, `xd_execute_operation`, `xd_get_operation_status`, `xd_preview_operation`, `xd_pending_status`, `xd_apply_pending`, `xd_verify_pending` |
| Prototype | `xd_get_prototype_state`, `xd_validate_prototype`, `xd_get_prototype_grammar`, `xd_prototype_plan`, `xd_prototype_focus`, `xd_prototype_prepare`, `xd_prototype_verify`, `xd_create_prototype_interaction`, `xd_create_prototype_graph`, `xd_validate_prototype_plan`, `xd_probe_xd_automation` |
| Audit & output | `xd_audit_screen`, `xd_inspect_design_consistency`, `xd_validate_document`, `xd_export_artboard`, `xd_export_selection`, `xd_capture_design_preview` |
| Assets (9) | `design_asset_search`, `design_asset_inspect`, `design_asset_get`, `design_asset_license`, `design_asset_recommend`, `design_asset_insert`, `design_asset_apply_font`, `design_asset_list_sources`, `design_asset_list_categories` |
| Context (2) | `design_context_get`, `design_context_set` |

### Design asset intelligence

- **Search** across a curated registry plus live Iconify sets — Lucide, Phosphor,
  Tabler, Heroicons, Material Symbols, Simple Icons — with explained ranking
  (`reasons` on every hit).
- **Typography** metadata from Google Fonts: weights, styles, subsets, Arabic
  support, recommended and inappropriate uses.
- **Design context** persisted to disk so later choices stay consistent (one
  icon family, one type scale, one radius system).
- **Licence safety**: commercial use, attribution, redistribution and an
  `uncertain` flag that excludes assets from production searches.
- **Insertion as real vectors**: SVG geometry becomes editable XD `Path` nodes —
  never a screenshot, never a flattened bitmap.
- **Caching** in `asset-cache/` with a sha256 manifest, dedupe and invalidation.

Sources that cannot be legally automated (Figma Community, unDraw, DrawKit,
3Dicons, Lottie/Rive, browser mockup tools) are catalogued as **reference only**
with their real terms — and never scraped.

---

## The XD plugin

Version **2.0.0**. Plain JavaScript, no build step, no libraries.

- **Execution gate** — `application.editDocument` only runs from a panel UI
  event; the panel drains the queue in one transaction (single undo entry).
- **Completion contract** — `executor.js` settles on the *edit callback's*
  promise, not on `editDocument`'s return value (which is `undefined` in XD 61),
  and guarantees exactly one settle.
- **Fail-fast batches** — a failing operation aborts the remainder and the
  results list says exactly what applied.
- **Panel UI** — status pill, auto-apply switch, collapsed connection settings,
  activity log, token field.

---

## Project layout

```
bridge/                MCP server (TypeScript, run directly by Node)
  bin/bridge.ts        entrypoint (--show-token, --mock)
  src/tools.ts         78 MCP tools
  src/operations.ts    validated document-operation registry
  src/automation/      Windows UI Automation client, grammar, preflight, batch
  src/assets/          registry · sources · search · cache · svg · context
xd-plugin/             UXP panel: manifest, ops.js, executor.js, main.js, index.html
automation/            PrototypeAutomation PowerShell UIA worker + live evidence
agents/design.md       the OpenCode design agent (execution contract)
skills/                7 original OpenCode skills (XD, UX, tokens, visual, QA, proto, a11y)
tests/                 node:test suites (offline, deterministic)
docs/                  schemas, capability matrix, automation, contracts
examples/              sample design payloads
install.ps1            installer
```

---

## Documentation

| Document | Contents |
|---|---|
| [INSTALLATION.md](INSTALLATION.md) | Prerequisites, installer internals, manual setup, smoke tests, uninstall |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Internals and design decisions |
| [TESTING.md](TESTING.md) | What is covered and how to run it |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Failure modes and their fixes |
| [docs/opencode-integration.md](docs/opencode-integration.md) | MCP registration, agent, skills, permissions |
| [docs/mcp-operation-schema.md](docs/mcp-operation-schema.md) | Every tool and its parameters |
| [docs/xd-capability-matrix.md](docs/xd-capability-matrix.md) | What XD's API can and cannot do |
| [docs/prototype-gui-automation.md](docs/prototype-gui-automation.md) | UIA authoring layer, exposed controls, failure codes |
| [docs/prototype-wiring-workflow.md](docs/prototype-wiring-workflow.md) | Flow manifests, planning and verification states |
| [docs/apply-pending-automation.md](docs/apply-pending-automation.md) | Panel Apply automation |
| [docs/mutation-contracts.md](docs/mutation-contracts.md) | Measured move/resize/reparent/update contracts |
| [docs/asset-intelligence.md](docs/asset-intelligence.md) | Asset sources, licensing, search, caching, insertion |
| [docs/xd-api-limitations.md](docs/xd-api-limitations.md) | The honest ceiling list |

---

## Testing

```powershell
cd bridge
node --test --test-timeout=60000 ..\tests\
```

**320/320 passing** (Node 26, ~11 s, offline):

- MCP protocol, tool registry, argument validation
- Plugin handlers against a fake XD runtime (including `SceneNodeList` semantics)
- Batch executor: async completion, duplicate callbacks, picker cancellation
- Prototype automation: grammar, preflight, graph batching, pending-apply, policy
- Mutation contracts and read-back verification
- Asset layer: registry, licence gates, ranking, cache dedupe/tamper, path
  traversal, SVG parsing, path transforms, XD insertion

No XD installation is required for the suite; network calls are injected fakes.

---

## Troubleshooting (short list)

| Symptom | Cause | Fix |
|---|---|---|
| No `adobe-xd` tools in session | MCP server not registered, or session started before the edit | Check `opencode.json`, restart OpenCode |
| `xdConnected: false` | Panel not loaded/connected | UDT → Load plugin → paste token → Connect |
| `EADDRINUSE 27183` | A second bridge is running | Close the other OpenCode session or set `XD_BRIDGE_PORT` |
| Operations stay `queued` | Panel gesture required by XD | Press **Apply N** or enable auto-apply |
| UIA tools fail | XD minimised, locked or behind UAC | Bring XD to the foreground, unlock, retry |
| Prototype wire not found after authoring | It was authored in a different document/window | `xd_validate_prototype` will name the missing edge |

Full list: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Security model

- **Local only** — WebSocket bound to `127.0.0.1`, token-authenticated
  (`.bridge-token`, mode 0600, git-ignored).
- **Whitelist** — operations are validated against a schema registry; arbitrary
  code, paths and URLs are not expressible.
- **No background edits** — XD requires a user gesture for every write.
- **No scraping** — assets come from documented APIs or are reference-only.
- **Secrets excluded** — tokens, logs, exports and caches are git-ignored.

See [SECURITY.md](SECURITY.md).

---

## Tested environment & Adobe licensing

Developed and verified against:

- Windows 11, Adobe XD **61.0.12.1** (MSIX), UXP Developer Tool current,
  Node 26 (mise-managed), OpenCode with Code Mode.

**About Adobe activation:** in the author's local environment the Creative Cloud
entitlement is activated with **GenP v4.2.1**. That is a statement about the
machine this was tested on, not a recommendation: this repository contains **no
Adobe software, no patcher, no activation data and no links to any of them**. The
bridge only speaks to an already-installed XD over `127.0.0.1`.

You are responsible for holding whatever licence your use of Adobe XD requires.
If you prefer a clean-room document, delete this section — nothing in the code
depends on it.

---

## Status & scope

This is an engineering project, not a product. XD's public plugin API has hard
limits — no component masters with full API access, no prototype wiring
authoring, no gradient-on-text — and the bridge reports them honestly instead of
simulating them. Prototype authoring exists only because XD's own UI is driven
through Windows UI Automation, and every result is still proven through the
plugin's read-back.

## License

MIT © 2026 greatomar — see [LICENSE](LICENSE).

Third-party assets are **not** bundled. Icon sets, fonts and design resources
referenced by the asset layer keep their own licenses (ISC, MIT, Apache-2.0,
CC0, OFL), recorded per asset and surfaced by `design_asset_license`.
