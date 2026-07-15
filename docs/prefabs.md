# Prefabs

Reusable entity templates: author an entity (and its full descendant
subtree) once, save it as a **prefab asset**, then place as many instances
of it as you like — in the editor, from the CLI, over MCP, or spawned live
at runtime. Prefab instances are **live-linked**: editing a component
property on an instance directly records it as a per-instance **override**
instead of just silently drifting, and pushing a change back onto the
prefab (`updatePrefab`) automatically re-syncs every other instance in the
same command — merging the new payload with each instance's own recorded
overrides rather than blowing them away. A structural edit (adding or
removing an entity/component inside an instance) can't be merged, so it
**detaches** that instance from the link instead of guessing.

## Data model

A prefab is an asset (`type: 'prefab'`) whose payload lives at
`assets/prefabs/<slug>.prefab.json`, validated by `PrefabDataSchema`:

```jsonc
{
  "name": "Ember Grub",
  "entities": [
    { "id": "pfe_1", "name": "Ember Grub", "parentId": null, "enabled": true,
      "tags": ["grub"], "components": { "Transform": { /* … */ }, "Script": { /* … */ } } },
    { "id": "pfe_2", "name": "Grub Core", "parentId": "pfe_1", "enabled": true,
      "tags": [], "components": { "Transform": { /* … */ }, "SpriteRenderer": { /* … */ } } }
  ]
}
```

- **Normalized local ids**: every entity in the payload uses `pfe_1`,
  `pfe_2`, … instead of real `ent_*` scene ids, assigned in **root-first
  BFS order**. `parentId` is in that same local-id space; the root's
  `parentId` is always `null`. This is what makes a prefab payload
  reusable across scenes and instances — nothing in it names a live entity.
- **The marker field**: an entity that is a live instance of a prefab
  carries an optional `prefab` field alongside its normal `components`.
  It's an entity-level field, not a component — it won't show up in
  `hearth inspect components`, but it round-trips through scene files,
  snapshots, undo history, and everything else that already handles
  entities. **Only the root of an instantiated subtree carries the
  marker**; its descendants are plain entities, resolved back to their
  root by reverse-scanning `ids` (see below). The marker's shape:

  ```ts
  prefab: {
    asset: string;                 // the prefab asset id
    ids: Record<string, string>;   // prefab local id (pfe_1, …) -> this instance's scene entity id
    overrides: {                   // implicit per-instance edits, re-applied on every merge sync
      entity: string;    // scene entity id (root or a descendant)
      component: string; // component type name
      path: string;      // dot-path within that component
      value: unknown;
    }[];
  }
  ```

  `ids` is what lets a merge sync (below) reuse an instance's existing
  scene ids for locals that still exist in the prefab, mint fresh ids only
  for genuinely new locals, and drop entities for locals that were
  removed — instead of a full delete-and-recreate. A marker with an empty
  `ids` map (e.g. one written by an older `createPrefab` call before this
  field existed) is "legacy-detached": it behaves as an unlinked instance
  until the next `syncPrefabInstances` normalizes it.
- **Nested prefabs flatten at create time.** If the subtree you serialize
  with `createPrefab` contains an instance of some *other* prefab, that
  descendant's own `prefab` marker is stripped when it's baked into the new
  payload — the new prefab owns a flattened copy of those entities, not a
  reference to the nested one. Editing the original nested prefab later has
  no effect on prefabs that were created from a subtree containing it.

## The five commands

Every prefab operation is a core command with CLI and MCP parity, like
everything else in Hearth:

| Core command | CLI | MCP tool | Permission |
| --- | --- | --- | --- |
| `createPrefab` | `hearth prefab create <scene> <entity> <name>` | `create_prefab` | asset-edit |
| `instantiatePrefab` | `hearth prefab place <prefab> <scene> [--position x,y] [--name n]` | `instantiate_prefab` | asset-edit |
| `updatePrefab` | `hearth prefab update <prefab> <scene> <entity>` | `update_prefab` | asset-edit |
| `syncPrefabInstances` | `hearth prefab sync <prefab> [--scene s]` | `sync_prefab_instances` | asset-edit |
| `revertPrefabOverride` | `hearth prefab revert <scene> <entity> [component] [path]` | `revert_prefab_override` | safe-edit |

