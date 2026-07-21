# Game Feel Guide

How to make a Hearth game feel good, not just run: the juice stack, hand-rolled
hit-stop, easing as a feel vocabulary, the UX conventions players expect, and
the quality bar to clear before calling a game done. Everything here is plain
`ctx` scripting and components — no dedicated "juice system" exists or is
needed. This guide is the human-readable mirror of the `hearth-feel` agent
skill (`skills/hearth-feel/SKILL.md`, scaffolded into every project under
`.claude/skills/` — see [agents.md](./agents.md#project-embedded-instructions)),
so agents and humans work from the same playbook.

Order of operations matters: get the mechanic correct and green in a playtest
*first*, then layer juice on top. Juice on a broken mechanic just hides the
bug. And because every effect call is observable in headless run reports, "it
feels good" can rest on assertions rather than vibes — see
[Verifying feel](#verifying-feel-in-playtests) below.

## The juice stack

A meaningful moment — a hit, a pickup, a death, a level clear — should fire
**several cheap effects on the same frame**. One effect in isolation reads as
a glitch; a stack reads as impact. The canonical order for an impact:

1. **Hit-stop** — freeze the actors for a few frames so the brain registers
   the contact. The highest-impact piece of juice and the most commonly
   skipped one.
2. **Screen shake + hit-flash** — `ctx.camera.shake` for the world,
   `ctx.effects.flash` on the sprite that was struck.
3. **Particle burst** — debris or sparks from the contact point via
   `ctx.particles.burst`.
4. **Sound** — a layered SFX, same frame.
5. **Knockback / recovery** — a short eased tween out of the freeze.

The camera effects and their feel ranges (full API in
[scripting.md](./scripting.md#camera)):

| Call | Use for | Feel note |
| --- | --- | --- |
| `ctx.camera.shake(intensity, seconds, {seed})` | impacts, explosions, landings | Intensity ≤ ~8, time ≤ 0.25s — long shakes nauseate. Seed it for reproducible playtests. |
| `ctx.camera.flash(color, seconds)` | screen-wide hit, lightning | White at 0.05–0.1s. Louder than a sprite flash; reserve it. |
| `ctx.effects.flash(color, seconds)` | the specific sprite that got hit | The everyday hit-flash. Per-sprite and cheap ([scripting.md](./scripting.md#effects), [effects.md](./effects.md#hit-flash)). |
| `ctx.camera.zoomPunch(scale, seconds)` | dashes, crits, boss reveals | `scale` ~1.05–1.15 over ~0.2s. Above ~1.2 it reads as a bug. |
| `ctx.camera.fade(alpha, seconds, {color, onComplete})` | scene transitions, deaths | Fade out, `ctx.scenes.load` in `onComplete`, fade back in. Persists across scenes. |

Effects are **last-call-wins per kind**: a second `shake` in the same window
replaces the first rather than stacking, so pick the bigger one. For
persistent screen-space looks (vignette, color grade, CRT) use the data-driven
`Camera.postEffects` stack instead — that's [effects.md](./effects.md)'s
territory, not per-moment juice.

## Hit-stop by hand

Hearth has **no global time-scale**. The runtime advances every system on the
same fixed timestep so that a seeded run replays bit-for-bit
([scripting.md](./scripting.md#determinism)); a mutable world clock would put
that guarantee — and every timer, tween, and playtest built on it — at the
mercy of whoever last scaled it. So hit-stop is a gameplay convention your
scripts implement: gate each mover's own integration on a shared freeze flag,
and broadcast an event so other movers can freeze on the same frame.

```lua
-- hit-feedback.lua — the full impact stack, attached to the entity that takes the hit.
local script = {}

function script.onStart(ctx)
  ctx.vars.freeze = 0
end

function script.onCollision(ctx, other)
  if not other.tags then return end
  local isHit = false
  for _, t in ipairs(other.tags) do
    if t == "bullet" then isHit = true end
  end
  if not isHit then return end

  -- 1. hit-stop: freeze this actor for 4 fixed frames (~66ms at 60fps).
  ctx.vars.freeze = 4
  ctx.events.emit("hitstop", { frames = 4 })

  -- 2. shake + per-sprite flash (seeded shake replays identically).
  ctx.camera.shake(6, 0.18, { seed = 1 })
  ctx.effects.flash("#ffffff", 0.12)

  -- 3. particle burst from this entity's emitter.
  ctx.particles.burst(16)

  -- 4. layered sound, same frame.
  ctx.audio.play("hit", { volume = 0.9 })
  ctx.audio.play("hit-crunch", { volume = 0.5 })

  -- 5. knockback out of the freeze: a short eased shove.
  local dir = ctx.transform.position.x < other.transform.position.x and -1 or 1
  ctx.tweens.to("Transform.position.x", ctx.transform.position.x + dir * 24, 0.12, { easing = "easeOut" })
end

function script.onUpdate(ctx, dt)
  -- While frozen, skip normal movement integration. Decrement each frame.
  if ctx.vars.freeze and ctx.vars.freeze > 0 then
    ctx.vars.freeze = ctx.vars.freeze - 1
    local body = ctx.getComponent("PhysicsBody")
    if body then body.velocity.x = 0; body.velocity.y = 0 end
    return
  end
  -- ...normal movement here...
end

return script
```

Other movers freeze by listening for the `"hitstop"` event in `onEvent` and
running the same `ctx.vars.freeze` gate in their own `onUpdate`. The burst in
step 3 needs a `ParticleEmitter` on the entity, tuned as a sparks preset with
`emitting: false, rate: 0` so it fires **only** on `ctx.particles.burst` — see
[components.md](./components.md#particleemitter) for every field, and note
that spawn counts land on whole fixed frames via an accumulator, so derive
expected particle numbers from a real run report, never by hand
([scripting.md](./scripting.md#determinism)).

## Easing: the feel dictionary

`ctx.tweens.to(path, target, seconds, { easing })` tweens any numeric
component path ([scripting.md](./scripting.md#tweens)). The easing choice is
not cosmetic; players read it as physics:

- **`easeOut`** — anything that *arrives*: a pickup flying to the HUD, a menu
  sliding in, knockback settling. Fast start, gentle stop reads as "lands".
- **`easeIn`** — anything that *leaves* or *charges*: a projectile winding up,
  an object dropping away. Slow start, fast end reads as "commits".
- **`easeInOut`** — travel between two rest states: a patrolling platform, a
  camera easing to a new focus.
- **`linear`** — mechanical motion only: a conveyor, a health-bar drain, a
  timer. On character motion it feels dead.

Squash-and-stretch is two tweens and a timer:

```lua
-- On landing: quick squash, then eased recover.
ctx.tweens.to("Transform.scale.y", 0.8, 0.06, { easing = "easeOut" })
ctx.timers.after(0.06, function()
  ctx.tweens.to("Transform.scale.y", 1.0, 0.12, { easing = "easeOut" })
end)
```

## Layered sound

`hearth create sound <name> --preset <p>` bakes a deterministic WAV from one
of `coin jump hit laser powerup explosion blip`. A single preset is thin —
treat presets as ingredients and **layer two or three**, volume-staggered so
one leads:

```bash
hearth create sound hit --preset hit
hearth create sound hit-crunch --preset explosion    # low layer under the hit
hearth create sound pickup --preset coin
hearth create sound pickup-sparkle --preset blip     # bright top layer
```

Play them on the same frame: `ctx.audio.play("hit")` plus
`ctx.audio.play("hit-crunch", { volume = 0.5 })`. For repeated sounds,
regenerate a preset with a different `--seed` and alternate the siblings via
`ctx.random.int` so a machine-gun SFX doesn't grate. Music is a separate
channel that survives scene switches — `ctx.audio.playMusic("theme", { loop =
true, fadeIn = 1 })`, always faded, never hard-cut
([assets.md](./assets.md#music), [scripting.md](./scripting.md#audio)).

## Game UX conventions

### Menus, pause, and settings are scenes

Hearth has no built-in menu system, and shipped games boot straight into the
initial scene with no engine chrome. A menu is a scene of screen-space
`UIElement` entities; a button is `interactive: true` with an `onUiEvent`
handler ([scripting.md](./scripting.md#building-a-start-screen--menu),
[ui.md](./ui.md#hud-vs-menu-patterns)):

- **Title screen** — its own scene, set as the initial scene; Start's
  `onUiEvent` calls `ctx.scenes.load("Level 1")`.
- **Pause** — an overlay in the *same* scene, hidden until the `pause` action
  fires. There is no engine pause: "paused" means your scripts stop
  integrating, using the same shared freeze flag as hit-stop — gate every
  mover's `onUpdate` on it, then show the pause `UIElement` subtree.
- **Settings** — `UISlider` for volume, `UIToggle` for screen shake, wired to
  `ctx.audio.setMusicVolume` and to flags your effect code reads
  ([ui.md](./ui.md#uislider)). Persist them with `ctx.save`.

Bind actions rather than hard-coding keys (`hearth set-input pause Escape
KeyP` — [input.md](./input.md#actions)), and make every menu
keyboard/gamepad navigable with `ctx.ui.focus` / `moveFocus` / `activate` /
`adjust`, focusing the first control when the menu opens
([ui.md](./ui.md#focus-and-ctxui), [scripting.md](./scripting.md#ui-focus)).

### No input is silent

The non-negotiable rule: every button press, pickup, hit, and focus move gets
at least one of sound, flash, motion, or a text change on the same frame. A
button that doesn't visibly react reads as broken even when the click
registered. Hover and focus states count.

### Onboarding, difficulty, death

Teach by doing in the first room: one verb at a time, a safe space to try it,
a single `Text` prompt near the relevant object instead of a tutorial screen.
Ramp difficulty gradually and drive the curve from script params and seeded
`ctx.random` so it stays tunable and reproducible. Death returns the player to
a *recent* checkpoint, instantly and legibly — never the start of the game.
(Structuring the ramp and the ending across whole scenes is the
`hearth-design` skill's territory; this guide covers the moment-to-moment
craft.)

### Save etiquette

`ctx.save` / `ctx.load` / `ctx.clearSave` persist across scene switches, and
across sessions in the browser export
([scripting.md](./scripting.md#save-data)). Save progress and settings at
natural beats (level clear, settings change), never transient state and never
every frame. Read defensively — a fresh player has no save:

```lua
local best = ctx.load("best")
if type(best) ~= "number" then best = 0 end
```

## Verifying feel in playtests

Every effect call surfaces in headless run reports — `cameraEffects`,
`particleCounts`, `audioEvents` — so juice is assertable like any other
behavior:

```bash
hearth create playtest juice --scene "Arena" --steps-file steps.json --seed 7 --json
hearth playtest juice --json
```

```json
[
  { "type": "wait", "frames": 20 },
  { "type": "assertCameraEffect", "effect": "shake", "min": 1 },
  { "type": "assertParticleCount", "entity": "Enemy", "min": 1 },
  { "type": "assertAudioCount", "min": 1 },
  { "type": "assertNoErrors" }
]
```

Run once, read the report's actual counts, then tighten `min` to `equals`.
`assertFocus` covers menu navigation, and post-processing has its own
`assertPostEffect` step ([effects.md](./effects.md#playtests-assertposteffect)).

Feel asserts check the moments you scripted; a bot **sweep** complements them by
playing the scene across many seeds to surface the softlocks and crashes you
didn't script for — see [playtesting.md](./playtesting.md). The bots produce
evidence, not a verdict on feel; that judgment stays yours.

## The quality bar

Before calling a game done — whether you're a human or an agent — every box
below should be checkable with a command, playtest, or screenshot. "It runs"
is the floor, not the bar.

**Correctness:**
- [ ] `hearth validate --json` passes; `hearth test` (all playtests) is green.
- [ ] Every mechanic has a playtest asserting its *behavior*, not just no-crash.
- [ ] No `Math.random` / `Date.now` in game logic — determinism intact.

**Feel:**
- [ ] Every impact/pickup/death fires a juice stack (hit-stop + shake/flash + particles + layered sound), verified by an effect-asserting playtest.
- [ ] Motion uses intentional easing; nothing character-driven is `linear`.
- [ ] Screen shake is seeded, short (≤0.25s), and toggleable in settings.
- [ ] Sound is layered and seed-varied; music fades in and out, never hard-cuts.

**UX:**
- [ ] Title, pause, and settings exist and are keyboard/gamepad navigable.
- [ ] No input is silent — every interaction has same-frame feedback.
- [ ] The first room teaches one verb safely before it's tested.
- [ ] Difficulty ramps; death returns to a recent checkpoint.
- [ ] Settings and progress persist via `ctx.save`; loads read defensively.

The parallel checklist for whether the game is *complete* — a real beginning,
ending, and ramp across scenes — lives in the `hearth-design` skill. Component
schemas for everything used here are in [components.md](./components.md);
widget details in [ui.md](./ui.md); the full `ctx` reference in
[scripting.md](./scripting.md) or `hearth inspect api --json`.
