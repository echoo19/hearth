# Agent Workflow Guide

How coding agents (Claude Code, Codex, or any MCP client) should work on
Hearth game projects. Humans: this is also the best explanation of *why*
Hearth is shaped the way it is.

## The philosophy

Hearth doesn't put an AI in the engine. Instead it makes the engine
**legible and controllable from outside**: every editor operation is a
structured, schema-validated, permission-checked command available over CLI
and MCP. Agents get real operations instead of guessing at file formats;
humans stay in charge through the visual editor, permissions, playtests, and
reviewable diffs.

## Two transports, one engine

- **CLI**: `hearth <command> --json` (see [cli.md](./cli.md)). Best when the
  agent already lives in a shell (Claude Code, Codex CLI).
- **MCP**: `hearth-mcp --project <path>` over stdio (see
  [mcp.md](./mcp.md)). Best for MCP-native clients; 70 command tools
  (plus `screenshot` and `get_agent_instructions`) wrapping the same core
  commands.

Both call the identical core command layer. Pick either; never mix in
hand-edits of `hearth.json`/`*.scene.json`/`assets.json`.

## The loop every agent should run

```
snapshot  →  inspect  →  change (commands)  →  validate  →  playtest  →  diff
```

1. **Snapshot** (`hearth snapshot` / `snapshot_project`) so the human can
   diff and revert your entire session.
2. **Inspect before editing**: `inspect project`, `inspect scene`,
   `inspect components`. Do not assume entity names, ids, or component
   properties; read them.
3. **Change through commands.** Create entities with components inline;
   set properties by dot path (`Transform.position.x`); create procedural
   placeholder sprites so the game is playable before art exists.
4. **Validate** (`hearth validate --json`) and fix every error you
   introduced. Warnings are advisory but read them.
5. **Playtest**: `hearth run <scene> --frames 120` catches script crashes;
   `hearth playtest --all` runs scripted assertions. Create playtests for
   behavior you add (`create playtest`): steps cover waits, key presses,
   pointer clicks, and assertions (including `assertScene`), and they're
   deterministic (fixed timestep, scripted input, seeded RNG, and a playtest
   can set its own `seed`), so they're trustworthy. Run reports include
   `audioEvents` (every play/stop with frame and asset id), `sceneEvents`,
   and `finalScene`, so sound and scene switching are checkable headlessly
   too.
6. **Diff** (`hearth diff --json`) and summarize the changes for the human:
   scenes/entities/components/scripts/assets touched. The human sees the
   same diff in the editor's Changes panel (opened via the toolbar's
   Review button) and can revert.

