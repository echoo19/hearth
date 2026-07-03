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
hearth create script coin-pickup
hearth attach script "Level 1" Coin scripts/coin-pickup.js

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
`validate`.

**Scenes & entities** (safe-edit): `create scene <name>`,
`create entity <scene> <name> [--position x,y] [--parent ref] [--tags a,b]
[--components '<json>']`, `rename scene|entity`, `delete scene|entity`,
`move entity <scene> <entity> [--position x,y] [--parent ref | --to-root]`,
`add component <scene> <entity> <Type> [--properties '<json>']`,
`remove component`, `set <scene> <entity> <Type.path.to.prop> <value>`
(value parses as JSON: `100` is a number, `true` a boolean, `#ff0000` a
string), `set-input <action> [keys...]`.

**Scripts** (code-edit): `create script <name> [--source-file f]`,
`edit-script <path> --source-file f` (or pipe stdin),
`attach script <scene> <entity> <path> [--params '<json>']`.

**Assets** (asset-edit): `create asset sprite <name> --shape circle --color
gold --width 24 --height 24` (shapes: rectangle, circle, triangle, diamond,
star, capsule, polygon, character, enemy, coin, heart), `create asset tile
<name> --color green`, `create animation <name> --frames f1 f2`,
`import asset <path>`.

**Testing & review**: `snapshot`, `diff`, `revert --confirm`,
`run <scene> [--frames n]`, `playtest [name] [--all]`,
`create playtest <name> --scene s --steps-file steps.json`, `test`
(validate + all playtests, the CI command), `build [--out dir]`
(requires `--allow build`).

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
