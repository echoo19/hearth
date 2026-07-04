# `hearth` CLI Guide

The CLI is the primary agent interface to Hearth, and a perfectly good human
one. Every subcommand dispatches into the same core command system as the
editor and the MCP server.

## Setup

From a repo checkout:

```bash
npm install && npm run build:packages
npm link -w @hearth/cli        # optional: puts `hearth` on your PATH
# or run directly:
node packages/cli/dist/main.js --help
```

## Global options

| Flag | Meaning |
| --- | --- |
| `-p, --project <path>` | Project root. Default: walk up from cwd until `hearth.json` is found. |
| `--json` | Emit the machine-readable `CommandResult` envelope on stdout. **Agents: always use this.** |
| `--allow <modes>` | Permission grant: comma list of `read-only,safe-edit,code-edit,asset-edit,build`, or `all`. Default grants everything except `build`. |
| `-q, --quiet` | Suppress stderr logging. |

Exit code is `0` on success, `1` on any failure, including validation
errors and failed playtests, so `hearth test` works in CI.

## The agent loop

```bash
hearth snapshot                          # checkpoint (enables diff/revert)
hearth inspect project --json            # learn the project
hearth inspect scene "Level 1" --json    # entities, components, hierarchy
hearth inspect components --json         # every component type + defaults

hearth create entity "Level 1" Coin \
  --position 320,400 --tags coin \
  --components '{"SpriteRenderer":{"shape":"circle","color":"#f1c40f"},"Collider":{"shape":"circle","radius":12,"isTrigger":true}}'
hearth set "Level 1" Coin Transform.position.x 200
hearth create script coin-pickup            # Lua by default; --language js for JS
hearth attach script "Level 1" Coin scripts/coin-pickup.lua

hearth validate --json                   # must pass
hearth run "Level 1" --frames 120 --json # smoke: no script errors
hearth playtest --all                    # scripted assertions
hearth diff                              # what changed, for human review
```

## Command tour

**Project**: `init <name>` (new project + agent files), `doctor` (health
report), `commands` (dump the full engine command registry; agents can
discover every operation from this).

