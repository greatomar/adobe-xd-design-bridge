---
name: ux-architecture
description: "User research, personas, journey mapping, information architecture, navigation structures, user flows, and interaction states for UX decisions. Load when defining what screens, flows, and states a product needs before any visual design or XD artboard creation."
---

# UX Architecture

Defines *what* the design must contain and *how users move through it*, before any visual
decisions. Produces structured outputs consumed by `visual-design-direction` (look) and
`adobe-xd-specialist` (XD execution).

## Responsibilities

- User research synthesis and personas (only when evidence exists; never invent research data
  without labeling assumptions).
- User journeys and task flows mapped to concrete screens.
- Information architecture: content inventory, hierarchy, navigation model.
- Interaction states: every interactive element needs empty, loading, error, and success states.
- Task-oriented decisions: prefer patterns that reduce user effort over novelty.

## Workflow

1. **Identify users and objectives.** Who uses this, on what device, in what context, to do
   what? Write one-line personas with the user's goal and the product's business goal — these
   two lines justify later design tradeoffs.
2. **Task inventory.** List every task the product must support, ranked by frequency and
   criticality. Each task maps to at least one flow.
3. **User flows.** For each task, diagram the happy path with decision points:
   `Entry → State → Decision → Branch → Outcome`. Note every branch that produces a screen or
   state variant.
4. **Information architecture.** Group tasks into areas; choose a navigation model
   (tab bar, drawer, sidebar, hub-and-spoke) justified by content breadth and task frequency —
   not by aesthetic preference.
5. **Screen inventory.** Every flow step becomes a named screen or state. Output format:

   | Screen ID | Purpose | Entry points | Key states |
   |-----------|---------|--------------|------------|
   | home | Task hub | launch, nav | loading, empty, error |

6. **State completeness check.** For every screen: first-run/empty, loading, error, offline (if
   relevant), success confirmation. Missing states are the most common UX debt.

## Decision criteria

- **Depth vs. breadth:** more than 5 top-level destinations → reconsider grouping or a
  hierarchical model; mobile tab bars degrade past 5 items.
- **Progressive disclosure:** surface the frequent 80%; bury the rest behind clear entry points.
- **Reversibility:** destructive actions require confirmation and undo where possible.
- **Orientation:** every non-obvious screen needs a way back and a sense of place (titles,
  breadcrumbs, or visual continuity).
- **Empty states instruct:** say what will appear here and how to get it, with a direct action.

## Output artifacts

- Persona lines (assumptions labeled).
- Screen inventory table (above format).
- Flow diagrams (text/ASCII).
- Navigation model justification.
- State matrix per screen.
- **Screen construction manifest** per actual artboard: purpose, primary task, region role
  prefixes (e.g. `Settings/Security`), expected native node types, real text/data required, and
  outbound interactions. This manifest is consumed by `xd_audit_screen` after implementation.

These artifacts go into the design brief consumed by the visual-direction skills and the
`design` agent. They are a build input, never a deliverable by themselves. Once the screen
inventory and region manifest are clear, the Design Agent must continue immediately into native
XD construction; every planned screen/state is populated with task-appropriate real content or
explicitly reported as blocked.

## Quality criteria

- No screen without a purpose traceable to a user task.
- No task without a flow; no flow with unmapped error branches.
- Navigation model justified against content breadth.
- State matrix complete for every interactive screen.

## References

- NN/g on information architecture and navigation patterns:
  https://www.nngroup.com/articles/ia-strategies/
- NN/g empty-state guidance: https://www.nngroup.com/articles/empty-state/
