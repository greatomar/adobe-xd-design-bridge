# OpenCode · Adobe XD Design Bridge

**A local-first MCP bridge that lets an AI design agent build real, editable Adobe XD documents — plus a design-asset intelligence layer for icons, type and component patterns.**

[![Tests](https://img.shields.io/badge/tests-156%2F156-brightgreen)](#testing)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Plugin](https://img.shields.io/badge/XD%20plugin-1.0.6-blueviolet)](#the-xd-plugin)
[![MCP tools](https://img.shields.io/badge/MCP%20tools-67-blue)](#mcp-tool-surface)
[![Runtime](https://img.shields.io/badge/Node.js-%E2%89%A522.6-339933)](#requirements)
[![Transport](https://img.shields.io/badge/transport-127.0.0.1%20only-lightgrey)](#security-model)

---

## Why this exists

Most "AI + design tool" integrations stop at generating HTML/CSS mockups or text
descriptions. This project does the opposite: every design decision becomes a
**real scenegraph node** inside Adobe XD — rectangles, paths, text, groups — that
a designer can open, edit and export.

Two hard rules shape the architecture:

1. **No fake success.** A queued operation is not an executed operation. The
   bridge only reports what the XD plugin actually did, with per-operation
   results read back from the document.
2. **No bypassing XD.** Writes run inside `application.editDocument`, triggered
   by a real panel gesture. The plugin cannot silently mutate a file.

---

## Architecture

```
┌──────────────────────────┐        MCP (stdio, JSON-RPC 2.0)
│  OpenCode design agent   │◄───────────────────────────────────┐
└────────────┬─────────────┘                                    │
             │ tools                                           │
┌────────────▼──────────────────────────┐                       │
│  bridge (Node.js, TypeScript)         │                       │
│  ├ tools.ts        67 MCP tools       │                       │
│  ├ operations.ts   whitelist + schema │                       │
│  ├ assets/         registry · search  │                       │
│  │                 cache · svg · ctx  │                       │
│  └ xd-link.ts      WebSocket client   │                       │
└────────────┬──────────────────────────┘                       │
             │ ws://127.0.0.1:27183 (token auth)                │
┌────────────▼──────────────────────────┐                       │
│  XD plugin (UXP panel, plain JS)      │                       │
│  ├ ops.js       50 document operations│                       │
│  ├ executor.js  batch driver, 1 settle│                       │
│  └ main.js      queue, UI, reconnect  │                       │
└────────────┬──────────────────────────┘                       │
             │ application.editDocument (user gesture required) │
┌────────────▼──────────────────────────┐                       │
│  Adobe XD 61 · live scenegraph        │───────────────────────┘
└───────────────────────────────────────┘   batchExecuted events
```

**Design principle:** the plugin owns all document knowledge; the bridge owns
validation, orchestration and assets; the agent owns design judgement.

---

## Features

### Real XD document operations (50)

| Area | Operations |
|---|---|
| Read | document info, artboards, selection, node inspect, search, prototype state |
| Create | artboard, rectangle, ellipse, line, polygon/star, path, text, image, group, mask group |
| Modify | name, style (fill/gradient/stroke/radius/shadow/blur/opacity), move, resize, rotate, reparent, z-order, align, distribute, layout stacks, responsive constraints, blend mode |
| Vector | path rewrite, convert to path, outline stroke, pixel-grid alignment, 3D reset |
| Structure | duplicate, delete, ungroup, make/replace stack background |
| Output | artboard/selection PNG export, document validation, design-consistency audit |
| Assets | image fill, image replace, native file import |

### Design asset intelligence (11 tools)

- **Search** across a curated registry plus live Iconify sets — Lucide, Phosphor,
  Tabler, Heroicons, Material Symbols, Simple Icons — with **explained ranking**
  (`reasons` on every hit).
- **Typography** metadata from Google Fonts: weights, styles, subsets, Arabic
  support, recommended and inappropriate uses.
- **Design context** persisted to disk so later choices stay consistent (one
  icon family, one type scale, one radius system).
- **Licence safety**: commercial use, attribution, redistribution and an
  `uncertain` flag that excludes assets from production searches.
- **Insertion as real vectors**: SVG geometry is converted to editable XD `Path`
  nodes at artboard coordinates — never a screenshot, never a flattened bitmap.
- **Caching** in `asset-cache/` with a sha256 manifest, dedupe and invalidation.

> Sources that cannot be legally automated (Figma Community, unDraw, DrawKit,
> 3Dicons, Lottie/Rive, browser mockup tools) are catalogued as **reference
> only** with their real terms — and never scraped.

---

## Requirements

| Component | Version |
|---|---|
| Adobe XD | 61.x |
| Node.js | ≥ 22.6 (native TypeScript execution) |
| UXP Developer Tool | current |
| OpenCode | current, with MCP support |
| OS | Windows (paths are Windows-first) |

No runtime dependencies beyond `ws`.

---

## Quick start

### 1. Generate a bridge token

```powershell
cd bridge
node bin\bridge.ts --show-token
```

The token is stored in `bridge/.bridge-token` (git-ignored) and never sent over
the network — only to `127.0.0.1`.

### 2. Register the MCP server

Point OpenCode at the bridge (stdio):

```jsonc
{
  "mcp": {
    "adobe-xd": {
      "type": "local",
      "command": ["node", "C:\\path\\to\\AdobeXD-DesignBridge\\bridge\\bin\\bridge.ts"],
      "enabled": true
    }
  }
}
```

### 3. Load the plugin

In UXP Developer Tool: **Add Plugin** → `xd-plugin/manifest.json` → **Load**.
Open the panel, paste the token, press **Connect**.

### 4. Design

Ask the agent to build a screen. Mutating work is queued; the panel applies it on
the next interaction inside the panel (`Auto-apply` is on by default), or via
**Apply N change(s)**.

---

## MCP tool surface

**67 tools**, all validated before they reach XD.

| Prefix | Count | Purpose |
|---|---|---|
| `xd_*` | 56 | document reads/writes, export, audits, batch execution |
| `design_asset_*` | 9 | search, inspect, get, license, recommend, insert, apply font, list sources/categories |
| `design_context_*` | 2 | persisted design-system state |

Highlights: `xd_execute_batch` (whole screen in one undo step),
`xd_audit_screen` (semantic role coverage), `xd_validate_document`,
`design_asset_insert` (SVG → editable Path nodes).

---

## The XD plugin

Version **1.0.6**. Plain JavaScript, no build step, no external libraries.

- **Execution gate** — `application.editDocument` only runs from a panel UI
  event; the panel drains the queue in one transaction (single undo entry).
- **Completion contract** — `executor.js` settles on the *edit callback's*
  promise, not on `editDocument`'s return value (which is `undefined` in XD 61),
  and guarantees exactly one settle. This removed a class of false "batch
  executed, zero results" reports.
- **Fail-fast batches** — a failing operation aborts the remainder and the
  results list says exactly what applied.
- **Panel UI** — compact status pill, auto-apply switch, collapsed connection
  settings, activity log.

---

## Testing

```powershell
cd bridge
node --test ..\tests\*.test.ts
```

**156/156 passing**, covering:

- MCP protocol, tool registry, argument validation
- Plugin handlers against a fake XD runtime (incl. `SceneNodeList` semantics)
- Batch executor: async completion, duplicate callbacks, picker cancellation
- Agent contract / workflow conformance
- Asset layer: registry, licence gates, search ranking, cache dedupe/tamper,
  path traversal, SVG parsing, path transforms, XD insertion operations

Tests are deterministic and offline; network calls are injected fakes.

---

## Security model

- **Local only** — WebSocket bound to `127.0.0.1`, token-authenticated.
- **Whitelist** — operations are validated against a schema registry; arbitrary
  code, arbitrary paths and arbitrary URLs are not expressible.
- **No background edits** — XD requires a user gesture for every write.
- **No scraping** — assets come from documented APIs or are reference-only.
- **Secrets excluded** — `.bridge-token`, logs, exports and caches are
  git-ignored.

See `SECURITY.md`.

---

## Project layout

```
bridge/            MCP server + asset layer (TypeScript)
  src/assets/      registry · sources · search · cache · svg · pathdata · context
  src/tools.ts     67 MCP tools
  src/operations.ts validated operation registry
xd-plugin/         UXP panel (manifest, ops.js, executor.js, main.js, index.html)
tests/             node:test suites
docs/              operation schema, capability matrix, asset intelligence
examples/          sample design payloads
```

---

## Documentation

| Document | Contents |
|---|---|
| `docs/asset-intelligence.md` | asset sources, licensing, search, caching, XD insertion |
| `docs/mcp-operation-schema.md` | every tool and its parameters |
| `docs/xd-capability-matrix.md` | what XD's API can and cannot do |
| `ARCHITECTURE.md` | internals and design decisions |
| `TESTING.md` / `TROUBLESHOOTING.md` | verification and failure modes |

---

## Status & scope

This is a private engineering project, not a product. Adobe XD's public plugin
API has hard limits — no component masters, no prototype wiring authoring, no
gradient-on-text, no viewport control — and the bridge reports those honestly
instead of simulating them.

## License

MIT © 2026 greatomar — see [LICENSE](LICENSE).

Third-party assets are **not** bundled in this repository. Icon sets,
fonts and design resources referenced by the asset layer keep their own
licenses (ISC, MIT, Apache-2.0, CC0, OFL), which are recorded per asset and
surfaced by `design_asset_license`.
