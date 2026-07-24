---
name: hearth-build
description: Structure a Hearth game's world — scenes, entities, components, tilemaps and autotiling (surfaces must connect), collider/sprite alignment, prefabs, animation state machines, and input bindings. Use when creating or arranging what exists in a Hearth game (levels, objects, hierarchies); behavior scripts are hearth-code, asset sourcing is hearth-art.
---

# Structuring a Hearth game's world

This skill covers **structure** — what exists in the game world: scenes,
entities, components, tilemaps, prefabs, state machines, input bindings.
Behavior lives in the `hearth-code` skill, art/tile sourcing in `hearth-art`,
and the operating loop (inspect → validate → playtest) in the core `hearth` skill.

## Scenes, entities, components

Create entities with their components inline; set properties by dot-path.

```bash
hearth create scene "Level 2"
hearth create entity "Level 1" Coin \
  --position 620,300 --tags pickup \
  --components '{"SpriteRenderer":{"shape":"circle","color":"#f1c40f","width":20,"height":20},"Collider":{"shape":"circle","radius":12,"isTrigger":true}}'

hearth set "Level 1" Coin Transform.position.x 200
hearth set-many "Level 1" Coin --properties '{"Transform.position.y":140,"SpriteRenderer.width":24}'
hearth add component "Level 1" Coin AudioSource --properties '{"assetId":"pickup"}'
hearth remove component "Level 1" Coin AudioSource
hearth duplicate entity "Level 1" Coin
hearth move entity "Level 1" Coin --position 300,140
hearth rename entity "Level 1" Coin Gem
```

`set`/`set-many` validate the full dot-path against the component's real schema
and suggest a fix on a typo. `Collider` polygons must be convex with ≥3 points —
split concave shapes across entities. All 19 component types:
[docs/components.md](https://hearthengine.com/docs/components).

## Tilemaps and autotiling

Paint into a `Tilemap` component's grid; a char is a single character (`.` or a
space = empty, otherwise a `tileAssets` key).

```bash
hearth paint tiles Arena Ground --cells "0,0,G;1,0,G;2,0,G"
hearth fill tiles Arena Ground --rect 2,2,10,6 --char G
hearth resize tilemap Arena Ground --size 40,20
```

Choose the source representation from evidence gathered with `hearth-art`:

- **whole asset** — one standalone image repeated on a grid;
- **fixed frame** — one named slice from a sheet:
  `{"sheet":"ast_sheet","frame":"floor_7"}`;
- **animation** — time-varying art on a sprite entity, not a Tilemap cell;
- **genuine blob47** — a verified 47-shape connective terrain set;
- **authored layers** — one Hearth entity per authored visual layer, preserving
  the source map's order rather than flattening floor/walls/overlays;
- **bottom-aligned oversized sprite** — walls, trees, props, and overhangs whose
  sprite rectangle is taller/wider than the logical tile footprint.

Set a fixed frame through the normal component property path, for example:

```bash
hearth set Arena Ground Tilemap.tileAssets.G '{"sheet":"ast_sheet","frame":"floor_7"}'
```

Autotiling is only for genuine blob47 art: a char's per-cell frame is chosen
from its eight neighbours at render time. Paint terrain first, then bind the
char to a verified sliced sheet:

```bash
hearth import asset ./art/ground-blob47.png --name ground-sheet --json
hearth create asset slice ground-sheet --frame-size 16x16 --prefix ground --json
hearth autotile set Arena Ground --char G --sheet ground-sheet \
  --mapping '{"0":"ground_0","1":"ground_1","4":"ground_2"}'
hearth autotile set Arena Ground --char G --clear   # remove the rule
```

