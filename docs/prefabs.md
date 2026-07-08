# Prefabs

Reusable entity templates: author an entity (and its full descendant
subtree) once, save it as a **prefab asset**, then place as many instances
of it as you like — in the editor, from the CLI, over MCP, or spawned live
at runtime. Prefabs are **tracked stamps**, not live links: instantiating
one deep-copies its payload into fresh scene entities; a later `sync`
re-stamps every existing instance from the current payload on demand. There
is no per-field override machinery and no continuous binding between an
instance and its source asset — see [Non-goals](#non-goals) for what that
implies.

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
  carries an optional `prefab: { asset: <assetId> }` field alongside its
  normal `components`. It's an entity-level field, not a component — it
  won't show up in `hearth inspect components`, but it round-trips through
  scene files, snapshots, undo history, and everything else that already
  handles entities. **Only the root of an instantiated subtree carries the
  marker**; its descendants are plain entities with no marker of their own.
- **Nested prefabs flatten at create time.** If the subtree you serialize
  with `createPrefab` contains an instance of some *other* prefab, that
  descendant's own `prefab` marker is stripped when it's baked into the new
  payload — the new prefab owns a flattened copy of those entities, not a
  reference to the nested one. Editing the original nested prefab later has
  no effect on prefabs that were created from a subtree containing it.

## The four commands

Every prefab operation is a core command with CLI and MCP parity, like
everything else in Hearth:

| Core command | CLI | MCP tool | Permission |
| --- | --- | --- | --- |
| `createPrefab` | `hearth prefab create <scene> <entity> <name>` | `create_prefab` | asset-edit |
| `instantiatePrefab` | `hearth prefab place <prefab> <scene> [--position x,y] [--name n]` | `instantiate_prefab` | asset-edit |
| `updatePrefab` | `hearth prefab update <prefab> <scene> <entity>` | `update_prefab` | asset-edit |
| `syncPrefabInstances` | `hearth prefab sync <prefab> [--scene s]` | `sync_prefab_instances` | asset-edit |

### `createPrefab { scene, entity, name }`

Serializes `entity`'s full descendant subtree (BFS, root first) into a new
prefab asset at `assets/prefabs/<slug(name)>.prefab.json`, registers it
under `name` (asset names must be unique), and stamps the **source** entity
with `prefab: { asset }` — it becomes the prefab's first tracked instance.
Fails if `name` is already taken or the target file already exists.

```bash
hearth prefab create Warren "Ember Grub" "Ember Grub"
```

### `instantiatePrefab { prefab, scene, position?, name? }`

Reads and schema-validates the payload, mints a fresh `ent_*` id for every
entity (remapping `parentId` to match), and pushes the whole subtree into
`scene`. `position` overrides the root's `Transform.position` (default: the
position stored in the payload); `name` overrides the root's name (default:
the prefab's own `name`). The new root gets `prefab: { asset }`.

```bash
hearth prefab place "Ember Grub" Warren --position 400,300
```

### `updatePrefab { prefab, scene, entity }`

The reverse direction: re-serializes `entity`'s current subtree back over
the prefab asset's payload file (same path, same asset id, same
entity-count metadata refresh). `entity` must already carry
`prefab: { asset }` matching `prefab` — pushing edits from an entity that
isn't a tracked instance of that exact asset is a `PREFAB_NOT_INSTANCE`
error. This is how you retune a prefab: instantiate one, tweak it like any
other entity, then `updatePrefab` to bake the change back into the asset.

```bash
hearth prefab update "Ember Grub" Warren "Ember Grub"
```

### `syncPrefabInstances { prefab, scene? }`

Rebuilds **every** marked instance of `prefab` (across all scenes, or just
`scene` if given) from the asset's *current* payload — the propagation step
after `updatePrefab` changes the source of truth. Read the next section
carefully before calling this on anything you've hand-edited.

```bash
hearth prefab sync "Ember Grub"
```

## Tracked-stamp semantics (read this before you sync)

`syncPrefabInstances` is a full rebuild, not a merge. For each marked
instance root it finds:

**Preserved** on the instance root:
- its entity **id** (so anything already referencing that entity by id
  stays valid)
- its **name**
- `Transform.position`
- `enabled`

