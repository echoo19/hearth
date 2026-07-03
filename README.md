# Hearth 🔥

**An open-source 2D game engine and editor built for human + coding-agent collaboration.**

**Website & downloads: [hearth-engine.vercel.app](https://hearth-engine.vercel.app)**

Hearth is **not** an AI game generator. It's a real engine: humans get a
normal visual editor; coding agents (Claude Code, Codex, any MCP client) get
the *entire* editor surface as structured, validated, permission-checked
operations over a CLI and an MCP server. No AI runs inside the engine, no
API keys, no cloud — projects are local JSON files, and agents connect from
outside.

```
   Human ──▶ Editor UI ──┐
                         ├──▶  one shared command system  ──▶  project files
   Agent ──▶ CLI / MCP ──┘      (validate · execute · diff)     scenes · scripts · assets
```

Both audiences use the same ~40 engine commands (`createEntity`,
`setComponentProperty`, `runPlaytest`, `getDiff`, …). That means an agent can
build a level, wire input, write behavior scripts, generate placeholder art,
run headless playtests, and hand the human a structural diff to review in the
editor — without ever guessing at file formats.

## Status

**v0.1.0 — first developer preview.** The full loop works end to end:
project model → editor → runtime preview → CLI → MCP → headless playtests →
diff review. See [docs/roadmap.md](docs/roadmap.md) for what's deliberately
missing (screenshots for agents, web export, audio playback, undo…).

## Install

**Download the desktop app** — [Releases](https://github.com/echoo19/hearth/releases/latest):
macOS (`Hearth-mac-arm64.dmg` / `Hearth-mac-x64.dmg`), Windows
(`Hearth-win-x64.exe`), Linux (`Hearth-linux-x86_64.AppImage` /
`Hearth-linux-amd64.deb`). macOS builds are unsigned in this preview —
right-click → Open the first time.

**Agent tools without any install** (single files, Node ≥ 20):

```bash
curl -LO https://github.com/echoo19/hearth/releases/latest/download/hearth-cli.mjs
curl -LO https://github.com/echoo19/hearth/releases/latest/download/hearth-mcp.mjs
node hearth-cli.mjs --help
claude mcp add hearth -- node $PWD/hearth-mcp.mjs --project <your game>
```

The same two files also ship inside the desktop app (the Agent panel shows
their exact paths, ready to copy).

## Quick start (from source)

Requires Node ≥ 20.

```bash
git clone https://github.com/echoo19/hearth.git && cd hearth
npm install
npm run build:packages     # core → runtime → playtest → cli → mcp-server
npm test                   # 85+ tests
npm run dev                # editor at http://localhost:5173
```

In the editor's launcher, open an example (e.g. **Mini Platformer**), press
**Play** in the Game tab — arrows/WASD to move, Space to jump.

### Desktop app

```bash
npm run app          # launch Hearth as a desktop app (Electron)
npm run app:dist     # package a real Hearth.app / installer
```

The desktop app opens projects straight from folders with native dialogs,
Godot/Unity style — see [docs/desktop-app.md](docs/desktop-app.md).

### Try the agent loop yourself

```bash
alias hearth="node $PWD/packages/cli/dist/main.js"
cd packages/examples/mini-platformer

hearth snapshot                       # checkpoint for review
hearth inspect scene "Level 1" --json # what's here?
hearth create entity "Level 1" Gem \
  --position 620,300 --tags coin \
  --components '{"SpriteRenderer":{"shape":"diamond","color":"#9b59b6","width":20,"height":20},"Collider":{"shape":"circle","radius":12,"isTrigger":true}}'
hearth attach script "Level 1" Gem scripts/coin-pickup.js
hearth validate --json                # schema + reference checks
hearth test                           # headless playtests
hearth diff                           # what changed, human-readable
hearth revert --confirm               # undo the whole session
```

### Connect Claude Code via MCP

```bash
claude mcp add hearth -- node $PWD/packages/mcp-server/dist/main.js \
  --project $PWD/packages/examples/mini-platformer
```

Then ask it to call `get_agent_instructions`. Permission modes
(`--mode read-only` … `--mode all`) control what the agent may do —
see [docs/mcp.md](docs/mcp.md).

## What's in the box

- **Editor** (`apps/editor`) — project launcher, scene view with drag
  editing, hierarchy, schema-driven inspector, asset browser, console,
  live game preview (PixiJS), **diff/review panel**, and an agent-integration
  panel with copy-paste setup. Runs in the browser via Vite or as a packaged
  Electron desktop app with native folder dialogs (Tauri shell included as an
  experimental alternative).
- **Runtime** (`packages/runtime`) — fixed-timestep deterministic 2D runtime:
  transforms, sprites/primitives, text, tilemaps, input actions, AABB
  physics + triggers, cameras, and a sandboxed-ish JS script engine that runs
  identically in the browser preview and headless in Node.
- **CLI** (`packages/cli`) — `hearth` with `--json` envelopes for every
  operation, plus `doctor`, `test`, and `commands` (registry discovery).
- **MCP server** (`packages/mcp-server`) — 37 tools mirroring the CLI, with
  per-session permission modes.
- **Playtests** (`packages/playtest`) — scripted input + assertions, run
  headlessly at a fixed timestep; deterministic and CI-friendly.
- **Procedural assets** — agents create deterministic SVG sprites/tiles
  (`character`, `enemy`, `coin`, `heart`, shapes…) so games are playable
  before art exists. No AI image generation.
- **Examples** (`packages/examples`) — mini platformer, top-down room,
  visual novel — generated *through the command system itself* and covered
  by playtests in CI.
- **Agent onboarding** — every new project gets `AGENTS.md`, `CLAUDE.md`,
  and `.hearth/agent-config.json` teaching agents the safe workflow
  (snapshot → inspect → command → validate → playtest → diff).

## Documentation

| | |
| --- | --- |
| [Quickstart](docs/quickstart.md) | Install → first game in 10 minutes |
| [Desktop app](docs/desktop-app.md) | Electron packaging, native folder dialogs |
| [CLI guide](docs/cli.md) | Every command + the JSON envelope |
| [MCP guide](docs/mcp.md) | Connecting agents, permission modes |
| [Agent workflow](docs/agents.md) | How agents should operate (and why) |
| [Architecture](docs/architecture.md) | Packages, command system, data flow |
| [Project format](docs/project-format.md) | Every file, every schema |
| [Components](docs/components.md) | All 9 component types + defaults |
| [Scripting](docs/scripting.md) | The `ctx` API, physics interplay, limits |
| [Roadmap](docs/roadmap.md) | Honest list of what's next / missing |
| [Contributing](CONTRIBUTING.md) | Dev setup + AI contribution policy |

## Design principles

1. **The engine works without AI.** Agents are a first-class *client*, not a
   dependency.
2. **One command system.** If it's not a registered command, neither the UI
   nor agents can do it — capabilities stay legible and auditable.
3. **Humans stay in charge.** Permission modes gate what agents may touch;
   snapshots + structural diffs make every agent session reviewable and
   revertible; playtests make "it works" checkable.
4. **Local-first, readable files.** JSON you can diff, SVG you can open,
   scripts you can read.

## License

[MIT](LICENSE). Dependencies are all open-source-friendly (zod, commander,
PixiJS, React, MCP SDK).
