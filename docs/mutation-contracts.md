# Mutation contracts (XD 61, measured)

These contracts were extracted from live Adobe XD 61.0.12.1 behaviour after stage 9 produced
several cases where an operation reported `ok: true` without performing the mutation. Every rule
below is enforced in `bridge/src/operations.ts` (validation) and `xd-plugin/ops.js` (execution),
and covered by tests in `tests/capability-additions.test.ts` and `tests/plugin-ops.test.ts`.

## The three states of a mutation

| State | Evidence |
|---|---|
| **Queued** | `{ok:true, queued:true, pending:N}` from `xd_execute_*`; the document has not changed. |
| **Applied** | A `batchExecuted` event with per-op results, plus an empty queue. |
| **Verified** | A UXP read-back (`xd_inspect_node`, `xd_get_artboards`, `xd_get_prototype_state`) matches the request. |

`ok: true` alone proves none of these. A queued operation is not an applied one, and an applied
one is not a verified one.

## `update_node` — writes properties, never geometry

Accepted properties (`UPDATABLE_PROPERTIES`):

```
name, style, visible, locked, blendMode, markedForExport, fixedWhenScrolling
```

* `frame`, `x`, `y`, `width` and `height` are rejected with `UNSUPPORTED_PROPERTY: <key>` that names
  `move_node`/`resize_node` as the correct operation. Previously they were accepted, reported
  `ok: true`, and changed nothing.
* Any other key is rejected with `UNKNOWN_PROPERTY: <key>`.
* Validation is atomic: one unsupported key rejects the whole operation, so nothing is queued.
* `visible`/`locked` were also silently dropped by a validation-shape bug (the value was wrapped one
  level too deep, so the plugin only received `guid`). That is what made a batch of
  `update_node {visible:false}` report success while the nodes stayed visible.

## `move_node` — parent-relative coordinates

```json
{ "op": "move_node", "guid": "...", "x": 20, "y": 300 }
```

* `x`/`y` are **parent-relative**, both required. `relative: true` makes them an additive offset.
* Document coordinates are never accepted implicitly. Passing absolute coordinates to an artboard
  child pushes it out of the artboard and reparents it to the pasteboard — this happened in stage 9
  and cost five text nodes a recovery cycle.
* The result reports `coordinateSystem: "parent-relative"`, `before`, `after`, `delta`, `moved`,
  `parentGuid`/`parentName`, and `placement` (`artboardGuid`, `inside`).
* `safe: false` means the node now sits outside its own artboard. The mutation did happen, but it is
  never described as a safe one.

## `resize_node` — verified dimensions

* Absolute mode: `width`/`height` are positive dimensions (floor 0.1).
* `relative: true`: values are scale factors (floor 0.01, so a node cannot be collapsed to zero).
* The handler reads `globalDrawBounds` back and compares with a documented `tolerance` of `0.5` px.
* Shape/group/artboard mismatch → `{ok:false, code:"MUTATION_VERIFICATION_FAILED", expected, actual}`.
* `Text` nodes reflow: a height change is reported as `reflowed: true` instead of being treated as a
  failed mutation.

## `reparent_node` — verified relationship

1. Validate the node, the parent, the edit context, and reject containers, self/descendant targets
   and rotated/3D-transformed nodes.
2. Remember `oldParentGuid` and the node's absolute bounds.
3. `removeFromParent()`, `addChild()`, then restore the absolute position.
4. Read back `node.parent`, `findNode(parent, guid)` and the old parent's children.
5. Return `verified: true` only when the new parent is the actual parent, the node is inside it, and
   it is gone from the old one. Otherwise `MUTATION_VERIFICATION_FAILED` with
   `expectedParentGuid`/`actualParentGuid`.
6. `geometryPreserved` reports whether the absolute frame survived the move (1 px tolerance).

## `inspect_node` — paginated, never silently truncated

`inspectDetail` used to cap `children` at 30 while `childCount` stayed accurate, which made a correct
restore look incomplete and caused the "reparent is a no-op" misdiagnosis.

```json
{
  "guid": "...",
  "childCount": 38,
  "childrenTotal": 38,
  "childrenReturned": 30,
  "childrenOffset": 0,
  "childrenLimit": 30,
  "hasMore": true,
  "nextOffset": 30,
  "children": [ ... ]
}
```

* `childrenTotal` is authoritative and always equals `childCount`.
* Default `limit` is 100, so a "reasonably sized" node returns every child in one call.
* `limit` is validated to 1..500 and `offset` to >= 0 before anything reaches the panel.
* `hasMore`/`nextOffset` are the only valid completion signals. A short `children` array with
  `childCount` larger than `childrenReturned` never means "these are all the children".

## Apply Pending

Unchanged: `xd_pending_status` (read-only), `xd_apply_pending` (UIA click), `xd_verify_pending`
(event correlation + read-back). Rejected operations never reach the queue, so a failed validation
cannot leave a stray change waiting in the panel.
