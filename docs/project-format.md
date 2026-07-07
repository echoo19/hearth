# Hearth Project Format (v1)

A Hearth project is a plain directory of human- and agent-readable JSON plus
scripts and assets. Everything is local-first; nothing requires a server.

> **Agents:** prefer `hearth` CLI commands / MCP tools over editing these
> files directly; commands validate every change. This document is the
> contract those tools maintain.

```
my-game/
├── hearth.json                  # project manifest
├── assets.json                  # asset index
├── scenes/
│   └── level_1.scene.json       # one file per scene
├── assets/
│   ├── sprites/coin.svg         # procedural or imported sprites
│   ├── tiles/grass.svg
│   ├── sounds/coin_sound.wav    # procedural sound effects (16-bit PCM WAV)
│   └── animations/idle.anim.json
├── scripts/
│   └── player-controller.lua    # behavior scripts (Lua by default; .js works too)
├── playtests/
│   └── smoke.playtest.json      # headless scripted tests
├── .hearth/
│   ├── agent-config.json        # machine-readable agent entry point
│   ├── baseline.json            # diff baseline (snapshot; gitignored)
│   ├── history/                 # undo/redo entries (gitignored)
│   └── log/
│       └── commands.jsonl       # append-only command journal (gitignored)
├── AGENTS.md                    # generated agent instructions
└── CLAUDE.md                    # pointer for Claude Code
```

All schemas are Zod definitions in `packages/core/src/schema/`. That code is
normative; this page is descriptive. Every file carries `formatVersion: 1`.

## hearth.json

```jsonc
{
  "formatVersion": 1,
  "hearthVersion": "0.8.0",
  "id": "prj_a1b2c3d4",
  "name": "My Game",
  "description": "",
  "initialScene": "scn_x9y8z7",         // scene id that runs first
  "scenes": [
    { "id": "scn_x9y8z7", "name": "Level 1", "path": "scenes/level_1.scene.json" }
  ],
  "inputMappings": {
    "actions": {                          // action name → KeyboardEvent.code list
      "left": ["ArrowLeft", "KeyA"],
      "jump": ["Space"]
    },
    "gamepadButtons": { "jump": ["a"] },   // action name → named gamepad buttons
    "gamepadAxes": {},                     // action name → digital axis-crossed-threshold binding
    "axes": {                              // virtual analog axis name → ctx.input.axis(name) source
      "horizontal": {
        "gamepadAxis": 0,
        "negativeCodes": ["ArrowLeft", "KeyA"],
        "positiveCodes": ["ArrowRight", "KeyD"]
      }
    },
    "deadzone": 0.15                       // default stick deadzone, 0-1
  },
  "buildSettings": {
    "width": 800, "height": 600,
    "backgroundColor": "#1a1a2e",
    "targetFps": 60, "fixedTimestep": 60, // physics/update Hz
    "title": "My Game",
    "loading": {                 // what an exported game shows while loading
      "backgroundColor": "#000000",
      "image": null,             // sprite asset id, centered, or null
      "spinner": false           // minimal neutral spinner
    }
  }
}
```

Change settings with the `updateSettings` command (partial deep-merge)
rather than hand-editing.

## Scene files (`scenes/*.scene.json`)

Entities are a **flat list**; hierarchy is `parentId` (children inherit the
parent's translation at runtime). IDs are stable and prefixed (`ent_`,
`scn_`, `ast_`, `ptt_`, `prj_`) so they're self-describing in diffs and logs.

```jsonc
{
  "formatVersion": 1,
  "id": "scn_x9y8z7",
  "name": "Level 1",
  "entities": [
    {
      "id": "ent_k3v9qzpm",
      "name": "Player",
      "parentId": null,
      "enabled": true,
      "tags": ["player"],
      "components": {
        "Transform":      { "position": {"x": 120, "y": 380}, "rotation": 0, "scale": {"x":1,"y":1} },
        "SpriteRenderer": { "assetId": "ast_abc123", "shape": "rectangle", "color": "#ffffff",
                            "width": 32, "height": 48, "opacity": 1, "flipX": false, "flipY": false,
                            "layer": 0, "visible": true },
        "Collider":       { "shape": "box", "width": 28, "height": 46, "radius": 16,
                            "offset": {"x":0,"y":0}, "isTrigger": false },
        "PhysicsBody":    { "bodyType": "dynamic", "velocity": {"x":0,"y":0},
                            "gravityScale": 1, "drag": 0 },
        "Script":         { "scriptPath": "scripts/player-controller.lua",
                            "params": { "speed": 220 } }
      }
    }
  ]
}
```

Components are a map keyed by type: **one component per type per entity** in
format v1 (multi-instance components are the documented extension path via a
`formatVersion` bump). See [components.md](./components.md) for every type
and property, or run `hearth inspect components --json`.

