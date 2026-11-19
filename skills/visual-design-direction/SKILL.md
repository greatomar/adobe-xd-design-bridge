---
name: visual-design-direction
description: "Art direction and visual identity: composition, grid systems, visual hierarchy, typography and color relationships, density, whitespace, and distinctive non-generic visual styles. Load when defining how a design should look and feel before XD execution, and when a design feels generic or safe."
---

# Visual Design Direction

Chooses the *visual point of view*. Works with `frontend-design` (anti-generic direction) and
consumes `ux-architecture` screen inventories; hands a concrete direction to
`design-system-engineering` for tokens.

## Establishing direction

A direction is only real when you can state what makes it **not** the default answer. For every
brief, write four declarations before any pixels:

1. **Subject grounding:** what is the product's world (materials, industry, vernacular) and how
   does the design express it? A hydrology dashboard and a music app must not be
   distinguishable only by their logo.
2. **Typographic voice:** family choices and *why* (grotesque confidence, serif editorial
   authority, mono for instrument-panel data). One or two families, clearly differentiated roles.
3. **Color stance:** palette as a *relationship* (temperature contrast, one dominant surface
   family, one disciplined accent economy) — 4–6 named values. Restrained accent use beats
   rainbow accents; the accent must mean something (interactive or critical).
4. **Layout thesis:** the one compositional idea that organizes screens — asymmetric editorial
   grid, centered stage, dense instrument panel, generous single-column narrative. State it in
   one sentence; every artboard must obey or deliberately break it.

## Composition and grids

- Choose a column grid per device class (mobile 4–6 col, desktop 12 col) and stick to it;
  breaks must be intentional and rare.
- Visual hierarchy is built from **at least three competing dimensions** — size, weight,
  color/contrast, spacing — not size alone.
- Density follows the product mode: Operate surfaces (dashboards, tools) run denser with
  consistent rhythm; Persuade surfaces (landing, marketing) earn drama through scale contrast
  and whitespace.
- Whitespace is allocated, not leftover: group related content with sub-space, separate groups
  with clearly larger intervals.

## Anti-generic discipline

Known AI-default tells to refuse unless the brief demands them:

- Cream background + high-contrast serif + terracotta accent (the "#F4F1EA / #D97757" tell).
- Near-black canvas with one acid-green/vermilion accent.
- Broadsheet hairlines + zero radius + newspaper columns, applied regardless of subject.
- Identical rounded cards with identical soft shadows and one radius everywhere.
- ALL-CAPS tracked eyebrows, middle-dot meta strings, "WORD — fragment" labels, tinted
  near-black standing in for black, monospace micro-labels, arrow glyphs on every CTA.

If a choice would survive on any other brief, it is not a choice for *this* brief.

## Exploring alternatives

For substantial projects consider **2–3 distinct directions**, each with its four declarations
and a quick key-screen sketch. This is time-boxed: select one based on the brief, record the
reason/rejected directions briefly, then immediately continue to the screen construction
manifest and native XD build. Do not turn alternatives or wireframes into a stopping point or
ask the user to approve ordinary visual decisions.

## Handoff to XD

The chosen direction converts into: token JSON (via `design-system-engineering`), an artboard
plan per screen inventory entry (via `ux-architecture`), and explicit instructions for XD
execution (grid columns, alignment, hierarchy rules) consumed by `adobe-xd-specialist`.

## Quality criteria

- Four declarations written and specific to this brief.
- Zero unmodified default tells from the list above.
- One compositional thesis governing all planned artboards.
- Three alternatives considered for substantial projects; reasoning recorded.
