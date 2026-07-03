# Hearth Scripting Guide

Behavior lives in plain JavaScript files under `scripts/`, attached to
entities through a `Script` component. The same script engine runs in the
editor preview (browser) and in headless playtests (Node), so what you test
is what ships.

## A script

```js
/**
 * Move right forever. params: speed (px/s)
 */
export default {
  onStart(ctx) {
    ctx.vars.startedAt = ctx.time.elapsed;
    ctx.log('spawned at', ctx.transform.position.x, ctx.transform.position.y);
  },

  onUpdate(ctx, dt) {
    ctx.transform.position.x += (ctx.params.speed ?? 100) * dt;
  },

  onCollision(ctx, other) {
    if (other.tags.includes('player')) ctx.destroySelf();
  },
};
```

- `onStart(ctx)`: once, when the scene starts (frame 0).
- `onUpdate(ctx, dt)`: every fixed frame; `dt` is seconds (1/`fixedTimestep`).
- `onCollision(ctx, other)`: once per **new** contact pair per frame;
  `other` is an EntityHandle. Fires for trigger and solid contacts alike.
- `onUiEvent(ctx, event)`: pointer events on this entity's interactive
  `UIElement`; `event` is `{ type, x, y }` with `type` one of
  `'click' | 'press' | 'release' | 'enter' | 'exit'` (screen coordinates).

## The `ctx` API

| Member | What it is |
| --- | --- |
| `ctx.entity` | `{ id, name, tags }` of the entity this script is attached to |
| `ctx.transform` | Live `Transform` data; mutate `position/rotation/scale` directly |
| `ctx.getComponent(type)` | Live component data (e.g. `'PhysicsBody'`, `'Text'`) or `undefined` |
| `ctx.params` | The `Script` component's `params` object (set per entity) |
| `ctx.input.isDown(action)` | Is an input action held this frame? |
| `ctx.input.justPressed(action)` | Did the action go down this frame? |
| `ctx.scene.find(name)` | EntityHandle or `null` (exact name) |
| `ctx.scene.findByTag(tag)` | EntityHandle[] |
| `ctx.scene.spawn(def)` | Create an entity at runtime: `{ name, position?, tags?, components? }` |
| `ctx.scene.destroy(ref)` | Remove an entity (id, or handle) |
| `ctx.audio.play(ref, opts?)` | Play an audio asset (id or name); `opts` is `{ volume?, loop? }`. Returns a handle id, or `null` if the asset doesn't exist |
| `ctx.audio.stop(ref)` | Stop one playback by handle id, or every playback of an asset id/name |
| `ctx.collisions` | This entity's current contacts: `{ other, normal, trigger }[]` |
| `ctx.isGrounded()` | True when standing on something (a solid contact pushing up) |
| `ctx.vars` | Persistent per-entity plain object, your state between frames |
| `ctx.time` | `{ elapsed, delta, frame }` |
| `ctx.log(...args)` | Log to the Hearth console (editor Console panel / CLI output) |
| `ctx.destroySelf()` | Remove this entity |

EntityHandles (from `find`/`findByTag`/`collisions`/`onCollision`) expose
`{ id, name, tags, transform, getComponent(type), destroy() }`, enough to
read/steer other entities (e.g. update a score `Text`).

## Physics interplay

If the entity has a `PhysicsBody`:
- `dynamic`: gravity (980 px/s² × `gravityScale`, +y is down) and collisions
  move it; steer it by setting `body.velocity.x/y` in `onUpdate`.
- `kinematic`: moves only by its `velocity` (or direct transform writes);
  never pushed by collisions.
- `static`: never moves.

For a platformer: set `velocity.x` from input each frame, set a negative
`velocity.y` to jump when `ctx.isGrounded()`. For top-down: `gravityScale: 0`
and drive both axes. See `packages/examples/*/scripts/` for working
reference scripts.

## Audio

`ctx.audio.play('coin-sound')` plays an audio asset by id or name; an
`AudioSource` component with `autoplay: true` plays its asset on scene
start. Make sound effects with `hearth create sound <name> --preset coin`
(presets: `coin`, `jump`, `hit`, `laser`, `powerup`, `explosion`, `blip`;
deterministic WAVs, same preset + seed → identical bytes).

Headless runs make no sound, but every play/stop is recorded in the run
report as `audioEvents: [{ frame, assetId, action }]`, so agents and tests
can verify audio behavior without speakers. In the browser (editor preview
and web exports) the same calls go through Web Audio.

## Game UI (screen space)

Give an entity a `UIElement` component and it renders in screen space:
positioned by `anchor` (nine positions, `top-left` through `bottom-right`)
plus a pixel `offset`, unaffected by camera position or zoom. Visuals come
from the same `Text` / `SpriteRenderer` components as any other entity;
`Transform.position` is ignored.

Set `interactive: true` and the entity's script receives `onUiEvent`:

```js
export default {
  onUiEvent(ctx, event) {
    if (event.type !== 'click') return;
    ctx.audio.play('click-sound');
    ctx.log('button clicked');
  },
};
```

The mini-platformer example's score HUD and Restart button
(`packages/examples/mini-platformer`) show both patterns.

## Rules & limitations

- **No `import`/`require`.** Scripts are single-file, evaluated in a function
  scope with `module.exports` semantics behind the scenes. Helpers are fine:
  define functions in the same file.
- Scripts are plain JS (TypeScript scripts are on the roadmap).
- A script that throws in a hook logs a runtime error; after 3 consecutive
  errors the script is disabled for that entity (the game keeps running).
- Determinism: with the same inputs, a scene advances identically. That's
  what makes playtests reliable. Don't reach for `Date.now()`/`Math.random()`
  in logic you want to playtest (use `ctx.time` and `ctx.vars` seeds).

## Input actions

Scripts read actions rather than raw keys: `hearth.json` maps action
names to `KeyboardEvent.code` lists. Change them with
`hearth set-input jump Space KeyW`. Scripts keep working when keys are
rebound, and playtests can `press` actions headlessly.
