# Design Asset Intelligence

The asset layer gives the design agent a real resource library: it can search for
icons, logos, fonts and component patterns, check licensing, cache what it uses,
and insert vectors into Adobe XD as **editable Path nodes**.

It is an addition to the existing bridge, not a parallel system:

```
OpenCode (MCP stdio)
   │
   ├── xd_* tools ───────────────► operations.ts (whitelist) ─► xd-link ─► XD panel queue
   │                                                                         └─ ops.js (editDocument)
   └── design_asset_* tools ──► assets/service.ts
                                   ├─ registry.ts      curated fonts + component patterns
                                   ├─ sources.ts       every source + integration kind + license
                                   ├─ search.ts        deterministic, explainable ranking
                                   ├─ cache.ts         project-local cache + manifest
                                   ├─ svg.ts           dependency-free SVG → shape reader
                                   ├─ pathdata.ts      SVG path transform / tint
                                   └─ context.ts       persisted design context
                                        │
                                        └── produces create_path operations ─► same queue as xd_*
```

Asset insertion never invents a second XD path: `design_asset_insert` converts
SVG geometry into the existing `create_path` operations and queues them through
the normal panel gate, so undo grouping, validation and safety are unchanged.

## Supported sources and how each one integrates

`kind` is the integration contract, not a wish list.

| Kind | Meaning |
|---|---|
| `api` | documented public HTTP API, no key — fetched automatically |
| `api-key` | documented API that needs a user key — never fetched without one |
| `package` / `download` | official package or static hosting |
| `reference` | design knowledge only; **never** downloaded automatically |
| `manual` | user imports by hand (Figma Community, commercial tools) |

| Category | Source | Kind | License | Notes |
|---|---|---|---|---|
| icon | Lucide | api (Iconify) | ISC | default family for modern product UI |
| icon | Phosphor | api | MIT | six weights |
| icon | Tabler Icons | api | MIT | dense dashboards |
| icon | Heroicons | api | MIT | outline + solid pairs |
| icon | Material Symbols | api | Apache-2.0 | Android / Material |
| icon / logo | Simple Icons | api | CC0 1.0 | trademarks belong to their owners |
| icon / logo | Iconify | api | per-collection | aggregator + search API |
| logo | SVGL | reference | MIT (site) | no public asset API |
| logo | Devicon | download | MIT | via jsDelivr |
| font | Google Fonts | api | OFL 1.1 / Apache-2.0 | metadata: family, weights, subsets, Arabic |
| component | shadcn/ui, Radix, Material 3, MUI, Ant Design | reference | MIT / Apache-2.0 | patterns and states, not code to copy |
| component | Untitled UI | manual | free tier | Figma only |
| illustration | unDraw, DrawKit, Storyset, ManyPixels | reference | vary | no licensed public API |
| illustration / avatar | Humaaans, Open Peeps | reference | CC0 | Figma/Sketch files |
| 3d | 3Dicons | reference | uncertain | not auto-downloaded |
| avatar | DiceBear | api | per-style | deterministic SVG from a seed |
| avatar | UI Faces | reference | uncertain | likeness rights |
| motion | LottieFiles, Rive | reference | vary | XD cannot play them |
| photo | Unsplash, Pexels | api-key | Unsplash / Pexels license | user key required |
| background | Haikei, SVG Backgrounds, BGJar | reference | vary | generate locally instead |
| mockup | Shots, Mockuuups | reference / manual | vary | browser or commercial tools |
| component / illustration / 3d / mockup | Figma Community | manual | per-resource | no public API; never scraped |

## Asset schema

```jsonc
{
  "id": "iconify:lucide:settings",     // stable across sessions
  "name": "Settings",
  "category": "icon",
  "source": "Lucide",
  "sourceId": "lucide",                // filter key
  "type": "svg-icon",
  "format": ["svg"],
  "style": ["outline", "modern", "product-ui"],
  "tags": ["lucide", "outline", "settings"],
  "keywords": ["settings", "gear"],
  "description": "…",
  "variants": [{ "name": "default", "format": "svg" }],
  "license": {
    "name": "ISC", "spdx": "ISC",
    "commercial_use": "yes",
    "attribution_required": false,
    "redistribution_allowed": "yes",
    "url": "https://github.com/lucide-icons/lucide/blob/main/LICENSE",
    "uncertain": false
  },
  "sourceUrl": "https://icon-sets.iconify.design/lucide/",
  "cachedPath": "…\\asset-cache\\lucide\\lucide-settings.svg",
  "recommended_for": ["ui", "icons", "interface"],
  "avoid_for": [],
  "meta": { "prefix": "lucide", "icon": "settings" }
}
```

## Search strategy

Ranking is deterministic and **always explained** — every result carries
`reasons`, so the agent can justify a choice instead of guessing.

1. Hard filters: category, source, format, style, license mode.
2. Lexical score: exact name (60) › name tokens (25 each) › keywords/tags (12
   each) › description (4 each).
3. Design-context score: overlap with `recommended_for` (+8/token, max 30),
   conflict with `avoid_for` (−20), icon-style match (+8), Arabic match (+20),
   already-chosen font (+25).
