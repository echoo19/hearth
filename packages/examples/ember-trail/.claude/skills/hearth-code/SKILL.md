---
name: hearth-code
description: Write behavior in Hearth — Lua/JS scripts, the ctx API (input, timers, tweens, events, camera, audio, save), script modules and require, the dot-call and userdata pitfalls, deterministic RNG, and the check-script/edit-script iteration loop. Use when making things happen in a Hearth game (movement, AI, pickups, rules); world structure is hearth-build, polish recipes are hearth-feel.
---

# Scripting Hearth: the ctx stdlib

This skill covers **making things happen** — behavior scripts and the `ctx` API.
What entities/components exist in the world is the `hearth-build` skill;
game-feel recipes that *use* these APIs live in `hearth-feel`; the operating
loop (validate, playtest, screenshot, snapshot) is the core `hearth` skill.

`hearth inspect api --json` is the canonical, always-current `ctx` reference —
every member with signature, docs, and a Lua + JS example. Read it when
scripting instead of trusting memory.

## Scripts and lifecycle hooks

Behavior lives in `scripts/`. **Lua is the default** (`hearth create script`
emits `.lua`); JS is equally supported (`--language js`). Both get the identical
`ctx` API and run the same in editor preview, headless playtests, and export.

```bash
hearth create script coin-spin                 # Lua
hearth create script boss-ai --language js
hearth create script noise --dir lib           # scripts/lib/noise.lua helper
hearth attach script "Level 1" Coin scripts/coin-spin.lua
```

A Lua script returns a table of lifecycle hooks; JS `export default`s an object
with the same hooks: `onStart(ctx)`, `onUpdate(ctx, dt)`,
`onCollision(ctx, other)`, `onUiEvent(ctx, event)`, `onEvent(ctx, name, data)`.

## Script modules

Share helpers with load-time `require` from the top of the file:

```lua
local noise = require("lib/noise") -- scripts/lib/noise.lua
```

```js
const noise = require('lib/noise'); // scripts/lib/noise.js
```

A library is just a script that returns a table (Lua) or exports an object
(JS), usually with no lifecycle hooks. No new asset type. Rules that matter:
same-language only (`.lua` requires `.lua`, `.js` requires `.js`), resolution
cannot escape `scripts/`, cycles are errors, and `require` is load-time only.
Call it at the top of the file, not inside `onUpdate` or another hook.

Hot reload recompiles dependents when a library changes. If any compile fails,
the old graph keeps running. Module top-level state resets on successful reload,
so put state that must survive in `ctx.vars`.

## The three pitfalls

**The dot-call rule (critical).** `ctx` is a live JS object proxied into Lua,
not a Lua object. Call everything with a **dot**, never a colon — a colon passes
`ctx` as a hidden first argument and breaks the call:

```lua
ctx.log("hi")              -- correct
ctx.scenes.load("Level")   -- correct
ctx:log("hi")              -- WRONG
```

**The userdata-proxy pitfall.** JS-side objects (event payloads, handles) reach
Lua as proxies, not tables: `data.value` works, but `type(data)` reports
`"userdata"` and `pairs(data)` does not enumerate. Guard with direct field
checks (`type(data.value) == "number"`), never `type(data) == "table"`.

**Component mutation is by replacement.** Reassign whole arrays for a live
effect — `tilemap.grid = {...}` takes this frame; `grid[0] = "####"` is not
detected and can leave stale collision boxes indefinitely.

## What ctx gives you

Read `hearth inspect api --json` for exact signatures:

- **This entity**: `ctx.entity`, `ctx.transform`, `ctx.getComponent(type)`,
  `ctx.params`, `ctx.vars` (per-entity, survives frames not scene switches),
  `ctx.destroySelf()`.
- **Scene**: `ctx.scene.find/findByTag/spawn/spawnPrefab/destroy/findPath`,
  `ctx.scenes.current/list/load`.