### `createPrefab { scene, entity, name }`

Serializes `entity`'s full descendant subtree (BFS, root first) into a new
prefab asset at `assets/prefabs/<slug(name)>.prefab.json`, registers it
under `name` (asset names must be unique), and stamps the **source** entity
with a full `prefab` marker (empty `ids`/`overrides`) — it becomes the
prefab's first tracked instance. Fails if `name` is already taken or the
target file already exists.

```bash
hearth prefab create Warren "Ember Grub" "Ember Grub"
```

### `instantiatePrefab { prefab, scene, position?, name? }`

Reads and schema-validates the payload, mints a fresh `ent_*` id for every
entity (remapping `parentId` to match), and pushes the whole subtree into
`scene`. `position` overrides the root's `Transform.position` (default: the
position stored in the payload); `name` overrides the root's name (default:
the prefab's own `name`). The new root gets a `prefab` marker whose `ids`
maps every prefab local to the scene id it was just spawned with —
this is what a later merge sync reuses.

The root name is **uniquified against the target scene**: placing a prefab
twice gives you `Ember Grub` then `Ember Grub 2` (an explicit `name` that
collides is suffixed the same way), so every instance stays addressable by a
distinct name for `updatePrefab`/`inspectEntity`.

```bash
hearth prefab place "Ember Grub" Warren --position 400,300
```

### `updatePrefab { prefab, scene, entity }`

Re-serializes `entity`'s current subtree back over the prefab asset's
payload file (same path, same asset id), **then auto-syncs every marked
instance of that prefab across every scene in the same command** — one
undo entry rolls back both the payload write and every re-synced instance.
`entity` must already carry a `prefab` marker matching `prefab`; pushing
edits from an entity that isn't a tracked instance of that exact asset is a
`PREFAB_NOT_INSTANCE` error. This is how you retune a prefab: instantiate
one, tweak it like any other entity, then `updatePrefab` to bake the change
back into the asset and propagate it everywhere else it's placed.

`entity` can be an id or a name. Because instance names are uniquified on
placement, a name like `Ember Grub 2` addresses exactly one instance — but
prefer the entity id when a scene holds several instances and you want to be
unambiguous no matter how they were named.

```bash
hearth prefab update "Ember Grub" Warren "Ember Grub"
```

### `syncPrefabInstances { prefab, scene? }`

