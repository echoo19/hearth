<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/readme-banner-dark.svg">
  <img src="assets/brand/readme-banner-light.svg" alt="hearth" width="480">
</picture>

**A 2D game engine and editor built for humans and coding agents to make games together.**

[Website](https://hearth-engine.vercel.app) · [Download](https://github.com/echoo19/hearth/releases/latest) · [Quickstart](docs/quickstart.md) · [Docs](#documentation)

[![CI](https://img.shields.io/github/actions/workflow/status/echoo19/hearth/ci.yml?label=CI)](https://github.com/echoo19/hearth/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/echoo19/hearth)](https://github.com/echoo19/hearth/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

Hearth is a real engine, not an AI game generator. Humans get a normal visual
editor. Coding agents (Claude Code, Codex, any MCP client) get the entire
editor surface as structured, validated, permission-checked operations over a
CLI and an MCP server. No AI runs inside the engine, nothing needs an API key
or a cloud account, and your project is a folder of readable JSON, scripts,
and assets on your own disk.

```
   Human ──▶ Editor UI ──┐
                         ├──▶  one shared command system  ──▶  project files
   Agent ──▶ CLI / MCP ──┘      (validate · execute · diff)     scenes · scripts · assets
```

Both audiences use the same 48 engine commands: `createEntity`,
`setComponentProperty`, `runPlaytest`, `getDiff`, and so on. An agent can
build a level, wire input, write behavior scripts, import and slice art, run
headless playtests, and hand you a structural diff to review in the editor,
all without guessing at file formats. You stay in charge the whole way:
permission modes gate what agents may touch, and every session can be
snapshotted, diffed, and reverted.

## What's in the engine

**Runtime.** A fixed-timestep, deterministic 2D runtime: sprites and
spritesheets, tilemaps with auto-generated colliders, text, 2D lighting,
polylines, deterministic particles, sprite animation, and screen-space game
UI. Physics covers mass, restitution, friction, named collision layers,
one-way platforms, and box/circle/convex-polygon colliders. Audio includes
sound effects, procedural synthesis, and a streamed music channel that
survives scene switches. The same runtime runs in the editor preview,
headlessly in Node, and in exported games.

**Scripting.** Lua by default (sandboxed, seed-deterministic), JavaScript
equally supported, both against the same `ctx` API: timers, tweens, seeded
RNG, pub/sub events, math helpers, grid pathfinding, camera control, save
data, and scene switching for building your own menus. `hearth inspect api`
prints the whole surface.

**Editor.** A dockable workspace with a scene view, hierarchy,
schema-driven inspector, asset browser with spritesheet slicing and
previews, live game preview, console, and a diff/review panel for agent
sessions. Runs in the browser during development or as a packaged desktop
app (Electron) with native folder dialogs.

**Agent tooling.** The `hearth` CLI wraps every command with `--json`
envelopes. The MCP server exposes 45 typed tools with per-session permission
modes. Playtests script input and assert on game state, events, particles,
and audio, entirely headless and CI-friendly. `hearth screenshot` renders
real frames through headless Chromium so agents can see their own work.

**Export.** `hearth export web` produces a static, self-contained build
(one folder, one HTML file, or a zip for itch.io) that boots straight into
your first scene. No engine splash screen, no branding, nothing of Hearth's
chrome ships in your game.

**Procedural placeholders.** Agents can create deterministic SVG sprites and
WAV sound effects through commands, so a game is playable and audible before
any real assets exist. Real art, sound, music, and fonts come in through the
same asset pipeline: import, probe, slice, animate.

## Status

Hearth is at **v0.6.0**, a developer preview. The full loop works end to
end: project model, editor, runtime preview, CLI, MCP, headless playtests,
diff review, web export. Recent releases added the asset pipeline (import
real images, audio, and fonts; slice spritesheets; stream music), physics
v2, pathfinding, 2D lighting and particles, and Lua scripting. The
[roadmap](docs/roadmap.md) keeps an honest list of what's still missing,
including editor undo, prefabs, and gamepad input.

## Install

**Desktop app.** Grab it from the
[latest release](https://github.com/echoo19/hearth/releases/latest): macOS
(`Hearth-mac-arm64.dmg` / `Hearth-mac-x64.dmg`), Windows
(`Hearth-win-x64.exe`), Linux (`Hearth-linux-x86_64.AppImage` /
`Hearth-linux-amd64.deb`). On macOS, first launch is right-click → Open;
if macOS claims the app is damaged, run `xattr -cr /Applications/Hearth.app`
(preview builds are ad-hoc signed, not notarized yet).

**Agent tools, no install.** The CLI and MCP server also ship as single
files that only need Node 20+:

```bash
curl -LO https://github.com/echoo19/hearth/releases/latest/download/hearth-cli.mjs
curl -LO https://github.com/echoo19/hearth/releases/latest/download/hearth-mcp.mjs
node hearth-cli.mjs --help
claude mcp add hearth -- node $PWD/hearth-mcp.mjs --project <your game>
```

The same two files are bundled inside the desktop app, and the editor's
agent-setup panel shows their exact paths ready to copy.

## Quick start from source

Requires Node 20+.

```bash
git clone https://github.com/echoo19/hearth.git && cd hearth
npm install
npm run build:packages     # core → runtime → playtest → cli → mcp-server
npm test                   # full suite, headless
npm run dev                # editor at http://localhost:5173
```

Open an example from the launcher (try **Mini Platformer**) and press
**Play**. Arrows or WASD to move, Space to jump. For the desktop app,
`npm run app` launches it and `npm run app:dist` packages a real installer;
see [docs/desktop-app.md](docs/desktop-app.md).

## Try the agent loop

This is the workflow agents are taught, and it's pleasant by hand too:

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

To hook up Claude Code instead:

```bash
claude mcp add hearth -- node $PWD/packages/mcp-server/dist/main.js \
  --project $PWD/packages/examples/mini-platformer
```

Then ask it to call `get_agent_instructions`. Permission modes from
`--mode read-only` up to `--mode all` control what the agent may do; see
[docs/mcp.md](docs/mcp.md).

## Examples

Seven example projects live in `packages/examples`, every one generated
through the command system itself and covered by playtests in CI. They
range from a mini platformer and a visual novel up to all-Lua showcases:
**Ember Trail** (scene switching, timers, saved best score), **Glow Caves**
(lighting and particles in a torch-lit cave), **Bounce Patrol** (physics
layers and a pathfinding patroller), and **Sky Courier** (a sliced pixel-art
spritesheet, streamed chiptune music, and an imported font). They double as
reference projects: everything the docs describe, one of them does.

## Documentation

| | |
| --- | --- |
| [Quickstart](docs/quickstart.md) | Install → first game in ten minutes |
| [Desktop app](docs/desktop-app.md) | Electron packaging, native folder dialogs |
| [CLI guide](docs/cli.md) | Every command, plus the JSON envelope |
| [MCP guide](docs/mcp.md) | Connecting agents, permission modes |
| [Agent workflow](docs/agents.md) | How agents should operate, and why |
| [Architecture](docs/architecture.md) | Packages, command system, data flow |
| [Project format](docs/project-format.md) | Every file, every schema |
| [Components](docs/components.md) | All 14 component types and their defaults |
| [Assets](docs/assets.md) | Import, spritesheets, animations, music, fonts |
| [Scripting](docs/scripting.md) | Lua and JS, the full `ctx` API |
| [Web export](docs/export.md) | Static builds, single-file, itch.io |
| [Roadmap](docs/roadmap.md) | What's next, and what's honestly missing |
| [Contributing](CONTRIBUTING.md) | Dev setup and the AI contribution policy |

## Design principles

1. **The engine works without AI.** Agents are a first-class client, but
   nothing in the engine depends on them.
2. **One command system.** If it isn't a registered command, neither the UI
   nor agents can do it, so capabilities stay legible and auditable.
3. **Humans stay in charge.** Permission modes gate what agents may touch,
   snapshots and structural diffs make every agent session reviewable and
   revertible, and playtests make "it works" checkable.
4. **Local-first, readable files.** Projects are JSON you can diff, art you
   can open in anything, and plain Lua or JavaScript scripts.

## License

[MIT](LICENSE). Dependencies are all open-source-friendly: zod, commander,
PixiJS, React, wasmoon, and the MCP SDK.
