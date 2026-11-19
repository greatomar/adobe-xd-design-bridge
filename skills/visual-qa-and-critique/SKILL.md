---
name: visual-qa-and-critique
description: "Screenshot-based visual quality assurance: hierarchy, alignment, spacing, typography, contrast, consistency, and visual regression review of exported XD artboards, with structured findings and iterative correction loops. Load after exporting any XD artboard for review, or before delivering design work."
---

# Visual QA and Critique

Closes the loop: read back the native scenegraph → evaluate the screen's semantic role manifest →
identify concrete defects → correct in XD. A rendered export is a valuable additional critique
surface when the model actually receives image input; do not make screenshots a substitute for
native-document verification or claim to have seen an inaccessible image.

## Workflow

1. **Read back.** Inspect `xd_inspect_node`, `xd_search_nodes`, and `xd_audit_screen` results for
   missing roles, wrong parents/types, empty text, zero-size nodes, visibility and style mismatches.
2. **Export when useful/available.** `xd_export_artboard` returns image content + dimensions.
   Inspect it only if it is actually visible to the calling model; if not, report that visual
   critique could not be performed. Check dimensions and non-empty image data.
3. **Critique against the twelve dimensions** (below), combining structural evidence with image
   evidence only when available. Batch findings from one review before correcting.
4. **Classify each finding** with the five required fields.
5. **Apply corrections** via bridge batch operations (prefer one `xd_execute_batch` per
   correction round, 5–15 ops).
6. **Execute the correction batch.** A queued correction is not applied: tell the user to click
   **Execute pending (N)**, wait for confirmation, then verify with `xd_get_operation_status`
   and read back the changed nodes.
7. **Re-export/read back** and verify the specific findings were fixed and nothing regressed.
8. **Stop conditions:** all critical/high findings resolved, or the iteration limit is reached.

## Completion gate

A screen may be called structurally finished only when:

- every screen-specific semantic role passes `xd_audit_screen` and relevant nodes are inspected;
- requested export dimensions/content are validated; image critique is separately reported as
  performed or unavailable (never inferred from node existence);
- no critical/high finding is open;
- every correction that was "applied" has a matching execution result and read-back.

Project delivery additionally requires all requested screens at this structural bar, the final
export set when requested/available, prototype-state inspection, and limitations stated (LEVEL 7).
State whether image critique actually occurred per screen; never upgrade a claim because the plan
looked right.

**Iteration limit: 3 critique-correction cycles per artboard by default.** If a finding survives
two cycles, stop and report it as a manual-action item rather than looping.

## The twelve evaluation dimensions

1. Visual hierarchy — is the most important element read first?
2. Typography — scale discipline, line lengths, legibility, voice consistency.
3. Color harmony — palette relationships, accent discipline, no off-token colors.
4. Spacing — consistent scale usage; grouping vs. separation intervals.
5. Alignment — edges snap to the grid; consistent left/right anchoring.
6. Layout balance — weight distribution, no accidental voids or crowding.
7. Component consistency — same component renders identically across artboards.
8. Contrast — text and icon contrast against actual backgrounds (see `accessibility-design`).
9. Accessibility — target sizes, state visibility (design-level).
10. UX clarity — labels, affordances, and flow legibility at a glance.
11. Visual originality — does it escape the generic-default tells of `visual-design-direction`?
12. Overall quality — would a design director ship this?

## Finding format (required)

Every finding states all five fields — no arbitrary scores without evidence:

```yaml
problem:      Card title and meta label use the same weight; title does not lead.
location:     Artboard "home", Card/Primary group, title + meta (guids recorded from inspection)
why-it-matters: Users scan by weight; equal weight flattens reading order.
correction:   Title → title/m token (Semibold 20), meta stays label/s Regular.
automatable:  yes  (xd_apply_style + xd_update_text, batchable)
```

`automatable: yes` only when the correction maps to concrete bridge operations on known `guid`s.
Uncertain findings are `automatable: no` with a manual instruction.

## Self-critique honesty

- Judge the rendered screenshot, not the plan. Screenshots reveal what coordinates hide
  (fallback fonts, overflow, muddy shadows).
- One finding per distinct problem; no padding the list to look thorough.
- If the design is good, say so and stop — diminishing-returns polishing is also a failure mode.

## Regression check

Before delivery, compare the final export against the first export per artboard and summarize
what changed. Unexpected changes (layout shifts, missing elements) are findings even if the
current state looks acceptable.

## Vision model usage

When the configured providers include a stronger vision-capable model than the working model,
route screenshot review through it (the `design` agent documents how); keep operation planning
on the working model to avoid unnecessary expensive calls.
