# Hearth Scripting Guide

Behavior lives in script files under `scripts/`, attached to entities
through a `Script` component. **Lua is Hearth's default scripting
language** (`hearth create script` emits `.lua`); JavaScript is fully
supported too — see [JavaScript scripts](#javascript-scripts). Both
languages receive the *same* `ctx` API, and the same engine runs in the
editor preview (browser), in headless playtests (Node), and in the
exported web player — so what you test is what ships.

The machine-readable version of everything on this page:
`hearth inspect api --json` (every `ctx` member with signature,
description, and a Lua + JS example).

## A Lua script

```lua
-- Move right forever. params: speed (px/s)
local script = {}

function script.onStart(ctx)
  ctx.vars.startedAt = ctx.time.elapsed
  ctx.log("spawned at", ctx.transform.position.x, ctx.transform.position.y)
end

function script.onUpdate(ctx, dt)
  local speed = ctx.params.speed or 100
  ctx.transform.position.x = ctx.transform.position.x + speed * dt
end

function script.onCollision(ctx, other)
  if other.name == "Player" then ctx.destroySelf() end
end

return script
```

A Lua script builds a table of lifecycle hooks and `return`s it:

- `onStart(ctx)`: once, when the scene starts (frame 0).
- `onUpdate(ctx, dt)`: every fixed frame; `dt` is seconds (1/`fixedTimestep`).
- `onCollision(ctx, other)`: once per **new** contact pair per frame;
  `other` is an EntityHandle. Fires for trigger and solid contacts alike.
- `onUiEvent(ctx, event)`: pointer events on this entity's interactive
  `UIElement`; `event` is `{ type, x, y }` with `type` one of
  `click | press | release | enter | exit` (screen coordinates).

### The dot-call rule (important)

`ctx` is a live JavaScript object proxied into Lua, **not** a Lua object
with methods. Call everything with a **dot**, never a colon:

```lua
ctx.log("hi")            -- ✓ correct
ctx.scenes.load("Level") -- ✓ correct
ctx:log("hi")            -- ✗ WRONG: colon passes ctx as a hidden first arg
```

Reads and writes go straight through to the engine
(`ctx.transform.position.x = 400` moves the real entity), and Lua tables
you pass *in* (e.g. to `ctx.scene.spawn`) are converted to plain JS
objects by value.

### The Lua sandbox

Scripts run Lua 5.4 (via wasmoon) with `os`, `io`, `package`, `require`,
`dofile`, `load`, `loadstring`, `debug`, and `collectgarbage` removed.
`print(...)` routes to the Hearth console, and `math.random` is backed
by the engine's **seeded** stream (the integer forms `math.random(m)`
and `math.random(m, n)` keep their Lua semantics); `math.randomseed` is
a no-op that warns once — the seed comes from the session — so no wall
clock or unseeded randomness can leak into game logic. `string`,
`table`, and `math` are otherwise all available.

## The `ctx` API

One surface, identical in Lua and JS. Where JS returns `null`/`undefined`
Lua sees `nil`; where JS takes an object literal Lua passes a table.

### This entity

| Member | What it is |
| --- | --- |
| `ctx.entity` | `{ id, name, tags }` of the entity this script is attached to |
| `ctx.transform` | Live `Transform` data; mutate `position/rotation/scale` directly |
| `ctx.getComponent(type)` | Live component data (e.g. `'PhysicsBody'`, `'Text'`) or nothing |
| `ctx.params` | The `Script` component's `params` object (set per entity) |
| `ctx.vars` | Persistent per-entity state, survives across frames (not across scene switches — use `ctx.save`) |
| `ctx.destroySelf()` | Remove this entity |

### Input

| Member | What it is |
| --- | --- |
| `ctx.input.isDown(action)` | Is an input action held this frame? |
| `ctx.input.justPressed(action)` | Did the action go down this frame? |

### Entities in the current scene

| Member | What it is |
| --- | --- |
| `ctx.scene.find(idOrName)` | EntityHandle or nil (exact name) |
| `ctx.scene.findByTag(tag)` | EntityHandle list |
| `ctx.scene.spawn(def)` | Create an entity at runtime: `{ name, position?, tags?, components? }` |
| `ctx.scene.destroy(ref)` | Remove an entity (id or handle) |

### Scene management

| Member | What it is |
| --- | --- |
| `ctx.scenes.current` | Current scene `{ id, name }` |
| `ctx.scenes.list()` | All scenes in the project as `{ id, name }` |
| `ctx.scenes.load(idOrName)` | Request a scene switch at end of frame; returns `false` (plus a warning) if the scene is unknown |