## assets.json + asset files

```jsonc
{
  "formatVersion": 1,
  "assets": [
    { "id": "ast_abc123", "name": "coin", "type": "sprite",
      "path": "assets/sprites/coin.svg",
      "metadata": { "procedural": true, "shape": "coin", "color": "yellow" } }
  ]
}
```

Asset types: `sprite`, `tile`, `audio`, `animation`, `font`, `data`, `other`.
Procedural assets are deterministic: SVG for sprites/tiles, 16-bit PCM WAV
for sounds (`createSound`; same preset + seed → identical bytes). No AI, no
network. Animation assets are JSON: `{ "frames": ["ast_…", …],
"frameDuration": 0.15, "loop": true }` referencing sprite assets.

## Playtests (`playtests/*.playtest.json`)

Deterministic headless tests: scripted input + assertions at a fixed
timestep.

```jsonc
{
  "formatVersion": 1,
  "id": "ptt_q1w2e3",
  "name": "player-moves-right",
  "scene": "scn_x9y8z7",
  "maxFrames": 300,                       // hard stop
  "steps": [
    { "type": "wait", "frames": 60 },
    { "type": "press", "action": "right", "frames": 45 },
    { "type": "assertProperty", "entity": "Player",
      "property": "Transform.position.x", "greaterThan": 180 },
    { "type": "assertNoErrors" }
  ]
}
```

Step types: `wait`, `press`, `release`, `click` (screen coordinates),
`assertEntityExists`, `assertProperty` (`equals` / `greaterThan` /
`lessThan`), `assertPositionNear`, `assertScene`, `assertNoErrors`.
Playtests also carry a `seed` (default `0`) for the script RNG
(`ctx.random` / Lua `math.random`) — same seed, same run.

## Scripts (`scripts/*.lua`, `scripts/*.js`)

Plain Lua (default) or JavaScript files defining lifecycle hooks (see
[scripting.md](./scripting.md)); both languages get the identical `ctx`
API. Scripts are referenced by path from `Script` components and are the
one part of the project agents are encouraged to edit as code (via
`hearth create script` / `hearth edit-script`).

## .hearth/log/commands.jsonl

An append-only, newline-delimited JSON log of commands run through *any*
session against this project (CLI, MCP, or the editor) — independent of
`.hearth/history/`'s undo/redo stack. Unlike history, the journal also
records read-only-but-meaningful runs (`runPlaytest`, `validateProject`)
and failed commands, and it is never rewound by `undo`/`redo`. It's the
data source for `hearth log` / `listJournal` / the MCP `list_journal` tool,
and for the editor's Agent panel activity timeline and external-change
detection (see [agent-panel.md](./agent-panel.md#the-external-change-model)).

One JSON object per line, oldest first:

```jsonc
{
  "seq": 42,                       // monotonic per project
  "ts": "2026-07-06T20:14:05.108Z",// ISO timestamp
  "source": "cli",                 // "editor" | "cli" | "mcp" | "unknown" (or a session's own label)
  "command": "createEntity",
  "summary": "createEntity Gem",   // human-readable, reuses the command's own summary
  "ok": true,
  "error": "NOT_FOUND",            // present only when ok is false; a stable error code
  "detail": { "errors": 0, "warnings": 1 } // small command-specific facts only; present on a few commands
}
```

Notes:

- **What gets journaled**: every `mutates: true` command, plus a small
  fixed allowlist of meaningful non-mutating ones (`runPlaytest`,
  `validateProject`). Plain `inspect*`/`list*` reads are not journaled —
  the editor calls those constantly and they carry no news.
- **No params, no snapshots.** `detail` carries only a few small,
  defensively-extracted facts (e.g. `runPlaytest`'s pass/fail and assertion
  counts, `validateProject`'s error/warning counts) — the journal is a
  feed, not a backup. Undo history and `snapshot`/`diff`/`revert` remain
  the separate mechanisms for that.
- **Rotation.** Once the file exceeds 4000 lines it's rewritten down to
  the newest 2000, preserving `seq` continuity. A journal-write failure
  never fails the command it's recording — it's isolated exactly like
  history-record failures.
- **`seq` is monotonic per project**, read from the last line on disk at
  append time; exact cross-process collisions under concurrent writers are
  tolerable (the journal is informational, never load-bearing for
  correctness) and ties break by `ts`.
- Joins the `.gitignore`-managed engine-state convention alongside
  `.hearth/history/` and `.hearth/baseline.json` — this file is local
  session state, not part of the project's tracked format.

## Versioning & compatibility

- `formatVersion` is a strict literal (`1`); loaders reject unknown versions
  rather than guessing.
- Unknown component types are rejected by the scene schema (strict map),
  which keeps agent-written files honest.
- IDs must match their prefix patterns (`^ent_[a-z0-9]+$` etc.).