**Scripting iteration**: `check_script`/`check-script` before
`edit_script`/`edit-script` as a pre-flight. It catches syntax errors
without writing anything. `edit_script` formats automatically (StyLua/
Prettier house style) unless you pass `format: false` or the project has
`codeStyle.formatOnSave` off, so you don't need a separate format step.
If the human has the editor open and playing while you work, your script
edits hot-reload into the running game and your property writes
(`set_component_property`/`set_properties`) apply live. No need to ask
them to Stop/Play for most changes; see
[scripting.md](./scripting.md#hot-reload-during-play) and
[editor.md](./editor.md#live-iteration-during-play) for exactly what
does and doesn't carry over. For cross-file work, `search_scripts` finds
matches read-only; `replace_in_scripts` always takes a `dryRun: true`
pass first to preview per-file counts before writing for real. See
[cli.md](./cli.md#the-script-group).

## Permission modes

Sessions carry a grant; commands declare a requirement. Defaults allow
everything except `build`.

| Mode | Unlocks |
| --- | --- |
| `read-only` | inspect, validate, diff, run scenes/playtests, `screenshot`, `recallNotes` (always implied) |
| `safe-edit` | scene/entity/component CRUD, project settings (`updateSettings`: buildSettings incl. loading visuals, initial scene, input mappings), snapshot/revert, playtest defs, `rememberNote` |
| `code-edit` | create/edit/attach scripts (Lua by default, `--language js` for JavaScript) |
| `asset-edit` | import + procedural asset creation (sprites, tiles, sounds), metadata |
| `build` | web export (`exportWeb`) + native desktop export (`exportDesktop`) + portable project builds (`buildProject`) |

`screenshot` is read-only observation — the visual sibling of inspect/playtest —
so an agent can always see its own work without a build grant. State and memory:
the engine regenerates `.hearth/digest.md` (a current-state snapshot) after every
change, and `rememberNote`/`recallNotes` persist durable decisions/todos/gotchas
in `.hearth/memory.md` across sessions. Read both at the start of a session
instead of re-inspecting and re-deciding.

A human can run an agent read-only to get analysis with a guarantee of no
mutation, or grant `safe-edit` only to keep the agent out of code.

## What agents must not do

- Don't hand-edit project JSON. Schemas are strict, commands exist for
  everything, and unknown component types are rejected.
- Don't delete scenes/assets unless explicitly asked (asset removal refuses
  while references exist; file deletion is opt-in).
- Don't restructure the project layout.
- Don't leave validation failing.
- Don't skip the snapshot; an unreviewable session is a failed session.

## Project-embedded instructions

`hearth init` generates **AGENTS.md** (full instructions: golden rules, a
Lua-first scripting quick reference, and a `ctx` API reference rendered from
the same `CTX_API` table that powers `hearth inspect api`), **CLAUDE.md**
(pointer), and `.hearth/agent-config.json` (machine-readable: binary names,
recommended first commands, permission defaults) in every project. The MCP
server serves the same content via the `get_agent_instructions` tool, so an
agent that connects cold can bootstrap itself.

Beyond the per-project files, Hearth ships **five focused coding-agent skills**
(Claude Code skill format), scaffolded into every project under
`.claude/skills/` and backfilled into older projects when an agent launch is
prepared. The split means an agent loads only the domain it's working in
instead of one monolithic document — smaller context, sharper activation:

- **`skills/hearth/SKILL.md`** (*the operating core — loaded first*): the
  session loop (recall → snapshot → change → validate → playtest → screenshot →
  remember), project memory and the state digest, permission modes,
  playtest/screenshot verification, the review loop, and export. Routes to the
  four domain skills.
- **`skills/hearth-build/SKILL.md`** (*world structure*): scenes, entities,
  components, tilemaps and autotiling (surfaces must connect), collider/sprite
  feet alignment, prefabs, animation state machines, and input bindings.
- **`skills/hearth-code/SKILL.md`** (*behavior*): the `ctx` stdlib, Lua/JS
  lifecycle hooks, script modules, the dot-call and userdata pitfalls,
  deterministic RNG, and the check-script/edit-script iteration loop.
- **`skills/hearth-art/SKILL.md`** (*assets*): importing and slicing
  spritesheets, animations, procedural sprites and sounds, the asset-sourcing
  playbook (Kenney, itch.io CC0, OpenGameArt, Freesound, Google Fonts, with
  licensing rules and the fetch → read-the-art → import → screenshot-verify
  loop), and pixel-art discipline.
- **`skills/hearth-feel/SKILL.md`** (*polish*): game-feel recipes (hit-stop,
  screen shake/flash/zoomPunch, particle bursts, layered sound, tween easing,
  anticipation/recovery), game-UX conventions, effect-asserting playtests, and
  the quality-bar checklist an agent runs before calling a game done.

The generated AGENTS.md and `get_agent_instructions` carry the same routing
map, so an agent that connects cold knows which skill to load for which work.

## Starting a new project: templates

`init` is pre-project: there's no MCP tool for it, since a session needs an
existing `hearth.json` to connect to. An agent working from the CLI picks a
starting point with `hearth init <name> --template <t>` instead of the
blank default: `platformer` (gravity + jump), `topdown` (four-direction
movement + camera follow), or `arcade` (fixed camera, shoot-on-key). Each is
a small, playable skeleton (one scene, a commented movement script, a
`smoke` playtest), not a demo to keep or delete. Pick whichever genre is
closest to the ask and build on it, the same way you'd build on a blank
project. See [cli.md](./cli.md#project-templates) for the full flag
reference; the editor's Launcher offers the same choice as cards for a
human starting a project by hand.

## Recipes

Four common workflows, worked end to end on
the CLI. Every command has an MCP equivalent (see [mcp.md](./mcp.md#tool-naming)).

### Build an animation state machine from scratch

```bash
# 1. Two little animations to drive (idle: 2 frames, walk: 2 frames)
hearth create asset sprite hero-idle-a --shape rectangle --color "#f4a460" --width 24 --height 24 --json
hearth create asset sprite hero-idle-b --shape rectangle --color "#f4a460" --width 24 --height 26 --json
hearth create animation hero-idle --frames hero-idle-a hero-idle-b --frame-duration 0.4

hearth create asset sprite hero-walk-a --shape rectangle --color "#f4a460" --width 22 --height 24 --json
hearth create asset sprite hero-walk-b --shape rectangle --color "#f4a460" --width 26 --height 22 --json
hearth create animation hero-walk --frames hero-walk-a hero-walk-b --frame-duration 0.1

# 2. The state machine document: a bool "moving" param toggles idle <-> walk
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
# -> { "success": true, "command": "createStateMachineAsset",
#      "data": { "assetId": "ast_h0er0m0t", "path": "assets/statemachines/hero-motion.asm.json" }, … }

# 3. Attach it to the entity (assetId from step 2's output; state.animation
#    above could have been ids or names — getAsset resolves either)
hearth add component "Level 1" Hero AnimationStateMachine --properties '{"assetId":"ast_h0er0m0t"}'
```

Drive it from a script with `ctx.animator`. See
[scripting.md](./scripting.md#animation-state-machines) for the full API,
param types, and trigger consume/latch semantics:

```lua
ctx.animator.setParam(ctx.entity.name, "moving", math.abs(vx) > 1)
```

Editing the graph later: `hearth set-state-machine ast_h0er0m0t --data '<full document>'`
replaces it wholesale (same asset id/path), or use the editor's
[Animator editor](./editor.md#animator-editor) for a typed params/states/
transitions UI instead of hand-writing JSON.

### Autotile a map

```bash
# 1. Import + slice a blob47 tileset (frames slice as ground_0, ground_1, …
#    in row-major order — sliceSpritesheet can't name frames by shape key
#    directly, so a --mapping translates slice order to shape keys below)
hearth import asset ./art/ground-blob47.png --name ground-sheet --json
hearth create asset slice ground-sheet --frame-size 16x16 --prefix ground --json

# 2. Paint some "G" cells first — autotile shades existing terrain, it
#    doesn't place it
hearth fill tiles Arena Ground --rect 2,2,10,6 --char G --json

# 3. Bind "G" to a blob47 rule. mapping keys are canonical shape keys (see
#    editor.md#autotile for the full 47-key table); values are whatever
#    frame names sliceSpritesheet actually produced, in your tileset's
#    layout order
hearth autotile set Arena Ground --char G --sheet ground-sheet \
  --mapping '{"0":"ground_0","1":"ground_1","4":"ground_2","5":"ground_3","7":"ground_4", …}' \
  --json
# -> { "success": true, "command": "setTileAutotile",
#      "data": { "entityId": "ent_…", "char": "G",
#                 "rule": { "sheet": "ast_…", "template": "blob47", "mapping": { "0": "ground_0", … } } }, … }
```

The running editor preview (and any exported build) re-renders the map
live the moment the rule changes, no restart needed. To remove a rule:
`hearth autotile set Arena Ground --char G --clear`.

### Override an instance field, then revert it

```bash
# Assume "Elite Enemy" is a placed instance of the Enemy prefab (see
# prefabs.md — packages/examples/ember-horde does exactly this)
hearth set Arena "Elite Enemy" SpriteRenderer.color "#c9184a"
hearth set Arena "Elite Enemy" SpriteRenderer.width 32
hearth set Arena "Elite Enemy" SpriteRenderer.height 32
# Each set is a normal setComponentProperty call — the override recording
# is implicit, no separate command. Confirm with inspectEntity or the
# Inspector's ember dots.

hearth prefab update Enemy Arena "Enemy"   # tweak the base prefab...
# ...auto-syncs every instance, INCLUDING Elite Enemy, whose three
# overrides above are preserved on top of the merge (see
# prefabs.md#live-link-semantics-marker-merge-detach)

# Change your mind about the size, keep the color override:
hearth prefab revert Arena "Elite Enemy" SpriteRenderer width
hearth prefab revert Arena "Elite Enemy" SpriteRenderer height
# Or revert every override on this entity in one call:
hearth prefab revert Arena "Elite Enemy"
```

### Bulk import a folder

```bash
hearth import asset ./art/tileset/ --recursive --json
# -> { "success": true, "command": "importAssets",
#      "data": { "imported": [ { "path": "art/tileset/grass.png", "assetId": "ast_…", "name": "grass", "type": "sprite" },
#                                … ],
#                 "skipped": [ { "path": "art/tileset/notes.txt", "code": "UNKNOWN_TYPE", "message": "…" } ] },
#      … "files": ["hearth.json", "assets.json"] }
```

One atomic undo/journal entry for the whole folder; name/path collisions
auto-suffix (`grass` → `grass-2`) instead of failing the batch, and a bad
file is reported in `data.skipped` (with a `code`/`message`) rather than
aborting everything else. Over MCP, `import_assets` takes `sourcePaths`
directly with no `--recursive` equivalent: enumerate the folder's files
yourself (e.g. via `list_assets`-style host tooling, or a directory
listing tool the client has) and pass the full path list.

## Discovering capabilities

- `hearth commands --json`: the full engine command registry (name,
  description, permission, mutates).
- `hearth inspect components --json`: every component type with docs and
  default values.
- `hearth inspect api --json`: the complete script `ctx` API, every
  member with its signature, description, and a Lua + JS example.
- MCP `tools/list`: same registry as typed tools.

If a capability isn't in the registry, it doesn't exist. Ask the human
instead of improvising (e.g. there is no pathfinding command yet; it's on
the [roadmap](./roadmap.md)). `screenshot` (CLI and MCP) is the one
deliberate exception: it doesn't wrap a registry command since it needs
headless Chromium, a Node-only dependency the browser-safe core can't take
on. See [cli.md](./cli.md#command-tour).