**Inspect** (read-only): `inspect project|scenes|components|assets|scripts`,
`inspect scene <scene> [--full]`, `inspect entity <scene> <entity>`,
`inspect api` (the full script `ctx` reference with Lua + JS examples),
`inspect path <scene> --from x,y --to x,y [--diagonals]` (grid A\* over
the scene's solid geometry — see [Pathfinding](#pathfinding) below),
`validate` (includes per-script syntax checks with file + line, both
languages).

**Scenes & entities** (safe-edit): `create scene <name>`,
`create entity <scene> <name> [--position x,y] [--parent ref] [--tags a,b]
[--components '<json>']`, `rename scene|entity`, `delete scene|entity`,
`move entity <scene> <entity> [--position x,y] [--parent ref | --to-root]`,
`add component <scene> <entity> <Type> [--properties '<json>']`,
`remove component`, `set <scene> <entity> <Type.path.to.prop> <value>`
(value parses as JSON: `100` is a number, `true` a boolean, `#ff0000` a
string), `set-input <action> [keys...]`,
`set-settings [--build-settings '<json>'] [--initial-scene s]
[--input-actions '<json>']` (partial, deep-merged — this is how you set
`buildSettings.loading` for exported games and the initial scene).

**Scripts** (code-edit): `create script <name> [--language lua|js]
[--source-file f]` (Lua is the default),
`edit-script <path> --source-file f` (or pipe stdin),
`attach script <scene> <entity> <path> [--params '<json>']`.

**Assets** (asset-edit): `create asset sprite <name> --shape circle --color
gold --width 24 --height 24` (shapes: rectangle, circle, triangle, diamond,
star, capsule, polygon, character, enemy, coin, heart), `create asset tile
<name> --color green`, `create sound <name> --preset coin [--seed n]`
(deterministic WAV; presets: coin, jump, hit, laser, powerup, explosion,
blip), `create animation <name> --frames f1 f2`, `import asset <path>`.

**Testing & review**: `snapshot`, `diff`, `revert --confirm`,
`run <scene> [--frames n]` (the report includes `audioEvents`),
`playtest [name] [--all]`,
`create playtest <name> --scene s --steps-file steps.json [--max-frames n]
[--seed n]` (`--seed` makes `ctx.random` / Lua `math.random` reproducible;
steps cover input — `wait`, `press`, `release`, `click {x,y}` — and
assertions — `assertEntityExists`, `assertProperty`, `assertPositionNear`,
`assertScene`, `assertParticleCount`, `assertEventCount`, `assertNoErrors`), `test`
(validate + all playtests, the CI command).

**Export** (requires `--allow build`): `export web [--out dir]
[--single-file] [--zip]` — a static playable web build; `--zip` writes an
itch.io-ready `<project-slug>-web.zip` (see [export.md](./export.md)).
`build [--out dir]` still exports a portable project folder.

**Screenshot** (requires `--allow build`): `screenshot [scene] [--frame n]
[--seed n] [--size WxH] [--debug] [--out path]` — a deterministic PNG of a
scene, so an agent can *see* its work instead of only reading state. Scene
defaults to the project's initial scene; `--frame` steps that many fixed
frames before capturing (default 0); `--debug` draws the same collider/
velocity/light debug overlay the editor's preview toggle uses (never on by
default, never in exports — see [export.md](./export.md#debug-overlay)).
Needs a real Chromium: Google Chrome or Microsoft Edge on the machine, a
`CHROMIUM_PATH` environment variable pointing at one, or
`npx playwright install chromium`; without any of those it fails with a
message telling you exactly that.

## Pathfinding

`hearth inspect path` runs the same grid A\* used by `ctx.scene.findPath`
(see [scripting.md](./scripting.md#entities-in-the-current-scene)) offline,
against the scene's **authored** state (no need to boot a session).
The grid is built from every solid `Tilemap` and every non-trigger
`static`/`kinematic` `Collider` in the scene:

```bash
hearth inspect path Arena --from 680,500 --to 200,500 --json
```

```jsonc
{
  "success": true,
  "command": "inspectPath",
  "data": {
    "found": true,
    "path": [
      { "x": 688, "y": 496 },
      { "x": 656, "y": 496 },
      // … one waypoint per grid cell crossed, each a cell center …
      { "x": 208, "y": 496 }
    ],
    "cells": 667,
    "cellSize": 32
  },
  "errors": [],
  "warnings": [],
  "changed": [],
  "files": [],
  "suggestions": []
}
```

`data.path` is `null` (not an empty array) when `from`/`to` sits in a
solid cell or no route exists; `--diagonals` allows 8-directional
movement (off by default — four-directional only). `data.cells` is the
grid's total cell count, useful for sanity-checking a level isn't
accidentally enormous (grids over 512×512 are rejected).

## The `--json` envelope

Every command emits the same structure:

```jsonc
{
  "success": true,
  "command": "createEntity",
  "data": { "entityId": "ent_x4k2p9aa", "components": ["Transform", "SpriteRenderer"] },
  "errors": [],            // [{ "code": "NOT_FOUND", "message": "…" }]
  "warnings": [],
  "changed": [ { "kind": "entity", "id": "ent_…", "scene": "scn_…", "action": "created" } ],
  "files": ["scenes/level_1.scene.json", "hearth.json", "assets.json"],
  "suggestions": ["inspectEntity --scene scn_… ent_…"]
}
```

Error codes are stable (`NOT_FOUND`, `CONFLICT`, `INVALID_PARAMS`,
`SCHEMA_ERROR`, `PERMISSION_DENIED`, `UNKNOWN_COMMAND`, `INTERNAL_ERROR`).
Branch on `success` and `errors[].code` rather than on message text.