The switch happens *after* the current frame completes: the old scene's
runtime is destroyed (its audio stops), the new scene starts fresh from
its authored state. Save data (`ctx.save`), the RNG stream, and the frame
counter carry across.

### Timers

| Member | What it is |
| --- | --- |
| `ctx.timers.after(seconds, fn)` | Run `fn` once after `seconds`; returns a cancel id |
| `ctx.timers.every(seconds, fn)` | Run `fn` every `seconds`; returns a cancel id |
| `ctx.timers.cancel(id)` | Cancel a timer |

Timers belong to the entity whose ctx created them and die with it. They
fire deterministically at the start of that entity's update, in creation
order.

### Tweens

| Member | What it is |
| --- | --- |
| `ctx.tweens.to(path, target, seconds, opts?)` | Tween a numeric component property on this entity; returns a cancel id |
| `ctx.tweens.cancel(id)` | Cancel a tween |

```lua
ctx.tweens.to("Transform.position.x", 400, 0.5, { easing = "easeOut" })
```

`opts` is `{ easing?, onComplete? }` with easing one of
`linear | easeIn | easeOut | easeInOut`. An unknown or non-numeric path
logs a warning and returns an empty id.

### Seeded random

| Member | What it is |
| --- | --- |
| `ctx.random.next()` | Deterministic float in `[0, 1)` |
| `ctx.random.range(min, max)` | Deterministic float in `[min, max)` |
| `ctx.random.int(min, max)` | Deterministic integer, min and max inclusive |

Same seed → same sequence, every run, on every host. In Lua,
`math.random` is backed by the same stream. Playtests set the seed in
their JSON (`"seed": 42`); the editor preview and exported player run
seed 0. **Never** reach for `Date.now()` or wall-clock time in game logic.

### Particles

| Member | What it is |
| --- | --- |
| `ctx.particles.burst(count)` | Spawn `count` particles immediately from this entity's `ParticleEmitter` (on top of its normal `rate`/`burst`). Warns if the entity has none. |
| `ctx.particles.count()` | Live particle count for this entity's `ParticleEmitter` (`0` if none). |

```lua
-- Every 2 seconds, a burst of extra sparks (needs a ParticleEmitter on this entity).
ctx.timers.every(2, function()
  ctx.particles.burst(6)
  ctx.log("sparks:", ctx.particles.count())
end)
```

