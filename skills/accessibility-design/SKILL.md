---
name: accessibility-design
description: "WCAG 2.2-aware design decisions: color contrast, readability, touch target sizes, accessible interaction states, and the accessibility requirements Adobe XD cannot represent or validate. Load when choosing colors, sizing text/controls, or specifying states for any design."
---

# Accessibility Design

Applies WCAG 2.2 Level AA guidance at the design stage, and is explicit about what Adobe XD can
and cannot validate.

## What XD can enforce vs. what remains handoff-level

| Requirement | In XD (via bridge) | Handoff note required |
|---|---|---|
| Color contrast (computed) | `xd_apply_design_tokens` computes ratios for `text/*` × `bg/*` token pairs; `xd_inspect_design_consistency` does not itself compute contrast | Report ratios from the token response; manually inspect other foreground/background pairs |
| Touch target size | Yes — inspect node frames; flag < 44×44 px (or 24×24 for dense desktop per WCAG 2.2) | — |
| Text size / legibility | Partially — flag body text < 14px equivalent | Report |
| Focus indication | No — XD has no focus state rendering | Specify focus-visible variant |
| Screen-reader semantics / labels | No — XD has no accessibility tree | Produce label spec |
| Keyboard reachability / order | No | Produce order spec |
| Reduced motion | No | Note animation alternatives |

## Contrast mathematics (apply when choosing tokens)

- Body text: **4.5:1** against its background (3:1 for text ≥ 24px regular or ≥ 18.66px bold).
- UI components and graphical objects (icons, input borders, focus rings): **3:1**.
- Contrast ratio = (L1 + 0.05) / (L2 + 0.05), where L is relative luminance computed from
  sRGB values. `xd_apply_design_tokens` computes this for `text/*` on `bg/*` token pairs; a design token set
  whose primary text/accent pairs fail must be revised before use — do not ship a palette and
  "fix contrast later".
- Placeholder text is still text: 4.5:1 or specify it as illustrative-only in handoff.
- Disabled controls are exempt from contrast minimums but their *container* is not.

## Touch targets (WCAG 2.2, Success Criterion 2.5.8 "Target Size (Minimum)")

- Minimum 24×24 CSS px with adequate spacing (WCAG AA); **44×44 is the practical mobile floor**
  (HIG/Material guidance and better ergonomics).
- Inline exceptions exist (text links in sentences) but buttons, list rows, tabs, form controls,
  and icon buttons must meet minimums. The bridge flags offending frames during QA.

## Interaction states

Every interactive element specifies: default, hover (web), pressed/focus-visible, disabled.
Focus indication must be visible in the spec (outline token) even though XD cannot render it.
Never encode meaning by color alone — pair with icon, label, or shape (WCAG 1.4.1).

## Readability

- Body line length 45–75 characters (per editorial standards); avoid ALL-CAPS for running text.
- Line-height ≥ 1.4 for body text; paragraph spacing ≥ 0.75× line-height.
- Text over imagery requires a verified overlay treatment with computed contrast, not "looks fine".

## Working method

1. When defining tokens (`design-system-engineering`), compute and record contrast for every
   text/background pair; revise palette until all pass.
2. After building artboards, run `xd_inspect_design_consistency` and review flagged targets and
   contrast failures; correct via tokens, not node-by-node.
3. Produce an **accessibility handoff section** in the delivery report: computed ratios table,
   target-size audit results, focus/keyboard/semantics items XD could not represent.

## References

- WCAG 2.2 (W3C): https://www.w3.org/TR/WCAG22/
- Understanding SC 1.4.3 Contrast: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- Understanding SC 2.5.8 Target Size: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- NN/g accessibility articles: https://www.nngroup.com/articles/accessibility-ux/