The preview and any export re-render live the moment the rule changes. Full
47-key shape table: [docs/editor.md](https://hearthengine.com/docs/editor).

**Firm rule — surfaces must connect.** Any multi-tile surface, platform, floor,
wall, or built structure MUST use a **connective tileset** whose edge, corner,
interior, and end-cap tiles are chosen by their neighbours — via a `Tilemap`
with a verified blob47 `autotile` rule, or a hand-authored neighbour-aware
tile choice (left-cap / middle / right-cap, top / mid / bottom). **Never** build
a surface from a single tile repeated with autotile OFF, and **never** from a
row/column of individual `SpriteRenderer` entities each holding one tile — both
read as disconnected mismatched blocks, each with its own outline, instead of
one cohesive object. **Never synthesize or compose blob47 from unrelated atlas
tiles.** If the pack is not a verified complete blob47 set, reproduce its
authored layers with fixed frames or choose another supported representation.
Do not guess adjacency from filenames, loose tiles, or frame order.

Hearth Tilemaps are orthogonal square-cell grids. Native isometric projection,
per-tile flips, Y/depth sorting, and dynamic wall occlusion are unsupported.
Depth interleaving is unsupported.
If a pack needs isometric projection or unsupported depth interleaving, reject
that workflow and stop rather than flattening it into an incoherent orthogonal
map. A manually positioned sprite mockup is acceptable only when the human
explicitly approves that reduced scope.

Before production placement, build a proving ground that exercises every
transition/corner, separate authored layers, oversized wall/prop anchors,
actor front/behind behavior, and collision; validate and screenshot it at the
gameplay camera scale.

## Prefabs

Reusable, live-linked entity subtrees.

```bash
hearth prefab create Arena Enemy "Enemy"          # serialize a subtree into an asset
hearth prefab place Enemy Arena --position 400,300 --name "Elite Enemy"
hearth set Arena "Elite Enemy" SpriteRenderer.color "#c9184a"   # implicit per-instance override
hearth prefab update Enemy Arena "Enemy"          # push instance edits to the asset; auto-syncs all instances
hearth prefab sync Enemy                          # force resync every instance from the asset
hearth prefab revert Arena "Elite Enemy" SpriteRenderer color   # revert one field
hearth prefab revert Arena "Elite Enemy"          # revert every override on this instance
```

Editing an instance records overrides automatically; `update`/`sync` merge the
asset payload with each instance's own overrides. A structural edit inside an
instance detaches it. Scripts spawn prefabs with `ctx.scene.spawnPrefab(name,
opts?)`. See [docs/prefabs.md](https://hearthengine.com/docs/prefabs).

## Animation state machines

A `.asm.json` asset drives a sibling `SpriteRenderer` from typed
params/states/transitions instead of one looping clip.

```bash
hearth create asset state-machine hero-motion --data '{
  "params": { "moving": { "type": "bool" } },
  "states": [
    { "name": "idle", "animation": "hero-idle" },
    { "name": "walk", "animation": "hero-walk" }
  ],
  "initial": "idle",
  "transitions": [
    { "from": "idle", "to": "walk", "conditions": [{ "param": "moving", "op": "eq", "value": true }] },
    { "from": "walk", "to": "idle", "conditions": [{ "param": "moving", "op": "eq", "value": false }] }
  ]
}' --json
hearth add component "Level 1" Hero AnimationStateMachine --properties '{"assetId":"ast_..."}'
hearth set-state-machine ast_... --data @machine.json     # replace the document wholesale
```

Drive it from a script with `ctx.animator.setParam/getParam/fire/state` — see
the `hearth-code` skill. Triggers latch until consumed; params are
bool/number/trigger. Full transition semantics:
[docs/scripting.md](https://hearthengine.com/docs/scripting#animation-state-machines).

## Input actions and axes

Scripts read named **actions**, not raw keys, so rebinding never breaks logic.

```bash
hearth set-input jump Space KeyW              # bind keys to an action
hearth set-input jump                         # (no keys) remove the action
hearth set-settings --input-axes '{"horizontal":{"gamepadAxis":0,"negativeCodes":["ArrowLeft"],"positiveCodes":["ArrowRight"]}}'
hearth set-settings --input-gamepad-buttons '{"jump":["a"]}'
hearth set-settings --input-deadzone 0.2
```

Read them with `ctx.input.isDown("jump")` / `ctx.input.axis("horizontal")` — see
the `hearth-code` skill. See [docs/input.md](https://hearthengine.com/docs/input).

## Colliders sit where the art sits

Sprites are center-anchored, and a collider is centered on the entity plus its
`offset`. So a dynamic body whose box/circle collider bottom edge differs from
its sprite's bottom edge visibly floats above — or sinks into — the surfaces it
stands on. Align the feet with `Collider.offset.y`: for a box,
`offset.y = spriteHeight/2 − colliderHeight/2`. `hearth validate` flags any
mismatch over 2px as `SPRITE_COLLIDER_FEET_MISMATCH` and reports the exact
offset that fixes it — fix every one. An intentionally smaller hitbox is fine
(and often right for player characters) as long as the bottoms stay aligned.