4. Licence safety: `uncertain` −25, attribution −2.
5. Icons: Iconify performs the semantic match; its ordering is preserved with a
   provider-rank bonus and a small family preference (lucide › ph › tabler ›
   heroicons › material-symbols) so a screen does not silently mix families.
6. Iconify matches single tokens only, so a multi-word query that returns
   nothing is retried per token and merged.

`license: "commercial"` excludes anything with uncertain terms or
`commercial_use !== "yes"`.

## Cache strategy

- Location: `<bridge>/asset-cache` — override with `XD_ASSET_CACHE_DIR`.
- Layout: `<cache>/<source>/<asset>.<ext>` plus `<cache>/manifest.json`.
- Every entry stores url, sha256, byte size, fetch time and license.
- Identical content is deduplicated by hash; a hash mismatch invalidates the
  entry (`prune()` also drops entries whose file disappeared).
- Path segments are sanitised, so `../../etc/passwd` cannot escape the cache.
- The cache never writes to global system directories.
- Iconify search responses are cached too, so repeated queries stay offline.

## Licensing

Licence data is part of each record. `design_asset_license` answers:
commercial use, attribution, redistribution, and whether the terms are
**confirmed**. Anything with `uncertain: true` is excluded from
`license: "commercial"` searches and is flagged in the response.

Rules the agent must follow:

- Never use an `uncertain` asset in a production design without saying so.
- Photo sources require a user API key; do not assume one exists.
- Brand logos may only be used to reference the brand.
- Reference-only categories are knowledge, not downloadable assets.

## MCP tools

| Tool | Purpose |
|---|---|
| `design_asset_list_sources` | sources + integration kind + license |
| `design_asset_list_categories` | categories + coverage + integration note |
| `design_asset_search` | semantic search with scores and reasons |
| `design_asset_inspect` | full metadata, variants, licensing |
| `design_asset_get` | resolve + cache; returns vector metadata |
| `design_asset_license` | license and production-safety check |
| `design_asset_recommend` | icon + font + pattern picks with consistency notes |
| `design_asset_insert` | insert SVGs into XD as editable Paths |
| `design_asset_apply_font` | set a text node's family/weight/size |
| `design_context_get` / `design_context_set` | persisted design system state |

## XD integration

`design_asset_insert`:

1. resolves and caches the SVG;
2. parses `path`/`circle`/`rect`/`line`/`polyline`/`polygon` with inherited
   fill/stroke;
3. scales geometry into the requested box and bakes **artboard coordinates**
   into the path data;
4. emits one `create_path` per shape with `position: "absolute"`, stroke-only
   shapes getting a transparent fill;
5. queues them through `execute_batch` → panel → `editDocument`.

Result: real, editable vector nodes. Nothing is rasterised, and no screenshot is
ever used as a UI substitute.

`design_asset_apply_font` sets real XD text styling, but XD can only use fonts
installed on the machine — the response says whether the family is curated.

## Using the asset system while designing

1. `design_context_set` once per product (product, direction, palette,
   typography, icon style, radius, platform, language, RTL).
2. `design_asset_recommend` to pick a family/pattern before drawing.
3. `design_asset_search` for a specific need; read the `reasons`.
4. `design_asset_get` to cache, `design_asset_insert` to place.
5. Keep **one icon family, one illustration style, one font** per screen.
6. Never invent a logo or an icon when a real one exists.

## Adding a source

1. Add an entry to `bridge/src/assets/sources.ts` with the real license and an
   honest `kind`.
2. If it is Iconify-hosted, set `iconifyPrefix` and add the prefix to
   `AssetService.ICON_PREFIXES`.
3. If it needs custom fetch/parse, extend `service.ts`; never add HTML scraping.
4. Add a test proving the license gate and the failure path.

## Adding a category

1. Extend `AssetCategory` in `types.ts` and `ASSET_CATEGORIES`.
2. Add at least one source with a truthful `kind`.
3. If it is reference-only, add guidance in `REFERENCE_ONLY_GUIDANCE`.
4. Add the category to `design_asset_recommend` only if the bridge can actually
   resolve it.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `degraded: "Iconify unavailable"` | no network / API down | local registry still works; retry later |
| `code: "metadata_only"` | font/component/illustration requested via `get` | use search/inspect instead |
| icon inserted at 0,0 | plugin older than 1.0.6 — `position` ignored | reload the plugin |
| `unknown asset id` | id not in registry and not an Iconify id | check `design_asset_search` |
| license `commercial_use: "varies"` | aggregator or per-asset terms | inspect the source entry |

## Security

- Network access is limited to an explicit host allowlist used by the service
  (Iconify, Google Fonts); no arbitrary URL is fetched on request.
- No HTML scraping, no cookie/session use, no credential storage.
- Cache paths are sanitised; the cache stays inside the configured directory.
- Asset insertion goes through the existing validated operation registry, so
  the whitelist, edit-context rules and panel gate are unchanged.
- The layer never executes code from an asset; SVG is parsed as data only.
