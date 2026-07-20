---
name: hearth-design
description: Shape a complete Hearth game, not just working mechanics — scoping to session length (the verbs × levels × enemies budget), the teach → develop → escalate → climax → end arc, real endings (a win state, not just game-over), one-element-at-a-time difficulty ramps, scenes-as-levels pacing with gated progress and ctx.save, replay hooks, and the complete-game checklist. Use when planning a new game, deciding scope, structuring levels and scenes, pacing difficulty, or judging whether a game is complete.
---

# The shape of a complete game

The sibling skills make a game work: structure is `hearth-build`, behavior is
`hearth-code`, art is `hearth-art`, moment-to-moment polish is `hearth-feel`.
This skill is the macro layer — how much game to build, in what order the
player meets it, and what lets them feel *finished* instead of abandoned. The
most common failure of an agent-built game is not a bug. It is a game that
**stops rather than ends**: one scene, one mechanic, a death loop, no win state.

Load this skill when planning, ideally before `hearth init`. Scope decisions
cost nothing at init and a rebuild once five scenes exist.

## Scope to session length

Pick a target session length first, then spend a budget:
**verbs × levels × enemies**. Every verb (a distinct player action) multiplies
work across the other skills — an input action (`hearth set-input`), animation
states, a juice stack, and playtests of its own. Levels and enemy types
multiply the same way.

| Target session | Verbs | Play scenes | Enemy/hazard types |
| --- | --- | --- | --- |
| ~5 minutes (arcade / jam scope) | 1–2 | 1–3, plus menu + ending | 2–3 |
| ~20 minutes (small complete game) | 2–3 | 4–6, plus menu + ending | 4–5, the last reserved for the finale |

**Depth over breadth — cut a mechanic before shipping two shallow ones.** A
verb earns its slot by being taught, developed, and present in the final
challenge. If it won't appear in the climax, cut it and deepen what remains
(more enemy interactions with the existing verb beats a second half-tuned verb).
The genre templates (`hearth init --template platformer|topdown|arcade`) start
at one or two verbs on purpose: get that verb green in a playtest and juiced
per `hearth-feel` before even considering another.

Scope is inspectable, so check it instead of estimating: `hearth inspect
project --json` lists every scene, and `hearth recall` holds the scope you
committed to. Record the budget at the start (`hearth remember "Scope: 2 verbs
(move+shoot), 4 levels, 3 enemy types" --section decision`) so later sessions
inherit the boundary instead of quietly growing it.

## Beginning, middle, end

A complete game runs **teach → develop → escalate → climax → end**:

