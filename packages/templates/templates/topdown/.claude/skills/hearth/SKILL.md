---
name: hearth
description: Build, script, test, and ship 2D games in the Hearth engine as a coding agent — end-to-end workflows over the hearth CLI and MCP tools. Use whenever a project has a hearth.json, or the task mentions Hearth, ctx scripting, playtests, prefabs, tilemaps, or exporting a Hearth game.
---

# Building games in Hearth

Hearth is an agent-native 2D game engine. Every editor operation is a
**registered command**, reachable two ways with identical semantics:

- **CLI**: `hearth <command> --json` — best from a shell (Claude Code, Codex).
- **MCP**: `hearth-mcp --project <path>` over stdio — 72 command tools plus
  `screenshot` and `get_agent_instructions`. Tool names come from the MCP tool
  list, not a mechanical transform of the CLI verb — most are the snake_case of
  the command (`create_entity`, `set_component_property`, `run_playtest`), but
  some diverge (`get_project_info`), so read the list rather than guessing.

Both call the same core layer. Pick one; **never mix in hand-edits** of
`hearth.json`, `scenes/*.scene.json`, or `assets.json` — schemas are strict and
a bad edit corrupts the project. The one exception is `scripts/*.lua|*.js`:
those are normal code, edit freely (or via the script commands).

If a capability is not in `hearth commands`, it does not exist — ask the human
rather than improvising. Deep reference lives in `docs/*.md`; this skill is the
operational playbook.

## The loop every session runs

```
recall + digest → snapshot → change (commands) → validate → playtest → screenshot → remember + diff
```

1. **Recall first** — read `.hearth/digest.md` (the engine's current-state
   snapshot) and run `hearth recall` (past decisions/todos/gotchas). Trust the
   digest instead of re-inspecting the whole project; inspect one entity only
   when you need its full component data. This is how you avoid relearning the
   project — and burning tokens — every session.
2. **Snapshot** so the human can review and revert your whole session.
3. **Change through commands.** Don't assume a name/id/property the digest
   doesn't show — inspect that one thing.
4. **Validate** and fix every error you introduced.
5. **Playtest** — assert behavior headlessly; **screenshot** to *see* your work
   (read-only, no build permission needed).
6. **Remember + diff** — record durable decisions/gotchas with `hearth remember`
   so the next session inherits them, then summarize the diff.

**Building or polishing a game** (not just wiring a mechanic)? Load the
**`hearth-craft`** skill — animation, juice, game-feel, and the quality bar a
game must clear. A flat, static scene of placeholder rectangles is not "done";
animate it, give it feel, and screenshot to confirm it looks real.

```bash
alias hearth="node /path/to/hearth/packages/cli/dist/main.js"   # or the release hearth-cli.mjs
hearth snapshot
hearth inspect project --json
hearth inspect scene "Level 1" --json
# ...make changes...
hearth validate --json
hearth playtest --all --json
hearth diff --json
```

Connect Claude Code over MCP instead:

```bash
claude mcp add hearth -- node /path/to/hearth/packages/mcp-server/dist/main.js --project "$PWD"
```

Then call `get_agent_instructions` first — it returns the project's AGENTS.md
plus the active permission modes.

## Discover the surface first

Do not guess — read the machine-readable truth:

```bash
hearth commands --json               # the full registry (name, permission, mutates)
hearth inspect api --json            # every ctx member: signature, docs, Lua + JS example
hearth inspect components --json     # every component type with default values
hearth inspect project --json        # scenes, input mappings, build settings
hearth inspect scene "Level 1" --full --json   # entity hierarchy + all component data
hearth inspect entity "Level 1" Player --json
```

