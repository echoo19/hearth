# Working on "Crystal Warrens" (a Hearth project)

This directory is a **Hearth** game project. Hearth is an open-source,
agent-native 2D game engine: the entire editor/runtime is exposed through a
structured CLI (`hearth`) and an MCP server (`hearth-mcp`) so coding agents
can inspect, modify, test, and build this game through safe engine
operations instead of hand-editing JSON.

> **Coding-agent skills.** This project ships six focused skills under
> `.claude/skills/` that Claude Code discovers automatically. **Load the one
> whose domain you're working in — don't work from memory:**
> - `hearth` (**the operating core — load first**): the session loop, project
>   memory, permissions, validation, playtests, screenshots, and export.
> - `hearth-build` (**world structure**): scenes, entities, components,
>   tilemaps/autotiling, collider alignment, prefabs, state machines, input.
> - `hearth-code` (**behavior**): ctx scripting, Lua/JS hooks, modules,
>   determinism, script iteration.
> - `hearth-art` (**assets**): importing/slicing/animating, procedural
>   sprites and sounds, CC0 sourcing with licensing, pixel-art discipline.
> - `hearth-feel` (**polish**): juice recipes, game-UX conventions, and the
>   quality bar to clear before calling a game done.
> - `hearth-design` (**design**): scoping a game to its session length,
>   pacing and difficulty ramps, endings and replay hooks, and judging
>   completeness.
>
> (Canonical copies live at `skills/<name>/SKILL.md` in the Hearth engine
> repo.) This file is the per-project quick reference; the skills are the
> deeper playbooks.

## Start of session: recall, don't re-derive

The engine keeps two files so you don't relearn the project every session:

- `.hearth/digest.md` — an **engine-generated snapshot of current state**
  (scenes, entities + their components, scripts, assets), refreshed after every
  change. Read it instead of re-running `inspect` on everything; it is always
  current. Inspect one entity only when you need its full component data.
- `.hearth/memory.md` — **durable decisions, todos, and gotchas** you recorded
  in earlier sessions. Read it with `hearth recall` before re-deciding anything.

Record durable facts as you go with `hearth remember "<note>" --section
decision|todo|gotcha` so the next session (and the human) inherit them. Over
MCP, one `get_agent_instructions` call returns this guide plus the live digest
and memory together.

## Golden rules

1. **Do not guess the project structure.** Read `.hearth/digest.md` first; then
   `inspect` only what you still need in detail:
   - `hearth inspect project --json`
   - `hearth inspect scenes --json`
   - `hearth inspect scene <scene> --json`
   - `hearth inspect entity <scene> <entity> --json`
   - `hearth inspect components --json` (all component types + default values)
2. **Prefer structured commands over editing project JSON by hand.**
   The CLI validates every change against schemas. Direct edits to
   `hearth.json`, `scenes/*.scene.json`, or `assets.json` can corrupt the
   project (`hearth set-settings` updates build/loading settings, the
   initial scene, and input mappings safely). Scripts are **Lua by default**
   (`.js` also supported) and are normal code: edit `scripts/*.lua` /
   `scripts/*.js` freely (or via `hearth create script` / `hearth edit-script`).
3. **Snapshot before you change anything:** `hearth snapshot`.
   Then the human can review your work with `hearth diff` (or the editor's
   Diff panel), and `hearth revert --confirm` can undo it.
4. **Validate after changes:** `hearth validate --json`. Fix errors you introduced.
5. **Playtest your work:** `hearth playtest <name>` runs headless scripted
   tests; `hearth run <scene> --frames 120` smoke-runs a scene and reports
   script errors. Run reports include `audioEvents` (every audio play/stop
   with its frame and asset id), so you can verify sound behavior headlessly.
   **See your game over time:** `hearth capture <scene> --to 120` renders a
   contact sheet of frames (the moving-picture sibling of `screenshot`).
   **Measure feel:** add `assertPeak`/`assertRange`/`assertSettledBy` trace
   steps to a playtest to pin jump height, dash distance, or settle time.
   **Check the frame budget:** `hearth bench <scene>` reports per-frame ms
   (avg/median/p95) so you can confirm a scene holds 60fps before shipping.
6. **Do not delete assets or scenes unless explicitly asked.**
7. **Summarize your changes** when done: which scenes, entities, components,
   scripts, and assets you touched (`hearth diff --json` gives you the list).

## Typical workflow

```bash
hearth snapshot                        # checkpoint for diff/review
hearth inspect project --json          # learn the project
hearth inspect scene level_1 --json    # learn the scene
hearth create entity level_1 Coin --components '{"SpriteRenderer":{"shape":"circle","color":"#f1c40f"}}'
hearth set level_1 Coin Transform.position.x 200
hearth create sound pickup --preset coin       # deterministic WAV (presets: coin, jump, hit, laser, powerup, explosion, blip)
hearth create script coin-spin                 # Lua by default (--language js for JavaScript)
hearth attach script level_1 Coin scripts/coin-spin.lua
hearth validate --json                 # must pass
hearth run level_1 --frames 120 --json # no script errors
hearth diff                            # review what changed
hearth export web --zip                # playable static build, itch.io-ready (needs --allow build)
hearth export desktop --allow build    # native macOS/Windows/Linux app, zipped per platform
```

