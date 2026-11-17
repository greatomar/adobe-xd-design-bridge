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

## `move_node` — artboard-relative coordinates

```json
{ "op": "move_node", "guid": "...", "x": 20, "y": 300 }
```

* `x`/`y` are **artboard-relative**, both required. `relative: true` makes them an additive offset.
* For a direct artboard child this is identical to "parent-relative". For a child of a **Group** it
  is *not*: XD 61 interprets `placeInParentCoordinates` in the enclosing artboard's space, so the
  group's own bounds are not the origin. Measured on the stage 9.1 fixture: a group child in an
  artboard at (0, 5000) moved to `(160, 20)` landed at absolute `(160, 5020)` — artboard-relative,
  not group-relative.
* Document coordinates are never accepted implicitly. Passing absolute document coordinates pushes
  an artboard child out of its artboard — this happened in stage 9 and cost five text nodes a
  recovery cycle.
* The result reports `coordinateSystem: "artboard-relative"`, `origin`, `before`, `after`, `delta`,
  `moved`, `parentGuid`/`parentName`, and `placement` (`artboardGuid`, `inside`).
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
3. `removeFromParent()`, `addChild()`, then restore the absolute position in the **artboard's**
   coordinate space, converging in at most two passes (adding a child can move a group's bounds).
4. Read back `node.parent`, **direct** membership of the new parent and direct membership of the old
   one. A recursive search of the old parent is wrong: when the new parent is nested inside it
   (artboard → group) the node is still findable and a correct reparent looks broken. That exact
   false negative was measured live in stage 9.1.
5. Return `verified: true` only when the new parent is the actual parent, the node is a direct child
   of it, and it is no longer a direct child of the old one. Otherwise
   `MUTATION_VERIFICATION_FAILED` with `expectedParentGuid`/`actualParentGuid`.
6. `geometryPreserved` reports whether the absolute frame survived (1 px tolerance) and
   `positionPasses` reports how many correction passes were used. Drift is reported, never hidden.

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