`ParticleEmitter` has its own `seed` field, independent of both `ctx.random`
and every other emitter in the scene — see [Determinism](#determinism)
below for exactly how that makes particle counts assertable in playtests.

### Sprite animation

| Member | What it is |
| --- | --- |
| `ctx.animate(assetRef)` | Switch this entity's `SpriteAnimator` to an animation asset (id or name), set `playing = true`, and restart at frame 0. Warns if the entity has no `SpriteAnimator` or the asset is unknown. |

```lua
ctx.animate("torch-flare")
```

`SpriteAnimator` writes the current frame's asset id into the sibling
`SpriteRenderer.assetId` every fixed frame on its own — most animations need
no script at all. Reach for `ctx.animate` only to switch clips at runtime
(a torch flaring up, a character starting to run).

### Save data

| Member | What it is |
| --- | --- |
| `ctx.save(key, value)` | Persist a JSON value; survives scene switches |
| `ctx.load(key)` | Read saved data (nothing when absent) |
| `ctx.clearSave(key?)` | Clear one key, or all save data with no key |

In the browser (editor preview and exported games) save data persists
across sessions via `localStorage`, namespaced per project. Headless runs
use in-memory storage scoped to the run.

### Camera

| Member | What it is |
| --- | --- |
| `ctx.camera.getPosition()` | Main camera position `{ x, y }` |
| `ctx.camera.setPosition(x, y)` | Move the main camera |
| `ctx.camera.getZoom()` / `setZoom(zoom)` | Camera zoom |
| `ctx.camera.follow(idOrName)` | Follow an entity each frame (nil/null stops); applied at end of frame after physics |

### Audio

| Member | What it is |
| --- | --- |
| `ctx.audio.play(ref, opts?)` | Play an audio asset (id or name); `opts` is `{ volume?, loop? }`. Returns a handle id, or nothing if the asset doesn't exist |
| `ctx.audio.stop(ref)` | Stop one playback by handle id, or every playback of an asset id/name |

### Collisions, time, logging

| Member | What it is |
| --- | --- |
| `ctx.collisions` | This entity's current contacts: `{ other, normal, trigger }` list |
| `ctx.isGrounded()` | True when standing on something (a solid contact pushing up) |
| `ctx.time` | `{ elapsed, delta, frame }` |
| `ctx.log(...)` | Log to the Hearth console (editor Console panel / run reports) |

EntityHandles (from `find`/`findByTag`/`collisions`/`onCollision`) expose
`{ id, name, tags, transform, getComponent(type), destroy() }`, enough to
read/steer other entities (e.g. update a score `Text`).

## Building a start screen / menu

Shipped Hearth games have **no engine chrome** — the exported player boots
straight into the project's initial scene. A start screen is therefore
just a scene you build: some `Text`, an interactive `UIElement` button,
and one line of Lua.

```lua
-- start-button.lua, attached to a UIElement with interactive = true
local script = {}

function script.onUiEvent(ctx, event)
  if event.type ~= "click" then return end
  ctx.scenes.load("Level")
end

return script
```

Pair it with `ctx.save`/`ctx.load` for a persistent best score:

```lua
-- In the level, when the run ends:
local best = ctx.load("best")
if type(best) ~= "number" then best = 0 end
if score > best then ctx.save("best", score) end
ctx.scenes.load("Menu")
```

The `ember-trail` example (`packages/examples/ember-trail`) is a complete,
playtested, all-Lua game built exactly this way: menu scene → level scene
→ back, with timers, seeded spawns, camera follow, and a saved best score.

## Determinism

With the same inputs and the same seed, a scene advances identically —
that's what makes playtests trustworthy. The runtime is fixed-timestep;
timers, tweens, and RNG are all deterministic; and the Lua sandbox blocks
every source of nondeterminism (wall clock, unseeded random). If you keep
your logic inside `ctx`, determinism is free.

`ParticleEmitter.seed` gives each emitter its own independent, deterministic
RNG stream (separate from `ctx.random` and every other emitter), so the same
project always spawns the same particles. Spawning itself lands on whole
fixed frames via an accumulator (`rate` per second × `dt` added every fixed
step, one particle spawned each time the accumulator crosses `1.0`) — and
because most `rate`/`dt` products aren't exactly representable in binary
floating point, the first crossing can land one frame later than the naive
`60 / rate` arithmetic suggests. For example `rate: 10` at 60fps spawns on
frames 7, 13, 19, 25, 31 — not 6, 12, 18, 24, 30 — because `10 * (1/60)`
summed six times lands a hair under `1.0`. `assertParticleCount` playtest
steps (and `ctx.particles.count()`) always read the true live count, so
write expected numbers from a real run rather than hand arithmetic when it
matters — see `packages/playtest/tests/particles.test.ts` for the fully
worked example.

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
reference scripts in both languages.

## Game UI (screen space)

Give an entity a `UIElement` component and it renders in screen space:
positioned by `anchor` (nine positions, `top-left` through `bottom-right`)
plus a pixel `offset`, unaffected by camera position or zoom. Visuals come
from the same `Text` / `SpriteRenderer` components as any other entity.
Set `interactive: true` and the entity's script receives `onUiEvent` —
that's all a menu button is.

## JavaScript scripts

`.js` scripts remain fully supported with the exact same `ctx` — nothing
was removed. Create one with `hearth create script <name> --language js`.
A JS script `export default`s its hooks:

```js
export default {
  onStart(ctx) {
    ctx.vars.startedAt = ctx.time.elapsed;
  },

  onUpdate(ctx, dt) {
    ctx.transform.position.x += (ctx.params.speed ?? 100) * dt;
  },

  onCollision(ctx, other) {
    if (other.tags.includes('player')) ctx.destroySelf();
  },

  onUiEvent(ctx, event) {
    if (event.type === 'click') ctx.scenes.load('Level');
  },
};
```

JS-specific rules:

- **No `import`/`require`.** Scripts are single-file, evaluated in a
  function scope with `module.exports` semantics behind the scenes.
  Helper functions in the same file are fine.
- Don't use `Math.random()` or `Date.now()` — use `ctx.random` and
  `ctx.time` so playtests stay deterministic (Lua scripts get this
  protection automatically; JS scripts are on the honor system).
- Mixed projects work: some entities can run `.lua` scripts and others
  `.js` in the same scene.

## Errors and validation

- A script that throws in a hook logs a runtime error; after 3 consecutive
  errors the script is disabled for that entity (the game keeps running).
  Lua errors carry `scripts/foo.lua:LINE` so you can jump to the line.
- `hearth validate` syntax-checks every script (both languages) and
  reports `SCRIPT_SYNTAX_ERROR` with the file and line — agents can fix
  scripts without booting the game.

## Input actions

Scripts read actions rather than raw keys: `hearth.json` maps action
names to `KeyboardEvent.code` lists. Change them with
`hearth set-input jump Space KeyW` (or the `updateSettings` command).
Scripts keep working when keys are rebound, and playtests can `press`
actions headlessly.
