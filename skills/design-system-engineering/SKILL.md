---
name: design-system-engineering
description: "Design tokens, color systems, type scales, spacing systems, radius/elevation, component specifications with variants and states, and cross-artboard consistency. Load when establishing or applying the design system that XD styles and components will implement."
---

# Design System Engineering

Turns design decisions into a systematic, enforceable structure, and expresses them as
implementation-independent tokens that the Adobe XD bridge validates, records on the document,
and applies per node.

> **Honest scope (verified):** `xd_apply_design_tokens` stores the token set in the document
> root's `pluginData` and returns a contrast report. XD's public API exposes **no** creation of
> native colour swatches, character styles or document assets. Never claim native XD styles
> exist. "Applied" always means "recorded + applied per node via `xd_apply_style`".

## Token format (bridge-validated)

Every entry must be an object with a **string `value`** (validation rejects anything else).
Colour entries additionally need a valid hex value; typography entries should carry a numeric
`fontSize` so `xd_inspect_design_consistency` can audit the scale. Name colours `text/*` and
`bg/*` — the bridge's contrast report pairs those two prefixes (any other naming yields an empty
report).

```json
{
  "color": {
    "bg/base":        { "value": "#0C0E12" },
    "bg/elevated":    { "value": "#14171D" },
    "text/primary":   { "value": "#F4F6F8" },
    "text/secondary": { "value": "#A9B2BF" },
    "text/tertiary":  { "value": "#8B95A5" },
    "accent/brand":   { "value": "#E3B04B" },
    "state/positive": { "value": "#3ED598" },
    "state/danger":   { "value": "#F0616D" }
  },
  "typography": {
    "display/xl": { "value": "40/48 Consolas", "fontFamily": "Consolas",  "fontSize": 40, "fontStyle": "Regular" },
    "title/m":    { "value": "18/24 Segoe UI Semibold", "fontFamily": "Segoe UI", "fontSize": 18, "fontStyle": "Semibold" },
    "body/m":     { "value": "13/20 Segoe UI", "fontFamily": "Segoe UI", "fontSize": 13, "fontStyle": "Regular" },
    "label/s":    { "value": "10/14 Segoe UI Semibold", "fontFamily": "Segoe UI", "fontSize": 10, "fontStyle": "Semibold" }
  },
  "space":  { "s": { "value": "8px" }, "m": { "value": "16px" }, "l": { "value": "24px" } },
  "radius": { "sm": { "value": "4px" }, "md": { "value": "8px" }, "lg": { "value": "12px" } },
  "elevation": { "e1": { "value": "surface step + 1px border" } }
}
```

Rules: names are `category/scale`; design artifacts reference token names, never raw hex; the token file
is the single source of truth. `fontStyle` follows the XD range key; the bridge v1.0.3 maps this
documented key and keeps `fontWeight` as a compatibility alias.


## Component specification

Each system component gets a spec card before XD construction:

```yaml
component: Button/Primary
anatomy: [label, optional leading icon]
variants:
  default:  { bg: "accent/primary", text: "accent/onPrimary", radius: "m", padding: [12, 20] }
  pressed:  { bg: "accent/primary", overlay: 12% black }
  disabled: { bg: "accent/primary", opacity: 0.4 }
  focus-visible: { outline: 2px "accent/primary", offset 2 }   # handoff note; XD cannot render focus
states-note: hover states are web-handoff only unless the product targets web
```

Use `Component/State` naming in the screen manifest and ordinary grouped-node layer names. These
are visual structures, not native linked XD components: XD's public API cannot create component
masters or variants. Existing SymbolInstances can be inspected/duplicated, but copied groups do
not synchronize like component instances.

## Scales that must feel designed

- **Type scale:** pick a ratio consistent with content density (1.2 compact UI, 1.25 editorial);
  limit to 5–7 sizes; line-height varies with size (tighter for display, looser for body).
- **Spacing:** one base unit (usually 4 or 8) with 5–6 steps only; margins of the same token at
  the same structural level (cards pad `m` inside, grids gap `m`).
- **Radius:** 2–3 values max, applied by hierarchy — largest for surfaces, smallest for chips.
- **Elevation:** shadow color derived from the actual background hue (never pure black),
  consistent angle/light direction across all levels.

## Cross-artboard consistency

Use `xd_inspect_design_consistency` after building screens. It flags: colors not present in the
token set, font sizes outside the type scale, spacing values outside the scale (where
inspectable), and duplicated component variants. Fix findings at the token or component level,
not by patching individual nodes.

## Quality criteria

- Zero raw hex values referenced outside the token file.
- Every component has all four interaction states specified (even if some are handoff-only).
- Type and spacing scales contain no ad-hoc values.
- `xd_validate_document` passes after token application.

## References

- Design tokens community format: https://design-tokens.github.io/community-group/format/
- Material type scale rationale: https://m3.material.io/styles/typography/type-scale-tokens
