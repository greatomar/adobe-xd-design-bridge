---
name: prototyping-and-interaction
description: "Interaction design for XD: navigation flows, interactive states, screen transitions, prototype connection specifications, and completeness validation of user journeys. Load when specifying how screens connect and behave, and when documenting prototype flows that XD's public plugin API cannot author directly."
---

# Prototyping and Interaction

Specifies how screens connect and respond. Produces interaction specifications that drive both
the visual states built in XD and (when the runtime supports it) prototype wiring.

## Public API boundary (verified against XD 61.0 API docs)

Adobe XD's **public plugin API does not expose prototype interaction authoring** (no documented
API to create prototype wires, triggers, or transitions from a plugin). The bridge therefore
treats prototype connections as **read-only data plus a manual-authoring specification**, not
executable wire-edit operations:

- `xd_get_prototype_state` reads `interactions.flows`, `interactions.allInteractions`, triggers,
  actions, destinations and transitions from XD. It cannot create, update or delete them.
- `xd_validate_prototype` compares a required `{fromGuid,toGuid,trigger?,action?}` edge manifest
  with the actual existing wire graph and reports missing endpoints/connections. It is read-only.
- The official `interactions` module is documented as **read-only**. The `commands` reference
  contains no wire-authoring command. No supported alternative API was found in the installed
  host documentation. Do not mutate undocumented model fields or use UI automation as if it were
  a supported plugin API.
- Produce the machine-readable flow spec below and a precise manual-wiring checklist for XD's
  Prototype workspace. State clearly which connections remain manual.
- After the user wires them manually, re-read `xd_get_prototype_state` and run
  `xd_validate_prototype`; do not claim prototype completion from the plan alone.

Interactive *visual states* (pressed, error, empty) can be represented as native alternate nodes
or artboards; they are not native linked component states. Programmatic component variant creation
is unsupported, so do not claim linked state behavior.

## Flow specification format

```yaml
flow: checkout
entry: screen/cart
steps:
  - from: screen/cart
    trigger: tap [Button/Checkout]
    transition: slide-left
    to: screen/shipping
  - from: screen/shipping
    trigger: tap [Button/Continue]
    transition: slide-left
    to: screen/payment
    guard: form-valid else → state/shipping-error
exit: screen/confirmation
states-covered: [cart-empty, shipping-error, payment-declined, loading]
```

Rules:

- Every trigger references a **named component** that actually exists in the document.
- Every flow lists the states it can produce; each state maps to a real artboard or variant.
- Dead ends are findings: every screen must exit (forward action, back, or system transition).

## Transition selection

Match transition to spatial/semantic relationship, not novelty:

- Same-level lateral movement → slide left/right.
- Descending into detail → push/slide up or scale.
- Modal/confirmational → overlay or dissolve; keep one modal transition style per system.
- Destructive or final actions → none (instant) or cross-dissolve; never playful motion.

One consistent vocabulary of 2–3 transitions per product. Prototype mode durations: 300ms
default, 150ms for micro-feedback.

## Journey validation

Before delivery, walk each flow in the spec against the screen inventory:

1. All `from`/`to` screens exist as artboards.
2. All trigger components exist with correct names.
3. All listed states exist (artboard or component variant).
4. Error paths from `guard` clauses have screens.
5. Back/escape routes exist for every non-terminal screen.

Report completeness as a checklist in the delivery report, flagging anything requiring manual
prototype wiring in XD.

## Quality criteria

- No flow with a dead end or an unguarded failure path.
- 100% of spec'd states exist as real XD artifacts.
- Transition vocabulary is consistent and justified.
- Manual-wiring items are explicitly listed, never implied done.