Rebuilds **every** marked instance of `prefab` (across all scenes, or just
`scene` if given) from the asset's *current* payload — the same merge sync
`updatePrefab` runs automatically, available on its own for when you've
edited the payload file some other way (or just want to force a resync). See
[Live-link semantics](#live-link-semantics-marker-merge-detach) for exactly
what a merge sync does with per-instance overrides.

```bash
hearth prefab sync "Ember Grub"
```

### `revertPrefabOverride { scene, entity, component?, path? }`

Reverts per-instance overrides on an instance member back to the prefab's
own values, write-through, and removes the matching override records.
`entity` can be any member of the instance — root or descendant, resolved
back to its instance via `ids`. Scope narrows with the optional args:
`component` + `path` reverts one field; `component` alone reverts every
override on that component; neither reverts every override on that entity.
A no-op success when nothing matches.

```bash
hearth prefab revert Arena "Elite Enemy" SpriteRenderer color
```

## Live-link semantics: marker, merge, detach

### Implicit overrides

Editing a component property on any member of a live instance —
`setComponentProperty`/`hearth set`/`set_component_property`, the batch
`setProperties`/`set-many`/`set_properties`, or a `moveEntity` position
write — records that write as an **implicit override** on the instance
root's marker automatically; there is no separate "record an override" step
or command. `name` and `enabled` are **not** component properties, so they
are never recorded as overrides for **any** entity, root or descendant —
there's no code path that writes one. The one true exception is the
instance root's own `Transform.position`: that's per-instance
**placement**, not an override, so moving the root itself is never
recorded — a descendant's `Transform.position` *is* recorded like any other
property write. In short: the root's own **name**, **enabled** flag, and
**`Transform.position`** are all per-instance placement and never record an
override; every other write, on the root or any descendant, does.

This has a sharp consequence: a merge sync (below) rebuilds every
non-root entity in the subtree fresh from the prefab's payload, so a
descendant you renamed or enabled/disabled by hand — with no override
record backing it up — **silently reverts to the prefab's values on the
next `updatePrefab`/`syncPrefabInstances`**. If you need a per-instance name
or enabled state on a descendant to survive a sync, there's no supported
way to do it today; only component-property values do. Writing the same
`(entity, component, path)` again replaces the recorded value in place
rather than appending a second record.

### Merge sync (`updatePrefab` / `syncPrefabInstances`)

A sync rebuilds each marked instance's subtree from the prefab's current
payload, but it's a **merge**, not a blind overwrite:

**Preserved** on the instance root, exactly like before:
- its entity **id**, its **name**, `Transform.position`, and `enabled`.

**Reused where possible, rebuilt where not:**
- every prefab local that still exists keeps the **same scene id** it
  already had (via the marker's `ids` map) — entity references elsewhere
  in the project that point at it stay valid; a **new** local (added to
  the prefab since the last sync) gets a fresh id; a local **removed**
  from the prefab is simply not rebuilt, so its old entity disappears.

**Overrides are re-applied on top**, not discarded:
- every recorded override is checked against the freshly-rebuilt subtree:
  if its local/component/path still exists there, the override is
  re-applied (write-through, re-validated against the component's schema)
  and kept on the new marker; if the prefab changed shape enough that the
  override no longer applies (the local, component, or path is gone, or a
  once-numeric field is now a different type), it's dropped and reported
  as a `PREFAB_OVERRIDE_STALE` warning naming exactly what was dropped and
  why — overrides never silently vanish.

If two marked instances are nested (one inside the other's subtree), only
the outer one is rebuilt as a tracked instance; the inner one becomes a
plain (unmarked) child of the outer, since rebuilding the outer deletes and
recreates its whole subtree first.

### Detach rules

A merge sync can reconcile *property* changes, but it can't reconcile a
**structural** edit made directly to a live instance — adding or removing
an entity or a component inside the subtree changes the very shape a merge
needs to match up against. Rather than guess, that instance **detaches**:
its `prefab` marker is removed outright (the entity keeps every field it
currently has, it just stops being tracked), and a `PREFAB_INSTANCE_DETACHED`
warning names which instance and why. A detached entity is a normal entity
from then on — nothing prevents re-linking it by hand (delete and
`instantiatePrefab` fresh, or ignore it and keep editing freely).

Reparenting counts as structural too, whenever it changes the subtree's
**membership**: `moveEntity` detaches the affected instance if it moves a
member entity *out of* the subtree (to a parent outside it), moves a member
*within* the subtree (reparenting one existing member under another), or
moves a foreign entity *into* the subtree as a new child. Duplicating a
member that isn't the instance root also detaches (the duplicate changes
the subtree's shape); duplicating the instance **root** is the one
exception — that creates a second, independent, live-linked instance of the
same prefab instead of detaching anything. A plain reparent of the instance
**root itself** — moving the whole instance to a new parent elsewhere in
the hierarchy, without touching which entities belong to it — does **not**
detach; the subtree's membership hasn't changed, only where it sits.

Property edits — however many, on the root or any descendant — never
detach; only structural edits, including the membership-altering
reparents/duplicates above, do.

## Validation

`hearth validate` / `validateProject` checks prefab payloads and instance
markers with four dedicated codes:

| Code | Severity | Meaning |
| --- | --- | --- |
| `PREFAB_DATA_INVALID` | error | The payload file doesn't parse, doesn't match `PrefabDataSchema`, or fails local-id invariants (non-root-first order, dangling `parentId`, duplicate ids). |
| `PREFAB_ASSET_NOT_FOUND` | error | A component inside the payload (`SpriteRenderer`/`AudioSource`/`SpriteAnimator.assetId`, a `Tilemap.tileAssets` entry) references an asset id that doesn't exist, or references the wrong asset type (e.g. a `SpriteAnimator` pointing at something that isn't an `animation` asset). |
| `PREFAB_SCRIPT_NOT_FOUND` | error | A `Script.scriptPath` inside the payload references a script file that doesn't exist. |
| `PREFAB_INSTANCE_ORPHANED` | warning | An entity's `prefab.asset` marker points at an asset that's missing or isn't type `prefab` (e.g. the prefab was deleted). The instance itself is unaffected — it's a live-linked copy, not a reference, so it stays exactly as playable as it was — this is purely a "the marker is now dangling" notice. |

`removeAsset` on a prefab with live instances doesn't block the delete; it
returns a warning listing which instances will be left with an orphaned
marker (the next `validateProject` call flags them as
`PREFAB_INSTANCE_ORPHANED`).

Two more codes surface from the commands themselves rather than `validate`
(both documented above): `PREFAB_NOT_INSTANCE` (an `updatePrefab`/
`revertPrefabOverride` target isn't a tracked instance of the given prefab)
and the warnings `PREFAB_OVERRIDE_STALE` / `PREFAB_INSTANCE_DETACHED` a
merge sync or a structural edit can emit.

## Runtime: `ctx.scene.spawnPrefab`

```
spawnPrefab(name: string, opts?: { position?: Vec2; name?: string }): EntityHandle | null
```

Spawns a prefab asset (resolved by name or asset id) as a fresh entity
subtree at play time — every entity gets a new id, parent/child links are
preserved among the spawned set, `opts.position` overrides the root's
position and `opts.name` its name. Spawned children are registered for
scripts exactly like the root, and spawning is deterministic (ids come from
the engine's own id generator, never the seeded RNG stream, so it doesn't
perturb `ctx.random`).

```lua
local grub = ctx.scene.spawnPrefab("Ember Grub", { position = { x = 400, y = 300 } })
```

```js
const grub = ctx.scene.spawnPrefab('Ember Grub', { position: { x: 400, y: 300 } });
```

Two behaviors worth calling out explicitly:

- **Unknown name returns `null`**, with a `warn`-level log line — the same
  tolerance-for-unknown-input contract as `ctx.scene.spawn`. It never
  throws.
- **Destroying the returned root does NOT cascade to its children.**
  `ctx.scene.destroy` is per-entity; a spawned prefab subtree is a set of
  independent entities that happen to share `parentId` links, not a unit
  the runtime tracks together. If you want the whole subtree gone, destroy
  each child yourself.

No `prefab` marker is attached to runtime-spawned entities — the marker is
an authoring/live-link concept for scene files; a spawned-at-runtime
subtree has no asset to sync back to, and no live game state should depend
on script-spawned enemies staying in lockstep with an asset someone edits
mid-session.

## Editor flows

- **Save as prefab** (Hierarchy, per-entity row action): serializes the
  selected entity's subtree via `createPrefab`, prompting for a name inline.
- **Add to scene** (Assets panel, on a prefab asset's card): calls
  `instantiatePrefab` into the currently open scene, positioned at the
  viewport center.
- **Update prefab** (Inspector, shown as a banner — "Instance of `<name>`"
  — when the selected entity carries a `prefab` marker): calls
  `updatePrefab` for that one instance, which — per the merge semantics
  above — also re-syncs every other instance in the same action.
- **Sync all** (Inspector, same banner) / **Sync instances** (Assets
  panel, on the prefab asset's card): both call `syncPrefabInstances`,
  after a preflight that counts affected instances across every scene and
  shows a confirm dialog stating the scope.
- **Override dots + revert** (Inspector): a field that diverges from the
  prefab grows a small ember dot next to its label and a **Revert** button
  on hover — see [editor.md](./editor.md#prefab-authoring-surfaces) for the
  full per-field/instance revert UI. The banner shows a running override
  count and a **Revert all** action.

## See also

- [scripting.md](./scripting.md#entities-in-the-current-scene) — the full
  `ctx.scene` API, including `spawnPrefab` alongside `spawn`/`destroy`.
- [cli.md](./cli.md) — the `hearth prefab` command group.
- [components.md](./components.md#notes) — the entity-level `prefab`
  marker field (not a component).
- [architecture.md](./architecture.md#prefabs) — where prefab
  serialization/instantiation lives in the codebase.
- **`ember-horde`** (`packages/examples/ember-horde`) is the reference
  project for all of this: an `Enemy` prefab with several plain instances
  plus one **Elite Enemy** instance that overrides `SpriteRenderer.color`/
  `width`/`height` (a bigger, red variant) — edit the base prefab and
  re-run `hearth prefab update` to watch the plain instances pick up the
  change while the elite's overrides survive the sync.
