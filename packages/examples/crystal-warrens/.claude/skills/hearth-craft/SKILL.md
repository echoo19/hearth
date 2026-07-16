---
name: hearth-craft
description: Make a Hearth game feel GOOD, not just run — game-feel/juice recipes (hit-stop, screen shake, particle bursts, layered sound, tween easing, animation-state idioms), game-UX conventions (menus, onboarding, difficulty, feedback, save/load), an asset-sourcing playbook (Kenney, itch.io CC0, OpenGameArt, Freesound, Google Fonts), and the quality bar to clear before calling a game done. Use after the mechanics work when polishing feel, sourcing art/audio, or judging whether a game is shippable. Pairs with the `hearth` skill (which teaches operating the engine).
---

# Making a Hearth game good

The `hearth` skill teaches you to **operate** the engine — commands, `ctx`,
playtests, export. This skill teaches you to make the result **feel good**: the
difference between a scene that technically works and a game a person wants to
keep playing. Load both.

Everything here is real, runnable `ctx`/Lua and real CLI. Verify shapes against
`hearth inspect api --json` and `hearth inspect components --json` before you
build — signatures below are current but the machine truth wins.

**Golden order of operations.** Get the mechanic correct and green in a playtest
*first* (that is the `hearth` skill's job), then layer juice on top. Juice on a
broken mechanic just hides the bug. Every effect you add should be
playtest-observable (`assertCameraEffect`, `assertParticleCount`,
`assertAudioCount`) so "it feels good" rests on evidence, not vibes.

## Game feel: the juice stack

Every meaningful moment (a hit, a pickup, a jump, a death, a level clear) should
fire **several cheap effects at once**. One effect reads as a bug; a stack reads
as impact. The canonical impact stack, in the order they should land:

1. **Hit-stop** — freeze the actors for a few frames so the brain registers the
   hit. The single highest-impact, most-skipped piece of juice.
2. **Screen shake + hit-flash** — `ctx.camera.shake` for the world,
   `ctx.effects.flash` on the struck sprite.
3. **Particle burst** — debris/sparks from the contact point.
4. **Sound** — a layered SFX on the same frame.
5. **Knockback / recovery** — a short eased tween out of the freeze.

### Recipe: full impact stack (Lua)

Deterministic, no wall clock, no `Math.random`. Attach to the entity that takes
the hit. `ctx.effects.flash` auto-adds a `SpriteEffects` component; the emitter
must already exist for `ctx.particles.burst` (see below).

```lua
-- hit-feedback.lua — the full impact stack on collision.
-- Hit-stop is done by hand: Hearth has a fixed timestep and no global
-- time-scale, so we gate this entity's own movement for a few frames with a
-- counter in ctx.vars, and broadcast a "hitstop" event so other movers can
-- freeze too (they check ctx.vars.freeze the same way).
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

  -- 2. shake + per-sprite flash. Pass a seed so the shake is reproducible.
  ctx.camera.shake(6, 0.18, { seed = 1 })
  ctx.effects.flash("#ffffff", 0.12)

  -- 3. particle burst from the emitter on this entity.
  ctx.particles.burst(16)

  -- 4. layered sound (see "Layered sound" — play two presets together).
  ctx.audio.play("hit", { volume = 0.9 })
  ctx.audio.play("hit-crunch", { volume = 0.5 })

  -- 5. knockback out of the freeze: a short eased shove.
  local dir = ctx.transform.position.x < other.transform.position.x and -1 or 1
  ctx.tweens.to("Transform.position.x", ctx.transform.position.x + dir * 24, 0.12, { easing = "easeOut" })
end

function script.onUpdate(ctx, dt)
  -- While frozen, skip the normal movement integration. Decrement each frame.
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

Give the entity the emitter the burst draws from — tuned as a *sparks* preset
(fast, short-lived, cone away from the surface):

```bash
hearth add component "Arena" Enemy ParticleEmitter --properties '{"emitting":false,"rate":0,"lifetime":0.4,"speed":180,"spread":55,"direction":270,"startColor":"#ffe08a","endColor":"#e25822","startSize":5,"endSize":0,"gravity":{"x":0,"y":400},"seed":1}'
```

`emitting:false, rate:0` means it emits **only** on `ctx.particles.burst(n)` —
no idle stream. `direction` is degrees (0=+x, 90=+y/down); `gravity` pulls the
sparks back down for weight. Never hand-count particle spawns — read the count
back from a run (see Verify).

### Camera effects: which, and when

| Call | Use for | Feel note |
| --- | --- | --- |
| `ctx.camera.shake(intensity, seconds, {seed})` | impacts, explosions, landings | Keep intensity ≤ ~8 and time ≤ 0.25 — long shakes nauseate. Always seed it. |
| `ctx.camera.flash(color, seconds)` | screen-wide hit, lightning, camera-flash pickup | White at 0.05–0.1s. A full-screen flash is louder than a sprite flash — reserve it. |
| `ctx.effects.flash(color, seconds)` | the specific sprite that got hit | The everyday hit-flash; per-sprite, cheap, use liberally. |
| `ctx.camera.zoomPunch(scale, seconds)` | dashes, crits, boss reveals | `scale` ~1.05–1.15, `seconds` ~0.2. Subtle. Over ~1.2 it reads as a bug. |
| `ctx.camera.fade(alpha, seconds, {color, onComplete})` | scene transitions, deaths | Fade out → `load` in `onComplete` → fade back in. Persists across scenes. |

Effects are **last-call-wins per kind** — calling `shake` twice in a frame keeps
the last one, so you cannot stack two shakes; pick the bigger.

### Tween easing: the feel dictionary

`ctx.tweens.to(path, target, seconds, { easing })` on any numeric component
path. Easing choices are not cosmetic — they read as physics:

- **`easeOut`** — the default for anything that *arrives*: a pickup flying to the
  HUD, a menu sliding in, knockback settling. Fast start, gentle stop = "lands".
- **`easeIn`** — anything that *leaves* or *charges*: a projectile winding up, an
  object dropping away. Slow start, fast end = "commits".
- **`easeInOut`** — travel between two rest states: a platform patrolling, a
  camera easing to a new focus. Smooth both ends.
- **`linear`** — mechanical/constant only: a conveyor, a health-bar drain, a
  timer. On character motion it feels dead.

Squash-and-stretch a jump/land by tweening scale (author a `scale` on Transform
via `hearth inspect components` for the exact path):

```lua
-- On landing: quick squash then eased recover.
ctx.tweens.to("Transform.scale.y", 0.8, 0.06, { easing = "easeOut" })
ctx.timers.after(0.06, function()
  ctx.tweens.to("Transform.scale.y", 1.0, 0.12, { easing = "easeOut" })
end)
```

### Layered sound: presets are ingredients, not finishes

`hearth create sound <name> --preset <p>` bakes a deterministic WAV. Presets:
`coin jump hit laser powerup explosion blip`. A single preset is thin — **layer
two or three** for a real effect, and vary volume so one leads:

```bash
hearth create sound hit --preset hit
hearth create sound hit-crunch --preset explosion   # low layer under the hit
hearth create sound pickup --preset coin
hearth create sound pickup-sparkle --preset blip     # bright top layer
```

Then play them on the same frame (`ctx.audio.play("hit")` +
`ctx.audio.play("hit-crunch", { volume = 0.5 })`). Pitch/timbre variety across
repeated sounds keeps a machine-gun SFX from grating — regenerate a preset with a
different `--seed` for a sibling variant and alternate them via `ctx.random.int`.
For real recorded audio, source from Freesound (see the sourcing playbook).

Music is a separate channel that survives scene switches:
`ctx.audio.playMusic("theme", { loop = true, fadeIn = 1 })` and
`ctx.audio.stopMusic({ fadeOut = 1.5 })` — always fade, never hard-cut.

### Animation-state idioms: anticipation and recovery

Raw state machines (`.asm.json`, driven by `ctx.animator.setParam/fire/state`)
feel robotic when they cut straight idle↔action. Add the two frames players read
as intent:

- **Anticipation** — a brief wind-up *state before* the action (crouch before
  jump, pull-back before swing). Gate the action's start on it.
- **Recovery** — a settle *state after* (landing squash, follow-through) before
  returning to idle. This is where hit-stop and squash tweens live.

Model these as real states with short clips: `idle → anticipate → attack →
recover → idle`, transitions on triggers (`ctx.animator.fire`) and a timer for
the auto-advance out of `anticipate`/`recover`. Triggers latch until consumed, so
fire once and let the transition drain it. Build the machine with the `hearth`
skill's `create asset state-machine` recipe.

## Game UX: conventions players expect

### Menus, pause, settings are just scenes

There is no built-in menu system — and you don't need one. A menu is a scene of
screen-space `UIElement` entities; a button is an `interactive: true` `UIElement`
whose `onUiEvent` does the thing. This is a feature: menus are fully yours.

- **Title/start screen** — its own scene; the Start button's `onUiEvent` calls
  `ctx.scenes.load("Level 1")`. Set it as `initialScene` so the export boots
  into it (no engine chrome ever ships).
- **Pause** — an overlay built in the *same* scene, hidden until `pause` is
  pressed. Because Hearth has no engine pause, "paused" means your scripts stop
  integrating: gate every mover's `onUpdate` on a shared `ctx.vars`/event flag
  (the same freeze trick as hit-stop), and show the pause `UIElement` subtree.
- **Settings** — `UISlider` (volume), `UIToggle` (screen shake, etc.), wired to
  `ctx.audio.setMusicVolume` and to flags your effect code reads. Persist them
  with `ctx.save` so they stick across sessions.

Bind the action first so logic never hard-codes a key:

```bash
hearth set-input pause Escape KeyP
```

Every menu must be **keyboard/gamepad navigable**, not mouse-only: use
`ctx.ui.focus`, `ctx.ui.moveFocus`, `ctx.ui.activate`, `ctx.ui.adjust` so a pad
can drive it. Focus the first control when the menu opens.

### Feedback on every interaction

The non-negotiable UX rule: **no input is silent.** Every button press, pickup,
hit, and menu move gets at least one of sound / flash / motion / text change on
the same frame. A button the player clicks must visibly react (color shift, a
`blip`, a tiny scale tween) or the game feels broken even when it isn't. Hover
and focus states count too.

### Onboarding and difficulty

- **Teach by doing, in the first room.** Introduce one verb at a time with a safe
  space to try it before it matters. No wall of text — a single `Text` prompt
  near the relevant object beats a tutorial screen.
- **Ramp difficulty, don't step it.** Early encounters should be survivable while
  learning; escalate spawn rate / enemy speed / hazard density gradually. Drive
  the curve from script params or seeded `ctx.random` so it's tunable and
  reproducible in a playtest.
- **Fail forward.** Death sends the player back to a *recent* checkpoint, not the
  start. Respawn should be instant and legible.

### Save/load etiquette

`ctx.save(key, value)` / `ctx.load(key)` / `ctx.clearSave(key?)` persist across
scene switches and, in the browser export, across sessions (localStorage).

- Save **progress and settings**, not transient state (no mid-frame velocities).
- Read defensively — a fresh player has no save: `local best = ctx.load("best");
  if type(best) ~= "number" then best = 0 end`.
- Save at natural beats (level clear, settings change), not every frame.
- Namespace keys (`"best"`, `"settings.shake"`) and never assume a key exists.

## Asset sourcing playbook

You can source real 2D art, audio, and fonts autonomously. **Licensing is not
optional** — a mis-licensed asset is a shipping blocker, not a detail.

### Where to look (verified July 2026)

| Source | URL | License | Attribution | Notes |
| --- | --- | --- | --- | --- |
| **Kenney** | https://kenney.nl/assets | CC0 (public domain) | Not required (credit "Kenney" if you like) | The default first stop. Cohesive 2D sprite/tile/UI/audio packs, all CC0. |
| **itch.io CC0** | https://itch.io/game-assets/assets-cc0 | CC0 v1.0 | Not required | 2,600+ packs; filter by tag (Sprites, Tileset, Pixel Art). Use the `/free` and CC0 filter — do **not** assume a random itch asset is CC0. |
| **OpenGameArt** | https://opengameart.org | **Varies**: CC0, OGA-BY, CC-BY, CC-BY-SA, GPL, WTFPL | Depends on the license | Per-submission license — **read each asset's license box**. Filter search by license; prefer CC0/CC-BY. |
| **Freesound** | https://freesound.org | **Varies**: CC0, CC-BY, CC-BY-NC | Depends; NC blocks commercial | Login required to download. Filter to "Free Cultural Works" (CC0 + CC-BY). Avoid CC-BY-NC unless the game is truly non-commercial. |
| **Google Fonts** | https://fonts.google.com | ~99% OFL, ~1% Apache-2.0 | Not required | Free commercial, embeddable/bundlable in a game. Keep the `OFL.txt` next to the font file. |

### Licensing rules (follow every time)

1. **Prefer CC0.** No attribution, no strings, safe to modify and ship. Kenney and
   the itch.io CC0 filter are the fastest CC0 firehoses.
2. **CC-BY / OGA-BY / OFL → attribution required.** Keep a `CREDITS.md` in the
   project listing asset, author, source URL, and license for each. Add it as you
   import, not at the end.
3. **Never use CC-BY-NC / CC-BY-SA / GPL** in anything that might ship
   commercially without confirming with the human — NC bans commercial use, SA/GPL
   force your whole project's license. When unsure, ask.
4. **Never rip unlicensed assets** — no scraping game rips, stock sites, or
   "found on Google Images". If you can't name the license, don't use the asset.
5. **Record the provenance at import time.** URL + license in `CREDITS.md` for
   every non-CC0 asset (and it's polite for CC0 too).

### The fetch → import → verify loop

Download, import through the pipeline (never drop files into `assets/` by hand),
then *look at it* with a screenshot before trusting it.

```bash
# 1. Fetch (plain shell — curl/wget; respect the site's terms).
curl -L -o downloads/kenney-platformer.zip https://kenney.nl/media/pages/assets/.../platformer-pack.zip
unzip downloads/kenney-platformer.zip -d downloads/kenney-platformer

# 2. Import through Hearth (schema-validated; batch import is atomic).
hearth import asset ./downloads/kenney-platformer/PNG/Tiles/ --recursive --json   # check data.skipped
hearth import asset ./downloads/hero.png --name hero --json

# 3. Slice a sheet into named frames, then build a clip.
hearth create asset slice hero --frame-size 16x16 --prefix hero --json
hearth create asset anim-from-sheet hero-walk --sheet hero --frames hero_0,hero_1,hero_2,hero_3 --duration 0.12 --json

# 4. Fonts: import the .ttf/.otf, reference by the asset NAME from Text.fontFamily.
hearth import asset ./downloads/PressStart2P.ttf --name press-start-2p --json

# 5. VERIFY — put it in a scene and screenshot it back. Don't trust unseen art.
hearth screenshot "Level 1" --frame 10 --out shots/art-check.png --allow build
```

Read the PNG back and confirm the art is the size, palette, and alignment you
expected — imported sheets often need a different `--frame-size`, and a
transparent-background PNG can hide misalignment until you look.

### Pixel-art sizing and palette discipline

- **Pick one tile size and hold it.** 16×16 or 32×32 for tiles; keep every
  sprite on the same grid. Mixing 16px and 24px art reads as amateur. Match your
  `Tilemap.tileSize` to the source.
- **Integer scale only.** Display pixel art at 1×, 2×, 3× — never 1.5×, or it
  smears. Size sprites/build resolution so scaling stays integer.
- **Constrain the palette.** A cohesive game uses a limited, shared palette
  (Kenney packs and most CC0 pixel packs already are). Don't mix a 40-color
  painterly sprite with an 8-color pixel tileset. When generating procedural
  placeholders, pull from the same handful of hexes as the imported art.
- **Placeholders are fine, mismatched art is not.** Procedural
  `hearth create asset sprite` shapes (rectangle/circle/character/coin/star/…)
  keep the game playable before real art lands — swap them for imported art of
  the *same size and palette family* later.

## Verify the feel (not just that it runs)

Prove each effect fired, deterministically and headlessly. Derive expected
numbers from a real run — never hand-compute frame-based counts.

```bash
hearth create playtest juice --scene "Arena" --steps-file steps.json --seed 7 --json
hearth playtest juice --json
```

Assert the juice with the effect-aware steps (`steps.json`):

```json
[
  { "type": "wait", "frames": 20 },
  { "type": "assertCameraEffect", "effect": "shake", "min": 1 },
  { "type": "assertParticleCount", "entity": "Enemy", "min": 1 },
  { "type": "assertAudioCount", "min": 1 },
  { "type": "assertNoErrors" }
]
```

Run reports expose `cameraEffects`, `particleCounts`, and `audioEvents` — read
them back to pick exact expected values, then tighten `min` to `equals`.

## The quality bar (run this before calling a game "done")

An agent should not declare a game finished until every box is checked. "It runs"
is the floor, not the bar.

**Correctness (from the `hearth` skill):**
- [ ] `hearth validate --json` passes; `hearth test` (all playtests) is green.
- [ ] Every mechanic has a playtest asserting its *behavior*, not just no-crash.
- [ ] No `Math.random`/`Date.now` in game logic — determinism intact.

**Feel:**
- [ ] Every impact/pickup/death fires a juice stack (hit-stop + shake/flash +
      particles + layered sound), verified by an effect-asserting playtest.
- [ ] Motion uses intentional easing, not linear, on anything character-driven.
- [ ] Screen shake is seeded, short (≤0.25s), and toggleable in settings.
- [ ] Sound is layered and pitch-varied; music fades in/out, never hard-cuts.

**UX:**
- [ ] Title, pause, and settings scenes exist and are keyboard/gamepad navigable.
- [ ] **No input is silent** — every interaction has visible/audible feedback.
- [ ] First room teaches one verb safely before it's tested.
- [ ] Difficulty ramps; death returns to a recent checkpoint.
- [ ] Settings and progress persist via `ctx.save`; loads read defensively.

**Assets:**
- [ ] Every non-CC0 asset is credited in `CREDITS.md` (asset, author, URL,
      license); no CC-BY-NC/SA/GPL sneaking into a shippable build.
- [ ] One tile size, one palette family, integer scaling — screenshot-verified.
- [ ] Real or cohesive procedural art everywhere (no orphan default rectangles).

**Ship (from the `hearth` skill):**
- [ ] `hearth export web --zip --allow build` produces a booting build; the
      screenshot at frame 0 shows the title scene, not a blank canvas.

When every box is checked, summarize the diff (`hearth diff --json`) and hand
back. An unreviewable, unpolished session is a failed session.