`hearth inspect api` is the canonical `ctx` reference and the source of the
editor's autocomplete — trust it over memory. See [docs/cli.md](https://hearthengine.com/docs/cli)
and [docs/agents.md](https://hearthengine.com/docs/agents).

## Permission modes

Sessions carry a grant; commands declare a requirement. Default grant is
`read-only,safe-edit,code-edit,asset-edit` — everything except `build`. Pass
`--allow build` (or `--allow all`) for export. **Screenshot is not gated** — it
is read-only observation, so you can always see your own work.

| Mode | Unlocks |
| --- | --- |
| `read-only` | inspect, validate, diff, run scenes/playtests, **screenshot**, recall memory |
| `safe-edit` | scene/entity/component CRUD, settings, snapshot/revert, playtest defs, remember |
| `code-edit` | create/edit/attach scripts |
| `asset-edit` | import + procedural asset creation, metadata |
| `build` | web/desktop export, portable builds |

## Start a project

`init` is pre-project (no MCP tool — it runs before a session exists). Prefer a
genre template over the blank default and build on it:

```bash
hearth init "My Game" --template platformer     # or: topdown | arcade
hearth init "My Game" --list-templates
hearth init "My Game" --width 960 --height 540
```

Each template is a small playable skeleton (one scene, a commented movement
script, a `smoke` playtest), not a demo to keep or delete. See
[docs/cli.md](https://hearthengine.com/docs/cli#project-templates).

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

Autotiling (blob47: a char's per-cell frame is chosen from its 8 neighbours at
render time). Paint terrain first, then bind the char to a sliced sheet:

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
with a blob47 `autotile` rule (the default), or a hand-authored neighbour-aware
tile choice (left-cap / middle / right-cap, top / mid / bottom). **Never** build
a surface from a single tile repeated with autotile OFF, and **never** from a
row/column of individual `SpriteRenderer` entities each holding one tile — both
read as disconnected mismatched blocks, each with its own outline, instead of
one cohesive object. If the source art is not already a blob47 layout, slice it
and pass `autotile set --mapping` a full 47-shape-key map (every resolved frame
must exist), or compose a blob47-arranged sheet. This is the difference between
"tiles that render" and "a surface that looks real."

## Never stretch pixel art — tile or slice it

A `SpriteRenderer` fills its `width`×`height` box one of three ways, set by
`renderMode` (default `stretch`):

- `stretch` — scales one texture to the box. **Only correct when the box keeps
  the texture's own aspect ratio at a whole-number scale** (e.g. an 18×18 tile
  at 18×18, 36×36, 54×54). Any other size *distorts* the art — a smear.
- `tile` — repeats the texture at its **native pixel size** to fill the box.
  This is how a wide platform/floor/wall built from one small tile should
  render: connected tiles, no smear. `hearth set "Level 1" Ground SpriteRenderer.renderMode tile`.
- `sliced` — 9-slice: `slice` insets (`{top,right,bottom,left}` px) keep the
  corners un-stretched while edges/center scale. For panels, bars, and
  platforms with distinct end-caps.

Firm rules for surfaces and pixel art:

1. **Never** make a wide/tall surface by stretching a single small tile in
   `stretch` mode. Use a `Tilemap` (best for grids/terrain, supports
   autotiling) or `renderMode: 'tile'`.
2. In `stretch` mode use **integer** scales only, and keep the box aspect equal
   to the texture's — otherwise texels go rectangular/blurry.
3. **Snap positions and sizes to the tile grid** so neighbouring tiles connect
   with no gaps, seams, or overlaps.
4. Pixel art stays crisp automatically: projects render with
   `buildSettings.pixelPerfect: true` (NEAREST filtering) by default. Leave it
   on for pixel art; a single non-pixel asset can opt out with its own
   `pixelArt: false`.

## Scripting: the ctx stdlib

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

### Script modules

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

What `ctx` gives you (read `hearth inspect api --json` for exact signatures):

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

### Iterating on scripts

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

## Assets: import, slice, animate, sound

```bash
hearth import asset ./art/walk-sheet.png --name walk-sheet --json
hearth import asset ./art/tileset/ --recursive --json          # atomic batch; check data.skipped
hearth create asset sprite hero --shape rectangle --color "#f4a460" --width 24 --height 24
hearth create asset slice walk-sheet --frame-size 16x16 --prefix walk --json
hearth create asset anim-from-sheet walk-cycle --sheet walk-sheet --frames walk_0,walk_1,walk_2,walk_3 --duration 0.12 --json
hearth create animation blink --frames sprite-a sprite-b --frame-duration 0.4    # multi-file flipbook
hearth create sound pickup --preset coin                       # presets: coin jump hit laser powerup explosion blip
```

Procedural sprites/sounds make a game playable and audible before real art
exists. Fonts: import a `.ttf/.otf/.woff` and reference it from `Text.fontFamily`
by the asset's **name** verbatim. Music is a separate channel — set
`AudioSource.music:true, autoplay:true` for a soundtrack that survives scene
switches. Full pipeline: [docs/assets.md](https://hearthengine.com/docs/assets).

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

Drive it from a script with `ctx.animator.setParam/getParam/fire/state`.
Triggers latch until consumed; params are bool/number/trigger. Full transition
semantics: [docs/scripting.md](https://hearthengine.com/docs/scripting#animation-state-machines).

## Input actions and axes

Scripts read named **actions**, not raw keys, so rebinding never breaks logic.

```bash
hearth set-input jump Space KeyW              # bind keys to an action
hearth set-input jump                         # (no keys) remove the action
hearth set-settings --input-axes '{"horizontal":{"gamepadAxis":0,"negativeCodes":["ArrowLeft"],"positiveCodes":["ArrowRight"]}}'
hearth set-settings --input-gamepad-buttons '{"jump":["a"]}'
hearth set-settings --input-deadzone 0.2
```

Read them with `ctx.input.isDown("jump")` / `ctx.input.axis("horizontal")`. See
[docs/input.md](https://hearthengine.com/docs/input).

## Playtest-driven verification

Playtests are deterministic (fixed timestep, scripted input, seeded RNG) and
headless — the way you prove "it works" before declaring done.

```bash
hearth run "Level 1" --frames 120 --json       # smoke-run: catches script/runtime crashes
hearth create playtest boot --scene "Level 1" --steps-file steps.json --seed 42 --json
hearth playtest boot --json
hearth playtest --all --json
hearth test                                    # CI: validate + run every playtest
```

Steps cover waits, key presses, pointer drags, and asserts (`assertScene`,
`assertAudioCount`, `assertParticleCount`, `assertCameraEffect`, `assertFocus`,
`assertNoErrors`, …). Run reports expose `audioEvents`, `sceneEvents`,
`cameraEffects`, and live particle counts.

**Never hand-compute frame counts.** Particle spawns and effect decay land on
whole fixed frames via floating-point accumulators — `rate: 10` at 60fps spawns
on frames 7,13,19,25,31, not 6,12,18,24,30. Derive expected numbers from a real
run (read the run report), then assert them. Details:
[docs/scripting.md](https://hearthengine.com/docs/scripting#determinism).

## Screenshot verification

See your own work — a deterministic PNG through headless Chromium. Read-only, no
build permission needed: this is your eyes, use it often.

```bash
hearth screenshot "Level 1"
hearth screenshot "Level 1" --frame 30 --size 800x600 --debug --out shots/level1.png
```

`--debug` overlays collider/velocity/light outlines. Read the PNG back to
confirm layout — never declare a scene done you haven't looked at. (MCP: the
`screenshot` tool; it writes the file, you read it.)

## Review loop: snapshot, journal, checkpoint

```bash
hearth snapshot                 # baseline for diff/revert (do this first)
hearth diff --json              # structural diff vs the baseline
hearth revert --confirm         # restore the whole session to the baseline
hearth undo                     # step back one recorded change
hearth redo
hearth history                  # the undo/redo stack
hearth log                      # disk-backed journal of every command any session ran
```

The human sees the same diff in the editor's Changes panel and can revert. An
unreviewable session is a failed session — always snapshot, always summarize the
diff when done. See [docs/agent-panel.md](https://hearthengine.com/docs/agent-panel).

## Memory: read state, don't re-derive it

Two engine-managed files stop you relearning the project (and burning tokens)
every session:

```bash
cat .hearth/digest.md              # engine-generated snapshot of CURRENT state,
                                   # refreshed after every change — read, don't re-inspect
hearth recall                      # durable decisions/todos/gotchas from past sessions
hearth remember "Chose Kenney tileset; palette is 8-color" --section decision
hearth remember "Coin flash >0.2s reads as a bug" --section gotcha
hearth remember "Still need a game-over scene" --section todo
```

The **digest** (`.hearth/digest.md`) is state the engine derives — scenes,
entities and their components, scripts, assets — always current, so trust it
over a fresh `inspect scene --full`. **Memory** (`.hearth/memory.md`, written via
`remember`) is intent the engine can't derive — why you did something, what's
left, what already failed. Record decisions and gotchas as you hit them; the next
session and the human inherit them. Over MCP, `get_agent_instructions` returns
this skill's guide plus the live digest and memory in one call.

## Export and ship

Export needs `--allow build`. No Hearth chrome ships in the game.

```bash
hearth export web --allow build                       # static folder, boots into the first scene
hearth export web --single-file --allow build         # one self-contained index.html
hearth export web --zip --allow build                 # + <slug>-web.zip, itch.io-ready
hearth export desktop --allow build                   # Electron app, zipped per platform (all four)
hearth export desktop --platform darwin-arm64 --platform win32-x64 --allow build
```

Desktop is ad-hoc signed on macOS by default; `HEARTH_MAC_IDENTITY` /
`HEARTH_APPLE_ID` / `HEARTH_APPLE_PASSWORD` / `HEARTH_TEAM_ID` env vars sign and
notarize a real release. `buildSettings.icon` (a sprite asset id, set via
`hearth set-settings --build-settings '{"icon":"ast_x"}'`) becomes the app icon.
See [docs/export.md](https://hearthengine.com/docs/export) and
[docs/shipping-to-itch.md](https://hearthengine.com/docs/shipping-to-itch).

## House best practices

- **Validate before declaring done.** `hearth validate --json` must pass, and a
  behavior you added must have a green playtest asserting it. "It runs" is not
  "it works."
- **Inspect, don't assume.** Read `inspect scene`/`inspect entity` before every
  edit; read `inspect api` / `inspect components` instead of guessing shapes.
- **Schema-validated commands only.** Never hand-edit project JSON — only
  `scripts/*` is free-form. Unknown component types are rejected.
- **Snapshot first, summarize last.** Every session is snapshot → work → diff.
- **Derive numbers from runs**, never arithmetic — playtest asserts come from a
  real run report.
- **Don't delete** scenes/assets unless asked; don't restructure the layout.
- **`--json` everywhere** when scripting — you get the full CommandResult
  envelope (`success`, `data`, `errors`, `warnings`, `changed`, `files`).

Health check: `hearth doctor`. When stuck on a capability, `hearth commands
--json` is the ground truth — if it is not there, it does not exist.
