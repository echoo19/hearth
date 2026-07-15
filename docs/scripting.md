# Hearth Scripting Guide

Behavior lives in script files under `scripts/`, attached to entities
through a `Script` component. **Lua is Hearth's default scripting
language** (`hearth create script` emits `.lua`); JavaScript is fully
supported too. See [JavaScript scripts](#javascript-scripts). Both
languages receive the *same* `ctx` API, and the same engine runs in the
editor preview (browser), in headless playtests (Node), and in the
exported web player, so what you test is what ships.

The machine-readable version of everything on this page:
`hearth inspect api --json` (every `ctx` member with signature,
description, and a Lua + JS example). This same `CTX_API` array drives the
editor's [Code panel](./editor.md#code-panel) `ctx.` autocomplete, so the
suggestions you see while typing and this page can never silently drift
apart. Both read the identical source of truth.

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
- `onUiEvent(ctx, event)`: pointer and focus events on this entity's
  interactive/focusable `UIElement`; `event` is `{ type, x, y, value? }`
  with `type` one of `click | press | release | enter | exit | drag |
  change | focus | blur` (`x`/`y` are screen coordinates; see
  [Game UI](#game-ui-screen-space) below for what each type means and when
  `value` is set).
- `onEvent(ctx, name, data)`: every event emitted anywhere in the scene via
  `ctx.events.emit`, scene-wide. Filter by `name` yourself. See
  [Events](#events) below.

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
a no-op that warns once (the seed comes from the session), so no wall
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

**Component mutation contract:** Live component data (returned by `ctx.getComponent()` or accessed via `ctx.transform`) must be mutated by replacement, not in place, to take effect on the current frame. Specifically, `ctx.getComponent('Tilemap').grid` is cached for collider performance: reassign it to a new array (`tilemap.grid = [...]`) for changes to take effect this frame. In-place edits to the same array (e.g. `grid[0] = '####'`) are not detected and will silently use stale collision boxes until the next frame. Always use whole-array assignment for runtime grid changes.

### Input

| Member | What it is |
| --- | --- |
| `ctx.input.isDown(action)` | Is an input action held this frame? |
| `ctx.input.justPressed(action)` | Did the action go down this frame? |
| `ctx.input.axis(name)` | Analog value in `[-1, 1]` for a virtual axis defined in `inputMappings.axes` |

`axis` reads, in order: a sticky `setAxis` playtest override if one is set
(see [Playtests](./cli.md#command-tour)); else the bound gamepad stick
axis, clamped to `[-1, 1]`, once its magnitude clears the deadzone (the
axis's own `deadzone` if set, else the mapping-wide default `0.15`); else
the bound `negativeCodes`/`positiveCodes` keys, `-1`/`+1` when exactly one
side is held, `0` otherwise. An axis name with no entry in
`inputMappings.axes` always reads `0`. See [input.md](./input.md) for how
virtual axes are configured (CLI, MCP, and the editor's Input panel) and
[Gamepad](./input.md#gamepad) for named buttons and axis indices.

### Entities in the current scene

| Member | What it is |
| --- | --- |
| `ctx.scene.find(idOrName)` | EntityHandle or nil (exact name) |
| `ctx.scene.findByTag(tag)` | EntityHandle list |
| `ctx.scene.spawn(def)` | Create an entity at runtime: `{ name, position?, tags?, components? }` |
| `ctx.scene.spawnPrefab(name, opts?)` | Spawn a prefab asset (by name or id) as a fresh entity subtree: `opts = { position?, name? }`. Returns the root's handle, or `nil` if no such prefab exists. |
| `ctx.scene.destroy(ref)` | Remove an entity (id or handle) |
| `ctx.scene.findPath(from, to, opts?)` | Grid A\* path over the scene's solid geometry — `Vec2[]` of cell centers, or `nil` if unreachable |

`findPath` builds its grid from every solid `Tilemap` and every
non-trigger `static` `Collider` currently in the scene (a `dynamic` or
`kinematic` body, or no `PhysicsBody` at all, is never a nav obstacle;
only `static` bodies are), the same geometry a `hearth inspect path`
call or the `inspect_path` MCP tool would see, but read live off the
running scene rather than the authored one. `from`/`to` are plain
`{ x, y }` world positions; `opts` is `{ diagonals? }` (`false` by
default, four-directional movement only). Each waypoint is the center
of a grid cell, not the exact input point, so walk toward each waypoint
and advance once you're within a few pixels rather than expecting an
exact match. The grid is conservative: one-way platforms and
layer-filtered colliders (`oneWay`, `collidesWith`) still rasterize as
solid obstacles, since the nav grid ignores both.

```lua
-- Recompute a path to the player and steer toward its first waypoint.
local path = ctx.scene.findPath(ctx.transform.position, player.transform.position)
if path then
  local toFirst = ctx.math.sub(path[1], ctx.transform.position)
  local steer = ctx.math.scale(ctx.math.normalize(toFirst), 60)
  local body = ctx.getComponent("PhysicsBody")
  body.velocity.x = steer.x
  body.velocity.y = steer.y
end
```

```js
const path = ctx.scene.findPath(ctx.transform.position, player.transform.position);
if (path) {
  ctx.log('path has', path.length, 'waypoints, next one at', path[0].x, path[0].y);
}
```

Re-running `findPath` every frame is wasteful for most AI: the
`bounce-patrol` example (`packages/examples/bounce-patrol`) only
recomputes every 30 frames and walks the cached path waypoint-to-waypoint
in between.

`spawnPrefab` instantiates a prefab asset (authored via `createPrefab` /
`hearth prefab create`, or the editor's "Save as prefab") as a live entity
subtree: every entity in the payload gets a fresh id, parent/child links
within the spawned set are preserved, and spawned children register their
scripts exactly like the root does. Spawning is deterministic: ids come
from the engine's id generator, never the seeded RNG stream, so it doesn't
perturb `ctx.random`. Two things to know before you rely on it:

- An unknown prefab name/id returns `nil` (with a `warn`-level log), the
  same tolerance-for-bad-input contract as `ctx.scene.spawn`. It never
  throws.
- **Destroying the returned root does NOT cascade to its children**:
  `ctx.scene.destroy` is always per-entity, so a spawned subtree's children
  outlive a destroyed root unless you destroy each of them too.

```lua
local grub = ctx.scene.spawnPrefab("Ember Grub", { position = { x = 400, y = 300 } })
```

```js
const grub = ctx.scene.spawnPrefab('Ember Grub', { position: { x: 400, y: 300 } });
```

See [prefabs.md](./prefabs.md) for the full prefab data model, the four
authoring commands, and the editor flows around them.

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

### Math helpers

`ctx.math` is a table of small, pure vec2/color helpers: no mutation, no
engine state, identical in Lua and JS. `Vec2` is always a plain `{x, y}`;
angles are degrees (`0` = +x, `90` = +y/down).

| Member | What it is |
| --- | --- |
| `ctx.math.vec2(x?, y?)` | `{x, y}`, defaults `0, 0` |
| `ctx.math.add(a, b)` | `a + b` |
| `ctx.math.sub(a, b)` | `a - b` |
| `ctx.math.scale(v, s)` | `v * s` |
| `ctx.math.dot(a, b)` | Dot product |
| `ctx.math.length(v)` | Vector magnitude |
| `ctx.math.distance(a, b)` | `length(sub(a, b))` |
| `ctx.math.normalize(v)` | Unit vector (`{0,0}` for a zero-length input) |
| `ctx.math.angle(v)` | Angle of `v`, in degrees |
| `ctx.math.fromAngle(degrees, length?)` | Unit (or scaled) vector at an angle; `length` defaults `1` |
| `ctx.math.lerp(a, b, t)` | Linear interpolation, does not clamp `t` |
| `ctx.math.lerpVec(a, b, t)` | `lerp`, per component |
| `ctx.math.clamp(x, min, max)` | Clamp a number to a range |
| `ctx.math.hexToRgb(hex)` | `{r, g, b}` (0-255); accepts `#rgb`/`#rrggbb`/`#rrggbbaa` |
| `ctx.math.rgbToHex(r, g, b)` | `#rrggbb` string, channels clamped/rounded to 0-255 |
| `ctx.math.colorLerp(hexA, hexB, t)` | Interpolated hex color string, `t` clamped to `[0, 1]` |

```lua
-- Steer toward a target position at a fixed speed.
local toTarget = ctx.math.sub(target, ctx.transform.position)
local steer = ctx.math.scale(ctx.math.normalize(toTarget), 60)
```

```js
// Same helpers, same shapes, from JS.
const toTarget = ctx.math.sub(target, ctx.transform.position);
const steer = ctx.math.scale(ctx.math.normalize(toTarget), 60);
```

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
and every other emitter in the scene. See [Determinism](#determinism)
below for exactly how that makes particle counts assertable in playtests.

### Sprite animation

| Member | What it is |
| --- | --- |
| `ctx.animate(assetRef)` | Switch this entity's `SpriteAnimator` to an animation asset (id or name), set `playing = true`, and restart at frame 0. Warns if the entity has no `SpriteAnimator` or the asset is unknown. |

```lua
ctx.animate("torch-flare")
```

`SpriteAnimator` writes the current frame's asset id (and, for a
spritesheet-backed clip, the sheet frame name into `SpriteRenderer.frame`;
see [assets.md](./assets.md#animations-from-a-sliced-sheet)) into the
sibling `SpriteRenderer` every fixed frame on its own. Most animations
need no script at all. Reach for `ctx.animate` only to switch clips at
runtime (a torch flaring up, a character starting to run).

### Animation state machines

| Member | What it is |
| --- | --- |
| `ctx.animator.setParam(entityRef, name, value)` | Set a bool/number param. Throws for a trigger param (use `fire`) or a type mismatch. |
| `ctx.animator.getParam(entityRef, name)` | Read a bool/number param's value, or a trigger's latched state. |
| `ctx.animator.fire(entityRef, name)` | Latch a trigger param; consumed by the next transition that names it. |
| `ctx.animator.state(entityRef)` | The machine's current state name. |

An `AnimationStateMachine` component (`assetId`, `playing`) drives a
sibling `SpriteRenderer` from a state machine asset instead of a single
looping clip: a state machine asset lives at
`assets/statemachines/<slug>.asm.json`, is created with `createStateMachineAsset`
(CLI `hearth create asset state-machine <name> --data <json|@file>`) and
edited whole with `updateStateMachineAsset` (CLI `hearth set-state-machine
<assetId> --data <json|@file>`), or interactively in the editor's
[Animator editor](./editor.md#animator-editor). When both an
`AnimationStateMachine` and a `SpriteAnimator` are present on the same
entity, the state machine wins (the runtime warns once). `playing: false`
freezes the current frame: no transitions evaluated, no clip advance.

Unlike most of `ctx`, every `ctx.animator` method takes an explicit
`entityRef` (id, or a unique name) rather than always acting on this
entity: it can drive any entity's machine, including itself via
`ctx.entity.id`/`ctx.entity.name`. All four throw a script error (with a
source line, same as any other runtime error; see [Errors and
validation](#errors-and-validation)) when `entityRef` doesn't resolve,
the entity has no `AnimationStateMachine`, its asset is missing, or
`name` doesn't name a real param on that asset.

A state machine asset's document:

```jsonc
{
  "params": { "moving": { "type": "bool" } },
  "states": [
    { "name": "idle", "animation": "walk-idle", "speed": 1 },
    { "name": "walk", "animation": "walk-cycle", "speed": 1 }
  ],
  "initial": "idle",
  "transitions": [
    { "from": "idle", "to": "walk", "conditions": [{ "param": "moving", "op": "eq", "value": true }] },
    { "from": "walk", "to": "idle", "conditions": [{ "param": "moving", "op": "eq", "value": false }] }
  ]
}
```

- **`params`**: a map of name → `{ type: "bool" | "number" | "trigger", default? }`.
  Only `bool`/`number` params take a `default`; a `trigger` has no stored
  value, only a latched/not-latched state.
- **`states`**: each names an existing `animation` asset (id or name) and
  an optional `speed` multiplier (default `1`) applied to that clip's
  `frameDuration`.
- **`initial`**: the state name the machine starts in.
- **`transitions`**: each has a `from` (a state name, or the literal
  `'any'` to match from every state), a `to`, zero or more `conditions`,
  and an optional `exitTime` (`0..1`, gates on the current clip's
  playback progress; `1` means "only once the clip has finished"). Every
  transition needs at least one condition or an `exitTime`. There's no
  unconditional/always-on transition. A condition's `op` is one of `eq |
  neq | gt | gte | lt | lte` for a `number` param, `eq | neq` for a
  `bool` param, and omitted entirely for a `trigger` param (a trigger
  condition is just `{ "param": "attack" }`, true exactly when that
  trigger is currently latched).

**Per fixed step**, at most one transition is taken: explicit `from:
<current state>` transitions are checked first (in declaration order),
then `from: 'any'` ones, first eligible wins. A taken transition resets
the clip to frame 0 and consumes only the trigger(s) its own conditions
reference. Any other latched trigger keeps waiting. Unconsumed triggers
never expire or auto-reset on their own; `fire`d once, a trigger stays
latched across as many frames as it takes for an eligible transition to
consume it (or forever, if none ever does).

The `sky-courier` example (`packages/examples/sky-courier`) drives its
walk-cycle this way. `courier-move.lua` sets a `moving` bool every frame
regardless of whether it actually changed:

```lua
-- setParam is cheap and idempotent, and the machine only restarts a clip
-- when it actually transitions to a different state, so calling this
-- unconditionally every frame doesn't reset the gait the way an
-- unconditional ctx.animate() call would have.
ctx.animator.setParam(ctx.entity.name, "moving", math.abs(vx) > 1)
```

```js
// A trigger-driven attack: fire it on input, read the state back later.
if (ctx.input.justPressed('attack')) {
  ctx.animator.fire(ctx.entity.name, 'attack');
}
```

**Hot-reload note**: saving a *script* while the machine is running
[hot-reloads](#hot-reload-during-play) exactly like any other script:
the machine's live state (current state, param values, latched triggers,
clip position) survives untouched. Swapping the *state machine asset
itself* (`updateStateMachineAsset`, live-patched the same way; see
[editor.md](./editor.md#live-iteration-during-play)) is a different,
deliberate operation: every entity currently on that asset resets to the
new document's `initial` state with params back at their defaults, so
renaming or removing a state in the graph can never leave a live machine
pointing at a state that no longer exists.

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
| `ctx.camera.shake(intensity, seconds, opts?)` | Screen shake: offset decays from `intensity` (world units) to 0 over `seconds` |
| `ctx.camera.flash(color, seconds)` | A color pulse over the screen, fading from full alpha to 0 over `seconds` |
| `ctx.camera.fade(alpha, seconds, opts?)` | Ease the persistent screen overlay to `alpha` over `seconds`, then hold |
| `ctx.camera.zoomPunch(scale, seconds)` | A zoom kick that eases back to `1x` over `seconds` |

All four effects are **last-call-wins per kind**: calling `shake` again
while one is running replaces it outright (one live entry per kind; a
shake in flight doesn't stop a flash, and vice versa). `shake`'s `opts` is
`{ seed? }`: a seeded run (explicit `seed`, or one deterministically
drawn from the session's own RNG stream when omitted) always produces the
same offsets, so shakes are reproducible in playtests without passing a
seed by hand.

`fade`'s `opts` is `{ color?, onComplete? }`. Unlike the other three,
`fade` is **persistent**: the overlay level and color it reaches outlive
the fade itself and carry across a `ctx.scenes.load` scene switch (the new
scene starts at whatever alpha/color the old one held; a fade in flight
at switch time is cut short, its animation discarded, not continued).
Calling `fade` again while one is still easing **supersedes** it: the new
fade continues smoothly from the current level toward its own target, and
the superseded fade's `onComplete` is dropped, never fired, so a stale
completion can't double-trigger something like a scene transition. Only
the fade that actually finishes runs its `onComplete`, exactly once.

```lua
ctx.camera.shake(8, 0.3)
ctx.camera.flash("#ffffff", 0.2)
ctx.camera.fade(1, 0.5, { color = "#000000" })
ctx.camera.zoomPunch(1.2, 0.25)
```

```js
// A death sequence: flash, then fade to black and load the menu.
ctx.camera.flash('#ffffff', 0.15);
ctx.camera.fade(1, 0.6, { color: '#000000', onComplete: () => ctx.scenes.load('Menu') });
```

There's no `ctx.camera.getShake()`/equivalent: effects are write-only
from a script's point of view. Headless playtests can still see what
happened: results expose `cameraEffects` (every shake/flash/fade/zoomPunch
call made during the run, each tagged with the frame it was called on and
its params) and `cameraOverlayAlpha` (the combined flash-over-fade alpha
at the end of the run). The `assertCameraEffect` playtest step asserts
against a **count** of calls to one effect kind, not a live intensity.
See [cli.md](./cli.md#command-tour).

### Effects

| Member | What it is |
| --- | --- |
| `ctx.effects.flash(color?, seconds?)` | Trigger this entity's own hit-flash (per-sprite, via its `SpriteEffects`) |

Sets this entity's `SpriteEffects.flashColor`/`flashStrength: 1`/
`flashDuration` (adding a `SpriteEffects` component if the entity doesn't
have one yet; authored scene data is untouched, the component is created
purely at runtime). `flashStrength` then decays linearly back to `0` over
`seconds` (default `0.15`, clamped to `[0.01, 10]`), deterministically:
same-frame decay applies exactly like `ctx.camera.shake`/`flash`/`fade`/
`zoomPunch` above, so the first read after triggering is already slightly
below `1`, not exactly `1`. No RNG anywhere in the decay.

```lua
ctx.effects.flash("#ff0000", 0.2)
```

```js
ctx.effects.flash('#ff0000', 0.2);
```

This is the **per-sprite** hit flash. For a whole-screen flash use
`ctx.camera.flash` above; for a persistent screen-space look (vignette,
color grade, CRT, …) use the data-driven `Camera.postEffects` stack
instead. See [effects.md](./effects.md) for the full catalog of both
systems, param ranges, and determinism notes.

### UI focus

| Member | What it is |
| --- | --- |
| `ctx.ui.focus(idOrName)` | Focus a `focusable` `UIElement` by id or name; `nil`/`null` clears focus |
| `ctx.ui.getFocused()` | Currently focused entity's id, or `nil`/`null` |
| `ctx.ui.moveFocus(direction)` | Move focus toward the nearest focusable candidate in `"up"\|"down"\|"left"\|"right"` |
| `ctx.ui.activate()` | Click the focused element (fires `press`/`release`/`click` exactly like a real pointer click) |
| `ctx.ui.adjust(delta)` | Nudge a focused `UISlider`'s value by `delta` steps |

`focusable` (a field on `UIElement`, default `false`) is independent of
`interactive` (which gates pointer hit-testing): an element can be
focusable without being interactive, or interactive without being
focusable. `ctx.ui.focus` refuses (warns, no state change) to focus an
entity that isn't focusable, disabled, or unknown.

`moveFocus` picks the nearest focusable candidate strictly in that
direction from the current focus's screen position (or, with nothing
focused, the top-left-most candidate): straight-line distance, no
wraparound, so moving off an edge with nothing further that way is a
no-op. This is what a controller or arrow-key-driven pause menu wires up:
`moveFocus` on d-pad/arrow input, `activate` on a confirm button.

`activate` re-runs the exact pointer-click path (`press` → `release` →
`click` on `onUiEvent`) at the focused element's own position, so a
focused button fires its click handler, a focused `UIToggle` flips, and a
focused `UISlider`'s value is left alone (activating a slider isn't how
you move it; use `adjust` for that). Warns and does nothing if the
focused element isn't `interactive`.

`adjust(delta)` only does something for a focused `UISlider`: it moves
`value` by `delta * step` (falling back to a tenth of the slider's range
when `step` is `0`), clamped to `[min, max]`, firing `onUiEvent
{type:'change', value}` only when the clamped value actually changes. It
no-ops for a focused `UIToggle` or anything else. Use `activate` to flip
a toggle instead.

```lua
-- A confirm/menu script driving focus from actions.
if ctx.input.justPressed("menuDown") then ctx.ui.moveFocus("down") end
if ctx.input.justPressed("menuUp") then ctx.ui.moveFocus("up") end
if ctx.input.justPressed("confirm") then ctx.ui.activate() end
if ctx.input.justPressed("left") then ctx.ui.adjust(-1) end
if ctx.input.justPressed("right") then ctx.ui.adjust(1) end
```

See [ui.md](./ui.md) for the full widget set (`UILayout`/`UISlider`/
`UIToggle`), the `onUiEvent` reference, and playtest coverage
(`drag`/`assertFocus`).

### Audio

| Member | What it is |
| --- | --- |
| `ctx.audio.play(ref, opts?)` | Play an audio asset (id or name); `opts` is `{ volume?, loop? }`. Returns a handle id, or nothing if the asset doesn't exist |
| `ctx.audio.stop(ref)` | Stop one playback by handle id, or every playback of an asset id/name |
| `ctx.audio.playMusic(ref, opts?)` | Play a track on the single shared music channel; `opts` is `{ volume?, loop?, fadeIn? }` (`loop` defaults to `true`). Replaces whatever is currently playing (crossfades over `fadeIn`) and survives `ctx.scenes.load` scene switches. Returns a handle id, or nothing if the asset doesn't exist |
| `ctx.audio.stopMusic(opts?)` | Stop the current music track; `opts` is `{ fadeOut? }`. No-op when nothing is playing |
| `ctx.audio.setMusicVolume(volume, opts?)` | Change the current track's volume; `opts` is `{ fade? }`. No-op when nothing is playing |

```lua
ctx.audio.playMusic("theme", { loop = true, fadeIn = 1 })
ctx.audio.setMusicVolume(0.3, { fade = 0.5 })
ctx.audio.stopMusic({ fadeOut = 1 })
```

The music channel is separate from `ctx.audio.play`/`stop`: it's always
exactly one track, not a pool of playbacks, and it lives on the session
rather than the current scene, so switching scenes never interrupts it.
An `AudioSource` with `autoplay: true, music: true` starts a track this
way with no script at all. See
[assets.md](./assets.md#music) for the full semantics (crossfade
behavior, streaming vs. single-file exports).

### Events

| Member | What it is |
| --- | --- |
| `ctx.events.emit(name, data?)` | Emit an event, synchronously and deterministically, to every listener in the scene |
| `ctx.events.on(name, fn)` | Subscribe `fn(data)` to events named `name`; returns a subscription id |
| `ctx.events.off(id)` | Unsubscribe (unknown ids are a no-op) |

`ctx.events.emit` delivers in a fixed order: every `ctx.events.on`
subscriber for that `name` first (in subscription order), then every
entity's `onEvent(ctx, name, data)` hook (in creation order, unfiltered;
it sees *every* event, not just ones it subscribed to). Both are plain
synchronous function calls, so an emit inside a handler runs its
listeners before the outer emit continues.

```lua
-- Emitter (e.g. a Coin's onCollision): tell the scene a coin was collected.
ctx.events.emit("coin", { value = 1 })
```

```lua
-- Listener via onEvent — fires for every event, so filter by name.
function script.onEvent(ctx, name, data)
  if name ~= "coin" then return end
  ctx.vars.score = (ctx.vars.score or 0) + data.value
end
```

```js
// Same emit, subscribed instead via ctx.events.on.
const subId = ctx.events.on('coin', (data) => {
  ctx.vars.score = (ctx.vars.score ?? 0) + data.value;
});
```

Two safety rules keep this from turning into a runaway or a leak:

- **Depth limit**: an emit triggered from inside another emit's delivery
  (an `onEvent`/subscriber calling `ctx.events.emit` again) is allowed to
  nest up to **8 deep**; the 9th nested emit is dropped with a console
  warning instead of recursing further. Top-level emits (one after
  another, not nested) aren't affected.
- **Auto-cleanup**: `ctx.events.on` subscriptions belong to the entity
  that created them and are removed automatically when that entity is
  destroyed. No manual `ctx.events.off` bookkeeping needed on teardown.
  A script disabled after repeated errors (see
  [Errors and validation](#errors-and-validation)) stops receiving events
  too, both via `onEvent` and its own subscriptions.

The `bounce-patrol` example's `ScoreUI` (`packages/examples/bounce-patrol`)
is a complete, playtested emit/`onEvent` pair: coins emit `"coin"` on
pickup, the score label increments purely from `onEvent`, no
`ctx.events.on` subscription needed at all.

Event payloads (and other JS-side objects) reach Lua as proxies, not
plain Lua tables: `data.value` field access works as expected, but
`type(data)` reports `"userdata"` rather than `"table"`, and `pairs(data)`
does not enumerate its fields. Guard with `type(data.value) == "number"`
(or similar direct field checks), never `type(data) == "table"`.

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

Shipped Hearth games have **no engine chrome**: the exported player boots
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

With the same inputs and the same seed, a scene advances identically:
that's what makes playtests trustworthy. The runtime is fixed-timestep;
timers, tweens, and RNG are all deterministic; and the Lua sandbox blocks
every source of nondeterminism (wall clock, unseeded random). If you keep
your logic inside `ctx`, determinism is free.

This guarantee is same-seed, same-machine: a given seed replays bit-for-bit
on the same platform. It is not a cross-platform bit-equality claim: code
that uses transcendental math (`Math.cos`, `Math.sin`, `Math.pow`, and the
like, including the velocity spread of `ParticleEmitter`) can differ by a
floating-point ULP between CPU architectures and JS-engine builds, because
those functions are approximated rather than exactly specified by IEEE 754.
Seeded RNG and ordinary `+ - * / sqrt` arithmetic are exact everywhere.

`ParticleEmitter.seed` gives each emitter its own independent, deterministic
RNG stream (separate from `ctx.random` and every other emitter), so the same
project always spawns the same particles. Spawning itself lands on whole
fixed frames via an accumulator (`rate` per second × `dt` added every fixed
step, one particle spawned each time the accumulator crosses `1.0`), and
because most `rate`/`dt` products aren't exactly representable in binary
floating point, the first crossing can land one frame later than the naive
`60 / rate` arithmetic suggests. For example `rate: 10` at 60fps spawns on
frames 7, 13, 19, 25, 31 (not 6, 12, 18, 24, 30) because `10 * (1/60)`
summed six times lands a hair under `1.0`. `assertParticleCount` playtest
steps (and `ctx.particles.count()`) always read the true live count, so
write expected numbers from a real run rather than hand arithmetic when it
matters. See `packages/playtest/tests/particles.test.ts` for the fully
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
Set `interactive: true` and the entity's script receives `onUiEvent`:
that's all a menu button is. Set `focusable: true` and the same entity can
receive keyboard/gamepad focus via `ctx.ui` (see [UI focus](#ui-focus)
above). A menu button is typically both. `UILayout` (stack containers),
`UISlider`, and `UIToggle` build real menus and settings screens out of
the same component system; see [ui.md](./ui.md) for the full reference.

## JavaScript scripts

`.js` scripts remain fully supported with the exact same `ctx`. Nothing
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
- Don't use `Math.random()` or `Date.now()`: use `ctx.random` and
  `ctx.time` so playtests stay deterministic (Lua scripts get this
  protection automatically; JS scripts are on the honor system).
- Mixed projects work: some entities can run `.lua` scripts and others
  `.js` in the same scene.

## Errors and validation

- A script that throws in a hook logs a runtime error; after 3 consecutive
  errors the script is disabled for that entity (the game keeps running).
  Lua errors carry `scripts/foo.lua:LINE` so you can jump to the line.
- `hearth validate` syntax-checks every script (both languages) and
  reports `SCRIPT_SYNTAX_ERROR` with the file and line. Agents can fix
  scripts without booting the game.
- `hearth check-script <path> [--source text]` (MCP `check_script`)
  pre-flights a single script (source text you haven't saved yet, or an
  existing file) without writing anything: read-only, same diagnostics
  shape as `validate`'s per-script check. Useful before `edit-script`/
  `edit_script` when you want to confirm a draft is syntactically valid
  first. This is also what the editor's Code panel runs on every edit to
  drive its inline lint gutter (see [editor.md](./editor.md#code-panel)).

## Hot-reload during play

Saving a script while the editor is playing hot-reloads it into the
running scene instead of requiring a Stop/Play round-trip: whether the
save comes from the editor's own [Code panel](./editor.md#code-panel) or
from `edit_script`/`edit-script` run by a CLI or MCP agent against the
same project (the editor picks up the external edit over the command
journal and reloads it the same way; see
[editor.md](./editor.md#live-iteration-during-play)). `formatScript` and
`replaceInScripts` reload every script file they touch the same way.

**What survives a reload:** every live entity already running that
script keeps its `ctx.vars`, pending `ctx.timers`, running `ctx.tweens`,
and `ctx.entity`/`ctx.params`. Only the compiled hook functions
(`onStart`/`onUpdate`/`onCollision`/`onUiEvent`/`onEvent`) are swapped
for the new code. **`onStart` does NOT re-run** on reload. It only runs
once, the first time an entity starts. A script that had been
error-disabled (three consecutive errors, see
[Errors and validation](#errors-and-validation) below) re-enables on a
successful reload. Future spawns of the script (e.g. via
`ctx.scene.spawn`) pick up the new code too. If the edited source fails
to compile, the reload is rejected and every entity keeps running the
**old** code unchanged. A bad save during play never breaks a running
game.

**Pinned caveat: `ctx.events.on` subscriptions do not re-bind.** A
subscription registered with `ctx.events.on(name, fn)` closes over the
`fn` that existed at the time it was called; reloading the script
recompiles the module but cannot, and does not, re-register existing
subscriptions against the new code, so an already-subscribed callback
keeps running its **old** closure until the entity restarts (Stop/Play).
The `onEvent(ctx, name, data)` hook has no such caveat: it always
resolves to whatever code was most recently loaded, exactly like
`onUpdate`/`onCollision`. If you need a listener that reliably tracks
live edits, prefer `onEvent` (with a `name` filter) over `ctx.events.on`
for anything you expect to iterate on during play. This is documented,
tested, pinned behavior, not a bug.

**Runtime error → exact line.** A script error logged to the Console
during play is clickable: clicking it jumps the [Code
panel](./editor.md#code-panel) to the failing line. Lua errors always
carry a line (`scripts/foo.lua:LINE`, the same format `hearth validate`
and `checkScript` use); JS errors resolve a line on a best-effort basis:
some JS runtime errors (e.g. ones thrown from inside a callback with
no useful stack frame in the script itself) have no extractable line, in
which case the Console entry isn't clickable.

## Input actions

Scripts read actions rather than raw keys: `hearth.json` maps action
names to `KeyboardEvent.code` lists. Change them with
`hearth set-input jump Space KeyW` (or the `updateSettings` command).
Scripts keep working when keys are rebound, and playtests can `press`
actions headlessly.