**Rebuilt from scratch** — everything else:
- every other component on the root (all properties reset to whatever the
  payload says, overwriting any tweak you made directly to that instance)
- **the entire descendant subtree is deleted and recreated from the
  payload, including any child you added by hand to that one instance**
  that isn't part of the prefab. If you parented an extra decoration under
  a prefab instance, a sync will delete it. There is no per-instance
  override or per-field diff — this is the tradeoff of tracked stamps over
  live links: simple, predictable, but all-or-nothing per instance.

If you want an instance-specific variation to survive syncs, don't make it
a hand-edit on a live instance — either accept the divergence will be lost
on the next sync, or promote the change into the prefab itself with
`updatePrefab` so every instance gets it.

## Validation

`hearth validate` / `validateProject` checks prefab payloads and instance
markers with four dedicated codes:

| Code | Severity | Meaning |
| --- | --- | --- |
| `PREFAB_DATA_INVALID` | error | The payload file doesn't parse, doesn't match `PrefabDataSchema`, or fails local-id invariants (non-root-first order, dangling `parentId`, duplicate ids). |
| `PREFAB_ASSET_NOT_FOUND` | error | A component inside the payload (`SpriteRenderer`/`AudioSource`/`SpriteAnimator.assetId`, a `Tilemap.tileAssets` entry) references an asset id that doesn't exist, or references the wrong asset type (e.g. a `SpriteAnimator` pointing at something that isn't an `animation` asset). |
| `PREFAB_SCRIPT_NOT_FOUND` | error | A `Script.scriptPath` inside the payload references a script file that doesn't exist. |
| `PREFAB_INSTANCE_ORPHANED` | warning | An entity's `prefab.asset` marker points at an asset that's missing or isn't type `prefab` (e.g. the prefab was deleted). The instance itself is unaffected — it's a full copy, not a reference, so it stays exactly as playable as it was — this is purely a "the marker is now dangling" notice. |

`removeAsset` on a prefab with live instances doesn't block the delete; it
returns a warning listing which instances will be left with an orphaned
marker (the next `validateProject` call flags them as
`PREFAB_INSTANCE_ORPHANED`).

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
an authoring/tracked-sync concept for scene files; a spawned-at-runtime
subtree has no asset to sync back to.

## Editor flows

- **Save as prefab** (Hierarchy, per-entity row action): serializes the
  selected entity's subtree via `createPrefab`, prompting for a name inline.
- **Add to scene** (Assets panel, on a prefab asset's card): calls
  `instantiatePrefab` into the currently open scene, positioned at the
  viewport center.
- **Update prefab** (Inspector, shown as a banner — "Instance of `<name>`"
  — when the selected entity carries a `prefab` marker): calls
  `updatePrefab` for that one instance.
- **Sync all** (Inspector, same banner) / **Sync instances** (Assets
  panel, on the prefab asset's card): both call `syncPrefabInstances`,
  after a preflight that counts affected instances across every scene and
  shows a confirm dialog stating the scope and what's kept ("Rebuilds N
  instances from this prefab. Names and positions are kept.") before
  committing — see [Tracked-stamp semantics](#tracked-stamp-semantics-read-this-before-you-sync)
  above for exactly what "kept" does and doesn't cover.

## Non-goals

**No live-linked prefabs or per-field overrides.** Instances are deep copies,
not bindings; you can't override a single component on one instance while
keeping the rest synced. This is intentional — tracked stamps are simpler and
more predictable. Per-field overrides and live-link variants are documented
for a future wave. **Nested prefabs flatten at create time.** If you serialize
a subtree that contains an instance of another prefab, the child's `prefab`
marker gets stripped and its entities bake into the new payload — no reference,
just a flattened copy. **No automatic sync.** Changing a prefab doesn't touch
any instances until you call `syncPrefabInstances`; sync is always explicit.

## See also

- [scripting.md](./scripting.md#entities-in-the-current-scene) — the full
  `ctx.scene` API, including `spawnPrefab` alongside `spawn`/`destroy`.
- [cli.md](./cli.md) — the `hearth prefab` command group.
- [components.md](./components.md#notes) — the entity-level `prefab`
  marker field (not a component).
- [architecture.md](./architecture.md#prefabs) — where prefab
  serialization/instantiation lives in the codebase.