Ship: `export web` for a browser build (add `--zip` for itch.io); `export
desktop` wraps the same build in an Electron shell and zips one app per
platform (macOS is ad-hoc signed by default; `HEARTH_MAC_IDENTITY`/
`HEARTH_APPLE_ID`/`HEARTH_APPLE_PASSWORD`/`HEARTH_TEAM_ID` env vars sign
and notarize a real release). `buildSettings.icon` (a sprite asset id, set
via `hearth set-settings --build-settings '{"icon":"ast_x"}'`) becomes the
desktop app icon; leave it `null` for the bundled default.

## Project layout (do not restructure)

- `hearth.json`: project manifest (scenes list, input mappings, build settings)
- `scenes/*.scene.json`: scene files (entities + components)
- `assets.json`: asset index; `assets/`: asset files, including `assets/prefabs/*.prefab.json` (reusable entity-subtree templates)
- `scripts/*.lua` (and `*.js`): behavior scripts (Lua by default; `hearth inspect api --json` documents the ctx API)
- `playtests/*.playtest.json`: headless playtest definitions
- `.hearth/`: engine state (baseline snapshots, agent config); don't edit manually

## Prefabs

Reusable entity templates: `hearth prefab create <scene> <entity> <name>`
serializes an entity's full subtree into a prefab asset; `hearth prefab
place <prefab> <scene>` instantiates it as a fresh entity subtree;
`hearth prefab update <prefab> <scene> <entity>` pushes edits on a tracked
instance back onto the asset; `hearth prefab sync <prefab>` rebuilds every
tracked instance from the current payload, keeping each instance's id,
name, position, and enabled state, but **replacing its whole descendant
subtree** (any child you added by hand to one instance is lost on sync).
Scripts spawn prefabs at runtime with `ctx.scene.spawnPrefab(name, opts?)`
(returns `nil`/`null` if the name is unknown; destroying the returned
root does not cascade to its children).

## Scripting quick reference

Scripts are **Lua by default** (`hearth create script <name>`; add
`--language js` for JavaScript). A Lua script returns a table of lifecycle
hooks: `onStart(ctx)`, `onUpdate(ctx, dt)`, `onCollision(ctx, other)`, and
`onUiEvent(ctx, event)` (pointer/focus events on this entity's interactive
`UIElement`; `event.type` is
`click|press|release|enter|exit|drag|change|focus|blur`, with a
`value` field on `change` (the slider/toggle's new value):

```lua
local script = {}

function script.onStart(ctx)
end

function script.onUpdate(ctx, dt)
  ctx.transform.position.x = ctx.transform.position.x + 100 * dt
end

return script
```

**Call ctx with a dot, not a colon**: `ctx.log("hi")`, `ctx.scenes.load("Level")`,
never `ctx:log("hi")`. JS scripts `export default` an object with the same
hooks and receive the identical `ctx`.

The `ctx` stdlib covers this entity, the scene, input, timers, tweens, seeded
random, save/load, camera, effects, events, audio, UI focus, and math. For the
exact signatures — with a Lua and JS example per member — run
`hearth inspect api --json`. It is the canonical, always-current reference and
the source of the editor's autocomplete; read it when you script instead of
guessing (or re-loading it every session). The `hearth` skill has the grouped
overview.

Scene switching makes user-built menus/start screens (e.g. a Start button,
an interactive `UIElement`, whose script loads the level):

```lua
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "click" then
    ctx.scenes.load("Level")
  end
end

return script
```

Save data persists across scene switches (and across browser sessions in
exported games):

```lua
local best = ctx.load("bestScore") or 0
if score > best then
  ctx.save("bestScore", score)
end
```

`ctx.random` (and Lua's `math.random`) is seeded and deterministic: the
same seed produces the same sequence, so playtests are reproducible. Never
use wall-clock time or `Math.random` for gameplay.

Input actions are defined in `hearth.json` under `inputMappings.actions`
(`hearth inspect project --json` shows them; `hearth set-input <action> <keys...>` changes them).

Component notes: `UIElement` makes an entity screen-space UI (anchor +
offset, camera-independent; visuals come from Text/SpriteRenderer;
`interactive: true` enables onUiEvent). `Collider` polygons must be convex
with at least 3 points. Split concave shapes across multiple entities.
`AudioSource` with `autoplay: true` plays its asset on scene start.

## MCP

If you are connected via MCP instead of the CLI, the same operations are
exposed as tools (`get_project_info`, `inspect_scene`, `create_entity`,
`set_component_property`, `set_properties`, `check_script`,
`create_sound`, `create_music`, `run_playtest`, `get_diff`, `remember`,
`recall`, `screenshot`, `capture`, `bench_scene`, `export_web`,
`export_desktop`, ...). Call
`get_agent_instructions` first — it returns this document plus the current
digest and memory in one call. `screenshot` needs only read-only, so you can
always see your own work. (`hearth init --template` is pre-project, so it has
no MCP tool: it's a CLI-only step before a session exists.)

Generated by Hearth 1.0.0.