- **Input**: `ctx.input.isDown/justPressed(action)`, `ctx.input.axis(name)`.
- **Timers**: `ctx.timers.after/every/cancel` (deterministic, entity-owned).
- **Tweens**: `ctx.tweens.to(path, target, seconds, { easing })`.
- **Seeded random**: `ctx.random.next/range/int` — same seed → same sequence.
  In Lua, `math.random` is backed by the same stream; `math.randomseed` is a
  no-op. **Never** use `Date.now()`/`Math.random()` in game logic.
- **Save**: `ctx.save/load/clearSave` (survives scene switches; localStorage in
  the browser).
- **Camera**: `ctx.camera.setPosition/follow/shake/flash/fade/zoomPunch`
  (effects are last-call-wins per kind; `fade` persists across scenes).
- **Effects**: `ctx.effects.flash(color, seconds)` — per-sprite hit flash.
- **Events**: `ctx.events.emit/on/off` and the `onEvent` hook (synchronous,
  deterministic, auto-cleanup on destroy).
- **Audio**: `ctx.audio.play/stop`, and the separate music channel
  `ctx.audio.playMusic/stopMusic/setMusicVolume`.
- **UI focus**: `ctx.ui.focus/moveFocus/activate/adjust` for menus.
- **Math**: `ctx.math.*` pure vec2/color helpers.

Determinism is free if you stay inside `ctx`: fixed timestep, seeded RNG, no
wall clock. Same seed, same machine → bit-identical replay (transcendental math
can differ by a ULP across CPUs — see
[docs/scripting.md](https://hearthengine.com/docs/scripting#determinism)).

## Iterating on scripts

```bash
hearth check-script scripts/coin-spin.lua                    # pre-flight syntax, no write
hearth check-script scripts/coin-spin.lua --source "$(cat draft.lua)"
hearth edit-script scripts/coin-spin.lua --source-file draft.lua
hearth script search "ctx.random" --regex
hearth script replace "old" "new" --dry-run                  # ALWAYS dry-run first
hearth script format --all
```

`edit-script` reformats on save (StyLua/Prettier house style) unless
`--no-format`. If the human has the editor open and playing, script edits
hot-reload live — but `ctx.events.on` subscriptions keep their old closure until
Stop/Play; prefer the `onEvent` hook for anything you iterate on during play.
See [docs/scripting.md](https://hearthengine.com/docs/scripting#hot-reload-during-play).

## Recipe: shared feel libraries

When two or more scripts need the same tuning, easing helper, procgen function,
or score formula, put it in `scripts/lib/` and require it at load time. Do this
before copy-pasting helpers between enemies.

```bash
hearth create script feel --dir lib
```

Lua library:

```lua
-- scripts/lib/feel.lua
local feel = {}

function feel.shakeForDamage(damage)
  return math.min(8, 2 + damage * 0.4)
end

return feel
```

Lua behavior:

```lua
local feel = require("lib/feel")
local script = {}

function script.onCollision(ctx, other)
  if not other.tags then return end
  ctx.camera.shake(feel.shakeForDamage(ctx.params.damage or 1), 0.16, { seed = 1 })
end

return script
```

JavaScript library:

```js
// scripts/lib/feel.js
function shakeForDamage(damage) {
  return Math.min(8, 2 + damage * 0.4);
}

module.exports = { shakeForDamage };
```

JavaScript behavior:

```js
const feel = require('lib/feel');

export default {
  onCollision(ctx, other) {
    if (!other.tags?.includes('bullet')) return;
    ctx.camera.shake(feel.shakeForDamage(ctx.params.damage ?? 1), 0.16, { seed: 1 });
  },
};
```

Rules: require only same-language modules, call `require` at the top of the
file, and keep state that must survive hot reload in `ctx.vars`. A module's
top-level locals reset when the library hot-reloads. Cycles are errors, so keep
libraries leaf-like: data/functions in `lib/`, gameplay lifecycle hooks in
attached behavior scripts.
