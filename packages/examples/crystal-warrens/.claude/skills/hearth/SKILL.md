---
name: hearth
description: Operate the Hearth engine as a coding agent — the session loop (recall → snapshot → change → validate → playtest → screenshot → remember), project memory, permission modes, verification, review/undo, and export. Load FIRST whenever a project has a hearth.json or the task mentions Hearth. Routes to the domain skills: hearth-build (scenes/entities/tilemaps/prefabs), hearth-code (ctx scripting), hearth-art (assets/sourcing/pixel discipline), hearth-feel (juice/UX/quality bar), hearth-design (scope/pacing/endings/completeness).
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

## Which skill do you need?

This skill is the core loop; the domain playbooks are five sibling skills. **Load the relevant skill before working in its domain — don't work from memory:**

- **`hearth-build`** — scenes, entities, components, tilemaps/autotiling, colliders, prefabs, animation state machines, input bindings: structuring what EXISTS in the game.
- **`hearth-code`** — behavior scripts: the ctx API, Lua/JS hooks, modules, determinism, script iteration: making things HAPPEN.
- **`hearth-art`** — importing/slicing/animating assets, procedural sprites and sounds, autonomous CC0 sourcing with licensing, pixel-art discipline: making the game LOOK and SOUND real.
- **`hearth-feel`** — juice, game-UX conventions, and the quality bar: making it feel GOOD and judging when it's DONE.
- **`hearth-design`** — scoping a game to its session length, structuring levels/scenes, difficulty ramps and pacing, endings and replay hooks: deciding what the game NEEDS and judging whether it's COMPLETE.

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

**Building or polishing a game** (not just wiring a mechanic)? Load
**`hearth-feel`** — juice, game-feel, and the quality bar a game must clear —
and **`hearth-art`** for real art and sound. A flat, static scene of
placeholder rectangles is not "done"; animate it, give it feel, and screenshot
to confirm it looks real.

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

Health check: `hearth doctor`. When stuck on a capability, `hearth commands --json` is the ground truth — if it is not there, it does not exist.
