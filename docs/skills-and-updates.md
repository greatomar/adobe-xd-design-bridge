# Skill Inventory and Update Procedures

All skills live in `~\.config\opencode\skills\`. IDs are path-derived; no duplicate IDs exist.

## External skills

### frontend-design (Anthropic)
- **Source:** https://github.com/anthropics/skills/tree/main/skills/frontend-design (archive of `main`, downloaded 2026-11-10)
- **License:** preserved in `skills\frontend-design\LICENSE.txt`; `SKILL.md.orig` is the
  unmodified upstream copy.
- **Local adaptation:** frontmatter description + "Environment adaptation: Adobe XD output"
  section (delivers an XD design specification through the bridge instead of HTML/CSS).
- **Update:** download the new archive, replace `SKILL.md.orig`/`LICENSE.txt`, re-apply the
  adaptation section (instructions in `skills\frontend-design\ATTRIBUTION.md`).

### ui-ux-pro-max (NextLevelBuilder) v2.15.0
- **Source:** https://github.com/nextlevelbuilder/ui-ux-pro-max-skill — installed with the
  **official installer** via pnpm: `pnpm dlx ui-ux-pro-max-cli@latest init --ai opencode`
  (no npm/npx/yarn used).
- **Contents:** SKILL.md + data (searchable styles, palettes, font pairings, UX guidelines,
  icons, charts, stacks) + Python search scripts (stdlib only).
- **Windows note:** run scripts with `python` (not `python3`). Python is **not installed** on
  this machine — the skill's Quick Reference data works regardless; its scripts activate once
  the user installs Python 3.
- **Update:** rerun `pnpm dlx ui-ux-pro-max-cli@latest init --ai opencode` in a scratch
  directory and replace the contents of `skills\ui-ux-pro-max\`. (The installer also offers six
  auxiliary skills — brand, design, design-system, slides, banner-design, ui-styling — kept out
  of the global skill set to avoid list noise; they remain available in the external folder.)

### impeccable (pbakaus) v4.8.2
- **Source:** https://github.com/pbakaus/impeccable — installed from the repo's
  `.agents/skills/impeccable` (OpenCode-compatible skill layout).
- **Contents:** SKILL.md with command playbooks (critique, audit, polish, typeset, layout, …),
  reference docs, and a checksum-verified engine launcher (`scripts/impeccable.cmd`).
- **Hooks reviewed:** the design-detector hook is **opt-in per project** (`$impeccable hooks on`)
  and is NOT enabled. The launcher downloads a version-pinned binary on first explicit use,
  verified via certutil against `engine-checksums.txt`, failing closed — acceptable for private
  use; it runs only when invoked.
- **Relevance to XD:** use its critique/polish/typeset/layout guidance as review lenses for
  exported screenshots; its browser-based `live`/`generate` modes do not apply to XD.
- **Update:** re-download the repo archive and replace `skills\impeccable\` from
  `.agents/skills/impeccable`; re-review the launcher and hooks before first use of new versions.

## Custom skills (this project, original content)

| Skill | Purpose |
|---|---|
| `adobe-xd-specialist` | XD document model, bridge tool workflow, execution-context rules, documented API mapping, known limitations |
| `ux-architecture` | Personas, task inventory, flows, IA, navigation model, state matrix; screen inventory artifact |
| `design-system-engineering` | Implementation-independent token JSON, component spec cards, scales, cross-artboard consistency |
| `visual-design-direction` | Four declarations, anti-generic discipline, grid/composition, alternatives exploration |
| `visual-qa-and-critique` | 12-dimension screenshot critique, 5-field findings, 3-cycle iteration cap, regression check |
| `prototyping-and-interaction` | Flow spec format, transition vocabulary, journey validation; XD prototype-API constraint |
| `accessibility-design` | WCAG 2.2 contrast math, touch targets, states; XD representability matrix |

Duplication boundaries: visual judgment → `visual-design-direction`/`frontend-design`;
patterns/palettes data → `ui-ux-pro-max`; review lenses → `impeccable`/`visual-qa-and-critique`;
XD mechanics → `adobe-xd-specialist`; structure/flows → `ux-architecture`; tokens →
`design-system-engineering`.
