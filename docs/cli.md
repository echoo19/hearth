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
`duplicate scene <scene> <new-name> [--with-playtests]` (fresh entity ids;
`--with-playtests` also clones every playtest targeting the source scene,
retargeted to the copy — see [the envelope below](#tilemap-editing) for the
sibling tilemap verbs' example format), `duplicate entity <scene> <entity>
[--name n] [--offset x,y]` (deep-copies the entity and its full descendant
subtree with fresh ids in one command; default offset `16,16` so the copy
doesn't sit exactly on top of the original — descendants keep their cloned
relative position unchanged),
`move entity <scene> <entity> [--position x,y] [--parent ref | --to-root]`,
`add component <scene> <entity> <Type> [--properties '<json>']`,
`remove component`, `set <scene> <entity> <Type.path.to.prop> <value>`
(value parses as JSON: `100` is a number, `true` a boolean, `#ff0000` a
string; the path is validated against the component's actual schema shape
before writing — an unknown segment, e.g. a typo'd `Transform.postiion.x`,
is rejected with a did-you-mean suggestion and the full list of valid keys,
instead of silently succeeding against a throwaway key), `set-many <scene>
<entity> --properties '<json>'` (sets multiple dot-path properties, across
one or several components, as **one undo step** — e.g. `hearth set-many
Level1 Coin --properties '{"Transform.position.x":100,"SpriteRenderer.width":64}'`;
all-or-nothing: every key is validated before anything is written, and
when two keys target the same nested path the later one wins), `set-input
<action> [keys...]`,
`set-settings [--build-settings '<json>'] [--initial-scene s]
[--input-actions '<json>'] [--input-gamepad-buttons '<json>']
[--input-gamepad-axes '<json>'] [--input-axes '<json>']
[--input-deadzone n]` (partial, deep-merged — this is how you set
`buildSettings.loading` for exported games, the initial scene, and every
input mapping). `--input-gamepad-buttons` maps action names to gamepad
button name lists (e.g. `'{"jump":["a"]}'` — named buttons: `a`, `b`, `x`,
`y`, `lb`, `rb`, `lt`, `rt`, `back`, `start`, `ls`, `rs`, `dpad-up`,
`dpad-down`, `dpad-left`, `dpad-right`); `--input-gamepad-axes` maps
actions to a digital axis-crossed-a-threshold binding (e.g.
`'{"right":{"axis":0,"direction":1,"threshold":0.5}}'`); `--input-axes`
defines **virtual analog axes** read via `ctx.input.axis(name)` (e.g.
`'{"horizontal":{"gamepadAxis":0,"negativeCodes":["ArrowLeft"],"positiveCodes":["ArrowRight"]}}'`
— see [input.md](./input.md) for the full field reference and how
keyboard/gamepad reads combine); `--input-deadzone` sets the project-wide
default stick deadzone (`0`-`1`, default `0.15`), overridable per axis. See
[input.md](./input.md) for the whole input system, including the editor's
Input panel.

**Scripts** (code-edit, except `check-script`/`script search` which are
read-only): `create script <name> [--language lua|js] [--source-file f]`
(Lua is the default), `attach script <scene> <entity> <path>
[--params '<json>']`, plus the `script edit|check|format|search|replace`
group — see [The `script` group](#the-script-group) below.

**Assets** (asset-edit): `create asset sprite <name> --shape circle --color
gold --width 24 --height 24` (shapes: rectangle, circle, triangle, diamond,
star, capsule, polygon, character, enemy, coin, heart), `create asset tile
<name> --color green`, `create sound <name> --preset coin [--seed n]`
(deterministic WAV; presets: coin, jump, hit, laser, powerup, explosion,
blip), `create animation <name> --frames f1 f2`, `import asset <path...>
[--name n] [--type t] [--recursive]` (a single path with no `--recursive`
runs `importAsset` unchanged — probes image dimensions for sprites/tiles
into `metadata`, `.woff`/`.woff2`/`.ttf`/`.otf` import as `font` assets;
**multiple paths, or `--recursive`, run `importAssets` instead** — one
atomic batch, collision-safe auto-suffixed naming, bad paths reported in
`skipped` rather than failing the whole call; `--recursive` expands any
directory argument into the files under it, recursively, before
importing — `--name` isn't valid in batch mode, `--type` applies to every
file in the batch), `create asset slice <asset> --frame-size WxH
[--margin N] [--spacing N] [--prefix NAME]` (cuts an imported spritesheet
into named frames, stored in the asset's own `metadata`), `create asset
anim-from-sheet <name> --sheet <asset> --frames a,b,c [--duration S]
[--no-loop]` (an animation asset whose frames are
`<sheetAssetId>#<frameName>` refs), `create asset state-machine <name>
--data <json|@file>` (an animation state machine asset — see
[scripting.md](./scripting.md#animation-state-machines) for the document
shape and `ctx.animator`), `delete asset <asset> [--keep-file]`
(unregisters the asset; also deletes its file unless `--keep-file` is
passed — note this CLI verb's default is the *opposite* of the underlying
`removeAsset` command's own `deleteFile` default, since every other CLI
delete verb removes its target outright and this closes that parity gap)
— see [assets.md](./assets.md) for the full pipeline, worked examples,
and the music/font/`assertAudioCount` side of things.

**State machines** (asset-edit): `create asset state-machine <name> --data
<json|@file>` (above) creates one; `set-state-machine <assetId> --data
<json|@file>` replaces an existing one's document wholesale, in place
(same asset id/path) — both take the full `{ params, states, initial,
transitions }` document either as inline JSON or `@path/to/file.json`. See
[scripting.md](./scripting.md#animation-state-machines) for the schema and
[editor.md](./editor.md#animator-editor) for the typed editor UI.

**Prefabs** (asset-edit, except `prefab revert` which is safe-edit):
`prefab create <scene> <entity> <name>` (serializes the entity's full
descendant subtree into a reusable prefab asset at
`assets/prefabs/<slug>.prefab.json`; the source entity becomes the
prefab's first live-linked instance), `prefab place <prefab> <scene>
[--position x,y] [--name n]` (instantiates a prefab into a scene as a fresh
entity subtree with new ids), `prefab update <prefab> <scene> <entity>`
(re-serializes a modified instance's subtree back over the prefab asset's
payload, then auto-syncs every other tracked instance in the same command —
`entity` must already be a tracked instance of that exact prefab), `prefab
sync <prefab> [--scene s]` (force a merge sync of every tracked instance
from the current payload, all scenes or just one — preserves each
instance's id/name/position/enabled state and re-applies its recorded
per-field overrides on top of the rebuilt subtree; a stale override that no
longer applies is dropped with a `PREFAB_OVERRIDE_STALE` warning), `prefab
revert <scene> <entity> [component] [path]` (reverts per-instance overrides
on an instance member back to the prefab's values; scope narrows with the
optional `component`/`path` args — neither reverts every override on that
entity, `component` alone reverts that whole component, both revert one
field). See [prefabs.md](./prefabs.md) for the full data model, live-link
merge/detach semantics, validation codes, and `ctx.scene.spawnPrefab`.

**Undo/redo** (safe-edit; read-only for `history`): `undo` (undo the most
recent recorded change), `redo` (redo the most recently undone change),
`history` (list recorded entries, oldest first, each with `seq`, `command`,
`summary`, `timestamp`, and whether it's currently undone). History is a
disk-backed, 25-entry bound stack under `.hearth/history/`, captured
around every mutating command except `undo`/`redo`/`revertProject`/
`snapshotProject` themselves (those operate on undo history or the
separate diff-baseline, not as undoable entries of their own). This is
independent of `snapshot`/`revert`'s single diff baseline — undo/redo
steps through every individual change one at a time, `revert` jumps
straight back to the last snapshot. See [architecture.md](./architecture.md)
for the on-disk layout and the trash-backed asset-file semantics (undoing
`removeAsset` never touches disk; **redoing** a `removeAsset` called with
`deleteFile: false` — so the file was left on disk the first time — does
delete the file, moving it into `.hearth/trash/` rather than erasing it
outright, so it's still recoverable).

**Command journal** (read-only): `log [--since seq] [--limit n]` — lists
recorded entries from `.hearth/log/commands.jsonl` (see
[project-format.md](./project-format.md#hearthlogcommandsjsonl) for the
on-disk shape), the same feed the editor's Agent panel timeline reads. With
no `--since`, returns the newest `--limit` entries (default 50, max 500);
with `--since <seq>` (including `--since 0`, an explicit from-the-start
cursor), pages forward oldest-first from just after that seq — a poller
bookmarking the last seq it saw never misses or re-fetches an entry. Unlike
`history`, the journal also records read-only `validate`/`playtest` runs
and *failed* commands, and it's never rewound by `undo`/`redo`. See
[Command journal](#command-journal) below for the entry shape and a worked
example.

**Tilemap editing** (safe-edit): `paint tiles <scene> <entity> --cells
"x,y,c;x,y,c"` (a batch of cell writes in one undo step), `fill tiles
<scene> <entity> --rect x,y,w,h --char c` (fills a rectangular region in
one undo step), `resize tilemap <scene> <entity> --size w,h [--anchor
top-left]` (growing pads new cells with `.`; shrinking crops the
right/bottom edges). A tile `char` is a single character: `.` or a literal
space means empty, anything else must be a key of the Tilemap's
`tileAssets`; out-of-bounds cells are command errors (with a suggestion to
resize first). See [Tilemap editing](#tilemap-editing) below for a worked
example.

**Autotile** (safe-edit): `autotile set <scene> <entity> --char c --sheet
<asset> [--template blob47] [--mapping '<json>']` (binds a tile char to a
47-blob autotile rule instead of a fixed asset — the char's per-cell
frame is picked from its 8 neighbours at render time; `--sheet` must be a
sliced spritesheet, `--template` defaults to and today only supports
`blob47`, `--mapping` overrides individual shape keys with custom frame
names, e.g. `'{"255":"center"}'`), `autotile set <scene> <entity> --char c
--clear` (removes the char's autotile rule). See
[editor.md](./editor.md#autotile) for the frame-naming convention and an
ASCII diagram of the neighbour bitmask.

**Testing & review**: `snapshot`, `diff`, `revert --confirm`,
`run <scene> [--frames n]` (the report includes `audioEvents`),
`playtest [name] [--all]`,
`create playtest <name> --scene s --steps-file steps.json [--max-frames n]
[--seed n]` (`--seed` makes `ctx.random` / Lua `math.random` reproducible;
steps cover input — `wait`, `press`, `release`, `click {x,y}`,
`setAxis {axis, value, frames?}` (sticky virtual-axis override for
`ctx.input.axis` — see [input.md](./input.md#playtest-input)),
`drag {from, to, frames?}` (pointer down at `from`, interpolated moves,
up at `to` — see [ui.md](./ui.md#playtests)) — and
assertions — `assertEntityExists`, `assertProperty`, `assertPositionNear`,
`assertScene`, `assertParticleCount`, `assertEventCount`,
`assertAudioCount` (filter by `asset`/`action`/`music`, checked against
`equals`/`min`/`max` — see [assets.md](./assets.md#testing-audio-assertaudiocount)),
`assertCameraEffect` (`effect: shake|flash|fade|zoomPunch`, counted against
`equals`/`min`/`max`; results also expose `cameraEffects` and
`cameraOverlayAlpha`), `assertPostEffect` (`effect` one of the 6
`Camera.postEffects` types, `active: true|false` — checks presence in the
main camera's stack, not param values; see
[effects.md](./effects.md#playtests-assertposteffect)), `assertFocus`
(`entity` name/id, or `null` for nothing focused; results expose
`focusedEntity`), `assertNoErrors`), `test` (validate + all playtests, the
CI command).

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

## The `script` group

`hearth script edit|check|format|search|replace` is the forward surface
for every script-editing operation; the older top-level `edit-script` and
`check-script` verbs still work — they're aliases into the exact same
handlers, kept because agents have them memorized.

- **`script edit <path> --source-file f`** (or pipe stdin): replace a
  script's full source. Reformats to Hearth house style on save unless
  `--no-format` is passed or the project's `codeStyle.formatOnSave` is
  `false` — StyLua (2-space indent, 100-column) for `.lua`, Prettier
  defaults for `.js`. Same command as `edit-script`/MCP `edit_script`.
- **`script check <path> [--source text] [--language lua|js]`**:
  syntax-checks a script without saving it — a pre-flight before `script
  edit`. With `--source`, checks that text as if it would be saved to
  `<path>`; otherwise reads `<path>` from the project. Human output is one
  `path:line message` line per diagnostic, same shape as `validate`'s
  script-error reporting; this is what the editor's Code panel runs on
  every edit to power its inline lint. Same command as `check-script`/MCP
  `check_script`.
- **`script format [path] [--all]`**: reformat one script, or every
  `.lua`/`.js` script under `scripts/` with `--all`, to Hearth house style
  (StyLua / Prettier as above). MCP `format_script`. Useful after a
  `script replace`, which writes verbatim without reformatting.
- **`script search <query> [--regex] [--case] [--glob g]`**: search script
  source for a plain-text or regex query, printing `path:line:col
  preview` per match. Matching is line-based — a regex can't span multiple
  lines. Case-insensitive by default; `--case` for case-sensitive.
  `--glob` restricts to scripts matching a glob (e.g.
  `"scripts/enemies/*"`). Read-only; MCP `search_scripts`. **CRLF files**:
  a matched line's preview keeps its trailing `\r` — a cosmetic artifact
  of line-based reading, not a matching bug.
- **`script replace <query> <replacement> [--regex] [--case] [--glob g]
  [--dry-run]`**: find-and-replace across every script file matching the
  query (and `--glob`, if given). `--regex` enables `$1`-style capture
  groups in `<replacement>`; matching is line-based, same caveat as
  `search`. Results are written **verbatim, not reformatted** — this is a
  surgical text operation, not a save-through-the-formatter — run `script
  format --all` afterward if you want house style restored. Always
  `--dry-run` first: it previews per-file match counts without writing
  anything, the same workflow the editor's cross-script search panel
  enforces (Preview, then Replace all). A real apply is one command/undo
  entry regardless of how many files it touches, so a single `undo`
  reverts the whole replace atomically. MCP `replace_in_scripts`.

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

## Tilemap editing

`paint tiles`, `fill tiles`, and `resize tilemap` edit a `Tilemap`
component's grid in batches — one undo entry per call, instead of one per
cell — and are what the editor's Scene View paint tool and the MCP
`paint_tiles`/`fill_tilemap_rect`/`resize_tilemap` tools both wrap:

```bash
hearth fill tiles Arena Ground --rect 0,0,4,2 --char G --json
```

```jsonc
{
  "success": true,
  "command": "fillTilemapRect",
  "data": { "painted": 8 },
  "errors": [],
  "warnings": [],
  "changed": [ { "kind": "component", "id": "ent_…", "name": "Tilemap", "scene": "scn_…", "action": "modified" } ],
  "files": ["scenes/arena.scene.json"],
  "suggestions": []
}
```

`paint tiles` takes a semicolon-separated `--cells "x,y,c;x,y,c"` list
instead of a rectangle (`x`/`y` are 0-based column/row); `resize tilemap`
takes `--size w,h` and an optional `--anchor` (only `top-left` is
supported today). All three validate `char` against the Tilemap's
`tileAssets` keys (plus `.`/space for empty) and reject out-of-bounds
cells as command errors rather than silently clamping — the error
`suggestions` field points you at `resize tilemap` first if that's what's
needed.

## Command journal

`log` reads `.hearth/log/commands.jsonl` — an append-only record of every
mutating command (plus a small allowlist of meaningful read-only ones:
`runPlaytest`, `validateProject`) run through *any* session against this
project (CLI, MCP, or the editor), independent of undo/redo history. It's
the same feed the editor's Agent panel timeline renders live, and the
signal the editor's external-change watcher uses to know when to reload.
See [project-format.md](./project-format.md#hearthlogcommandsjsonl) for
the on-disk `JournalEntry` shape.

```bash
hearth log --limit 5 --json
```

```jsonc
{
  "success": true,
  "command": "listJournal",
  "data": {
    "entries": [
      { "seq": 41, "ts": "2026-07-06T20:14:03.512Z", "source": "cli",
        "command": "createEntity", "summary": "createEntity Gem", "ok": true },
      { "seq": 42, "ts": "2026-07-06T20:14:05.108Z", "source": "mcp",
        "command": "validateProject", "summary": "validateProject", "ok": true,
        "detail": { "errors": 0, "warnings": 1 } },
      { "seq": 43, "ts": "2026-07-06T20:14:09.881Z", "source": "editor",
        "command": "deleteScene", "summary": "deleteScene OldLevel", "ok": false,
        "error": "NOT_FOUND" }
    ],
    "lastSeq": 43
  },
  "errors": [],
  "warnings": [],
  "changed": [],
  "files": [],
  "suggestions": []
}
```

Human (non-`--json`) output is one compact line per entry —
`#<seq> [<source>] <summary>`, with `(<error code>)` appended on failure —
since `summary` already leads with the command name. `--since <seq>`
(including `--since 0`, an explicit from-the-start cursor) switches to
oldest-first forward paging from just after that seq, for polling clients
that want to bookmark their position instead of always re-reading the
tail.

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