1. **Teach** — first room, one verb, no pressure (the `hearth-feel` skill's onboarding rule).
2. **Develop** — variations and first combinations of what was taught.
3. **Escalate** — the same elements under real pressure.
4. **Climax** — a final challenge composed of everything taught. Nothing new.
5. **End** — a win state, shown, celebrated, and closed.

That arc needs bookends as real scenes:

- **A beginning.** A menu scene set as the initial scene, so the export boots
  into a title, not raw gameplay. The Start button's `onUiEvent` calls
  `ctx.scenes.load` (menus are scenes — the `hearth-feel` skill has the
  conventions, keyboard/gamepad focus included).
- **An ending.** A win state the player can reach, in its own scene. Game-over
  is not an ending; death loops back to a checkpoint. The ending is where the
  loop is allowed to close: show the result (time, score), play the biggest
  juice beat in the game, and offer Replay + Menu buttons.

```bash
hearth create scene "Menu"
hearth create scene "Victory"
hearth set-settings --initial-scene "Menu"
hearth inspect project --json     # the scene list should now read as the arc
```

The scene list is the arc made visible. `Menu, Level 1, Level 2, Level 3,
Victory` reads as a game; `Level 1` alone reads as a demo that stops. Advance
through it with a goal trigger per level:

```lua
-- goal.lua — attach to each level's exit trigger; params pick the destination.
-- hearth attach script "Level 1" Goal scripts/goal.lua --params '{"next":"Level 2"}'
local script = {}

function script.onCollision(ctx, other)
  if other.name ~= "Player" then return end
  ctx.camera.fade(1, 0.5, { color = "#000000", onComplete = function()
    ctx.scenes.load(ctx.params.next or "Victory")
  end })
end

return script
```

A player should be able to say why they are done: they saw the win screen, it
told them what they achieved, and it handed control back. If the answer is
"the game just kept going until they closed the tab", the end is missing.

## Ramp difficulty deliberately

The `hearth-feel` skill says "ramp, don't step" in one paragraph. This is the
actual curve to build:

- **One new element at a time.** Each scene (or room) introduces at most one
  new verb, enemy, or hazard. Two at once and the player can't tell which one
  killed them.
- **Safe first encounter.** The first instance of anything new appears where it
  can be watched before it can kill — behind a gap, telegraphed, or alone in an
  empty room.
- **Combine only after each is taught solo.** Spikes-plus-flying-enemy is a
  level-3 room only if spikes carried a room and the flyer carried a room
  first.
- **Spike, then breathe.** Intensity rises in waves, not a straight line: a
  hard room earns a quiet one after it. Flat pressure numbs; the breather is
  what makes the next spike land.
- **The climax composes, never introduces.** The final challenge is everything
  taught, together, at full pressure — and nothing the player hasn't seen. A
  new mechanic in the last room is an untaught test; players read it as unfair.

Make the ramp data, not copies of scripts. One shared script, tuned per scene
through `Script.params` (read as `ctx.params`), keeps the curve inspectable
and re-tunable in one place:

```bash
hearth attach script "Level 1" Spawner scripts/spawner.lua --params '{"rate":0.4,"speed":60,"max":3}'
hearth attach script "Level 3" Spawner scripts/spawner.lua --params '{"rate":1.2,"speed":110,"max":8}'
```

Drive spawn timing from seeded `ctx.random` so every level's pressure replays
identically, then prove the safe first encounter headlessly — a do-nothing
playtest that survives it:

```json
[
  { "type": "wait", "frames": 300 },
  { "type": "assertEntityExists", "entity": "Player" },
  { "type": "assertNoErrors" }
]
```

If the player dies in level 1 while providing no input, the first encounter is
not safe. Screenshot each level's opening room (`hearth screenshot "Level 2"
--frame 30`) and confirm the new element is visible and legible from the start
position.

## Pace content across scenes

Scenes are levels. Structure progress with them rather than one ever-longer
scene:

- **One idea per scene.** Each level exists to introduce, develop, or combine
  something. A level that teaches nothing new and doesn't escalate is filler —
  merge it into a neighbour or cut it. End a scene shortly after its idea
  peaks; don't pad past the point it was proven.
- **Gate progress.** The goal trigger checks its condition before loading the
  next scene — all coins collected, the key flag set in `ctx.vars`, the boss
  entity destroyed. An ungated exit makes every level optional and the ramp
  meaningless.
- **Save progress between sessions.** `ctx.vars` dies with the scene and
  in-scene state resets on `ctx.scenes.load`, so persistence goes through
  `ctx.save` at natural beats (level clear), and the menu reads it defensively:

```lua
-- On level clear (in goal.lua, before the fade):
ctx.save("unlocked", 3)

-- Menu's Continue button:
local unlocked = ctx.load("unlocked")
if type(unlocked) ~= "number" then unlocked = 1 end
ctx.scenes.load("Level " .. unlocked)
```

- **A breather scene earns its place in a 20-minute game** — after the biggest
  spike, before the climax: a quiet interlude, a shop, a scene with nothing
  trying to kill you. In a 5-minute game the menu *is* the breather; don't
  build interludes the session length can't afford.

## Replay hooks (and when to skip them)

Small games earn replays with small hooks, all a few lines on top of `ctx.save`:

- **Score / best time** — track the run, save the best, show both on the
  Victory screen ("Time 1:32 — Best 1:18"). Worth it in almost any
  arcade-shaped game; it converts "I finished" into "I can do better".

```lua
local best = ctx.load("best-time")
if type(best) ~= "number" or runTime < best then
  ctx.save("best-time", runTime)
  best = runTime
end
```

- **A hard mode toggle** — a `UIToggle` on the menu writes a flag via
  `ctx.save("mode.hard", true)`; spawner scripts read it and scale their
  params. Cheap because the ramp is already data (see above). Add it only
  after the base game clears the checklist below.
- **When not to bother.** No unlock trees, currencies, or meta-progression in
  a session-scoped game — they are content the budget doesn't cover, and they
  read as padding. And if the ending isn't built yet, any replay hook is
  procrastination: a finished 5-minute game beats an unfinished 20-minute one
  with an upgrade shop.

## The complete-game checklist

Run this gate before declaring a game done, alongside the `hearth-feel` quality
bar: that one judges whether the game feels good, this one judges whether it
*is a game*. Every item names its evidence — a command, a playtest, or a
screenshot, never a feeling.

**Start:**
- [ ] A menu scene exists and is the initial scene — `hearth inspect project --json` confirms both; `hearth screenshot Menu --frame 0` shows a title and a Start control, not gameplay.
- [ ] Start flows into play: a playtest clicks (or focus-activates) Start and lands `{ "type": "assertScene", "scene": "Level 1" }`.

**Middle:**
- [ ] The scene list reads as the arc (menu → levels → ending), and every scene is reachable — a walkthrough playtest chain covers each `assertScene` hop.
- [ ] Every verb and hazard gets a safe first encounter — the do-nothing playtest survives each level's opening; a screenshot of each opening room shows the new element legibly.

**End:**
- [ ] A win state exists and is reachable: a playtest drives to the final goal and asserts the ending scene loads. Game-over alone does not pass this item.
- [ ] The ending scene shows the result and offers Replay + Menu, keyboard/gamepad navigable (`assertFocus` covers it).

**Ramp:**
- [ ] Difficulty params rise across levels — compare `Script.params` per scene via `hearth inspect entity`, don't trust memory.
- [ ] The climax is composed entirely of taught elements; nothing debuts in the final challenge (scene inspection plus the level screenshots above).

**Retention:**
- [ ] Best score/time persists through `ctx.save`, is read defensively, and shows on the ending scene — assert the save/load round trip inside one playtest run (headless saves are scoped to the run; cross-session persistence is the browser export's localStorage).
- [ ] Replay hooks match the scope: present because they earn play, absent because they were judged, never absent by omission. Record the judgment (`hearth remember "No hard mode: 5-min scope" --section decision`).

When this gate and the `hearth-feel` bar both pass, summarize the diff
(`hearth diff --json`) and hand back a game, not a mechanic.
