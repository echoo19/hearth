<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/readme-banner-dark.svg">
  <img src="assets/brand/readme-banner-light.svg" alt="hearth" width="480">
</picture>

**An AI-native 2D game engine — a real editor for humans, and the whole engine as commands your coding agent already knows how to use.**

[Website](https://hearthengine.com) · [Download](https://github.com/echoo19/hearth/releases/latest) · [Quickstart](docs/quickstart.md) · [Docs](#documentation) · [Feedback](https://hearthengine.com/feedback)

[![CI](https://img.shields.io/github/actions/workflow/status/echoo19/hearth/ci.yml?label=CI)](https://github.com/echoo19/hearth/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/echoo19/hearth)](https://github.com/echoo19/hearth/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

Hearth is a real engine, not an AI game generator. Humans get a normal visual
editor. Coding agents (Claude Code, Codex, OpenCode with local models, any MCP
client) get the entire editor surface as structured, validated,
permission-checked commands, and they arrive already knowing how to use it:
a per-project skill teaches the working loop and game-feel craft, headless
playtests and screenshots let an agent *prove* its work runs, and every
command lands in a disk-backed journal you can read and revert. No AI runs
inside the engine, nothing needs an API key or a cloud account, and your
project is a folder of readable JSON, scripts, and assets on your own disk.

```
   Human ──▶ Editor UI ──┐
                         ├──▶  one shared command system  ──▶  project files
   Agent ──▶ CLI / MCP ──┘      (validate · execute · diff)     scenes · scripts · assets
```

The connection is plumbing; the point is the loop it enables. An agent
snapshots the project, inspects what's there, builds a level, wires input,
writes behavior scripts, imports and slices art, runs a deterministic headless
playtest to check it actually works, and hands you a structural diff to review
in the editor, all without guessing at file formats. You stay in charge:
permission modes gate what agents may touch, every session can be snapshotted,
diffed, and reverted, and every command any agent runs, whether from the CLI,
MCP, or the editor's embedded terminal, is journaled (`hearth log`, or live in
the editor's Agent panel).

## Coding with your agent in minutes

The fastest path, no build step:

**1. Get Hearth.** [Download the desktop app](https://github.com/echoo19/hearth/releases/latest)
(macOS/Windows/Linux), or grab the two standalone agent files (Node 20+):

```bash
curl -LO https://github.com/echoo19/hearth/releases/latest/download/hearth-cli.mjs
curl -LO https://github.com/echoo19/hearth/releases/latest/download/hearth-mcp.mjs
```

**2. Scaffold a game.** `hearth init` (or `node hearth-cli.mjs init`) writes a
small playable project (a scene with a camera, ground, and a player that
already falls and lands) plus an `AGENTS.md` and a project skill any agent
that visits will read:

```bash
node hearth-cli.mjs init "Star Catcher" --template platformer
```

**3. Point your agent at it.** In the desktop app, open the project, focus the
Agent panel, and type `claude`, `codex`, `opencode`, `hermes`, or another agent
command. The terminal starts at the project root with `hearth` already on PATH.
MCP is optional; connect it by hand when you want typed tools:

```bash
claude mcp add hearth -- node $PWD/hearth-mcp.mjs --project $PWD/star_catcher
```

Then describe the game. The agent calls `get_agent_instructions`, follows the
snapshot → inspect → edit → validate → playtest → diff loop from its skill, and
hands you changes to review. Per-agent walkthroughs:
[Claude Code](docs/connect-claude-code.md), [Codex](docs/connect-codex.md),
[OpenCode + Ollama (local models)](docs/connect-opencode.md),
[Hermes](docs/connect-hermes.md), and
[any MCP client or CLI](docs/connect-any-agent.md).

**4. See it and ship it.** Open the folder in the editor, press **Play**, then
`hearth export web --zip --allow build` for an itch.io-ready build or
`hearth export desktop --allow build` for a native app. See the
[Quickstart](docs/quickstart.md) for the full
ten-minute version.

## What's in the engine

**Runtime.** A fixed-timestep, deterministic 2D runtime: sprites and
spritesheets, tilemaps with auto-generated colliders and 47-blob autotiling,
text, 2D lighting, polylines, deterministic particles, sprite animation plus
animation state machines, gamepad input with analog virtual axes, camera
effects (shake/flash/fade/zoom punch), a screen-space post-processing stack
(bloom/CRT/vignette/chromatic-aberration/pixelate/color-grade, up to 8 stacked)
plus per-sprite outline/hit-flash/dissolve effects, and screen-space game UI
with layout containers, sliders, toggles, and focus navigation. Physics covers
mass, restitution, friction, named collision layers, one-way platforms, and
box/circle/convex-polygon colliders. Audio includes sound effects, procedural
synthesis, and a streamed music channel that survives scene switches. The same
runtime runs in the editor preview, headlessly in Node, and in exported games,
including every post-processing/sprite effect. See
[docs/effects.md](docs/effects.md).

**Scripting.** Lua by default (sandboxed, seed-deterministic), JavaScript
equally supported, both against the same `ctx` API: timers, tweens, seeded RNG,
pub/sub events, math helpers, grid pathfinding, camera control and effects,
per-sprite hit-flash, animation state machine control, UI focus, save data, and
scene switching for building your own menus. `hearth inspect api` prints the
whole surface, the editor's Code panel autocompletes off that same reference,
and `check-script` syntax-checks a draft before you save it. See
[docs/scripting.md](docs/scripting.md).

**Editor.** A dockable workspace: scene view with tilemap paint tool and
direct-manipulation transform handles, hierarchy with "Save as prefab", a
schema-driven inspector (typed pickers and enum dropdowns for every field, no
raw JSON textareas), an Animator editor for state-machine assets, an asset
browser with spritesheet slicing and whole-folder drag-drop import, live
preview with Pause/Step, a Code panel, a read-only Live runtime inspector,
console, Input and Game Settings panels, undo/redo with a history panel, a
plain-language Checkpoint/Review/Changes loop for agent sessions, and an
**Agent panel**: a real embedded project terminal where you run your own agent
CLI, with `hearth` already on PATH, a live activity timeline, and
Checkpoint/Review/Revert one click away (see
[docs/agent-panel.md](docs/agent-panel.md)). The editor
live-follows changes from any *external* agent session, whether CLI, MCP, or
another editor, reloading automatically instead of going stale, and its local
project server enforces Origin/Host on every request. Runs in the browser during
development or as a packaged desktop app (see [docs/editor.md](docs/editor.md)).

**Agent tooling.** The `hearth` CLI wraps every command with `--json`
envelopes, including `undo`/`redo`/`history` and `log` (the disk-backed command
journal). Property writes validate the full dot-path against the component's
real schema, with a did-you-mean suggestion on a typo instead of silently
corrupting the write. The engine's command registry has **76 commands**; the
MCP server exposes **78 typed tools** with per-session permission modes:
**75 wrapping a core command**, plus `screenshot`, `capture`, and
`get_agent_instructions`.
Playtests script input (including gamepad axes and pointer drags) and assert on
game state, events, particles, audio, camera effects, post effects, and UI
focus, entirely headless and CI-friendly. `hearth screenshot` renders real
frames through headless Chromium so agents can see their own work. See
[docs/cli.md](docs/cli.md) and [docs/mcp.md](docs/mcp.md).

**Prefabs.** Reusable, live-linked entity templates: serialize a subtree into a
prefab asset, place instances, edit an instance and the change records as a
per-instance override automatically, push a change back and every other
instance auto-syncs (merging each instance's own overrides rather than
discarding them), or revert one field/component/instance. CLI, MCP, and editor
all the way through; scripts spawn prefabs live with `ctx.scene.spawnPrefab`.
See [docs/prefabs.md](docs/prefabs.md).

**Export.** `hearth export web` produces a static, self-contained build (one
folder, one HTML file, or an itch.io zip) that boots straight into your first
scene. `hearth export desktop` wraps the same build in a hardened Electron
shell and zips a native app per platform (macOS arm64/x64, Windows, Linux). No
engine splash, no branding, nothing of Hearth's chrome ships in your game. See
[docs/export.md](docs/export.md), [docs/ship-web-hosting.md](docs/ship-web-hosting.md),
[docs/shipping-to-itch.md](docs/shipping-to-itch.md), and
[docs/ship-desktop.md](docs/ship-desktop.md).

**Procedural placeholders.** Agents can create deterministic SVG sprites and
WAV sound effects through commands, so a game is playable and audible before
any real assets exist. Real art, sound, music, and fonts come in through the
same asset pipeline: import, probe, slice, animate.

## Status

Hearth is at **v1.2.0**. Version 1.0 shipped on 2026-07-15, so this is no
longer a developer preview. The whole loop works end to end: project model,
editor, runtime preview, CLI, MCP, headless playtests, diff review, and web
and desktop export. Everything since 1.0 has been additive. v1.1.0 added
script modules, so scripts can `require()` each other in both Lua and
JavaScript; a library is just a script that returns a table or exports an
object, and hot-reload recompiles whatever depended on the file you changed.
v1.2.0 gave the Agent panel its own full-height dock on the right beside the
Inspector. It now opens a project shell directly; a compact first-project guide
explains how to type an agent command and can be dismissed. The Activity
timeline collapses under the terminal. The
[roadmap](docs/roadmap.md) keeps an honest list of what's next.

## Install

**Desktop app.** Grab it from the
[latest release](https://github.com/echoo19/hearth/releases/latest): macOS
(`Hearth-mac-arm64.dmg` / `Hearth-mac-x64.dmg`), Windows
(`Hearth-win-x64.exe`), Linux (`Hearth-linux-x86_64.AppImage` /
`Hearth-linux-amd64.deb`). On macOS, first launch is right-click → Open (macOS
14 and earlier) or System Settings → Privacy & Security → Open Anyway (macOS
15+); if macOS claims the app is damaged, run `xattr -cr /Applications/Hearth.app`
(desktop builds are ad-hoc signed, not notarized yet, see
[docs/desktop-app.md](docs/desktop-app.md)).

**Agent tools, no install.** The CLI and MCP server ship as single files that
only need Node 20+:

```bash
curl -LO https://github.com/echoo19/hearth/releases/latest/download/hearth-cli.mjs
curl -LO https://github.com/echoo19/hearth/releases/latest/download/hearth-mcp.mjs
node hearth-cli.mjs --help
claude mcp add hearth -- node $PWD/hearth-mcp.mjs --project <your game>
```

The same two files are bundled inside the desktop app, and the editor's
agent-setup panel shows their exact paths ready to copy.

## The agent loop by hand

The workflow agents are taught is pleasant to run yourself:

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

Permission modes from `--mode read-only` up to `--mode all` control what an
agent may do; see [docs/mcp.md](docs/mcp.md).

## Documentation

Organized as a journey: get started, build, script, ship, connect an agent,
reference.

| | |
| --- | --- |
| **Get started** | |
| [Quickstart](docs/quickstart.md) | Install → first game in ten minutes |
| [Desktop app](docs/desktop-app.md) | Electron packaging, native folder dialogs |
| [Editor guide](docs/editor.md) | Chrome, shortcuts, transform handles, Code/Live/Animator panels |
| **Build** | |
| [Components](docs/components.md) | All component types and their defaults |
| [Prefabs](docs/prefabs.md) | Reusable templates, live-link merge sync, `ctx.scene.spawnPrefab` |
| [Assets](docs/assets.md) | Import (incl. bulk/folder), spritesheets, animations, music, fonts |
| [Effects](docs/effects.md) | `Camera.postEffects`, `SpriteEffects`, determinism |
| [Input](docs/input.md) | Actions, keyboard, gamepad, virtual axes |
| [UI](docs/ui.md) | Widgets, layout, focus navigation |
| **Script** | |
| [Scripting](docs/scripting.md) | Lua and JS, the full `ctx` API, animation state machines |
| **Ship** | |
| [Export](docs/export.md) | Web (static/single-file) and desktop (Electron, signing) builds |
| [Hosting a web build](docs/ship-web-hosting.md) | Your own domain, static hosts, iframe embeds |
| [Shipping to itch.io](docs/shipping-to-itch.md) | Web zip upload, desktop channel zips, butler |
| [Distributing a desktop game](docs/ship-desktop.md) | Unsigned-build honesty: Gatekeeper, SmartScreen, signing |
| **Agents** | |
| [Agent panel](docs/agent-panel.md) | Embedded terminal, subscription safety, external-change model |
| [Agent workflow](docs/agents.md) | How agents should operate, and why |
| [CLI guide](docs/cli.md) | Every command, plus the JSON envelope |
| [MCP guide](docs/mcp.md) | Connecting agents, permission modes |
| [Connect Claude Code](docs/connect-claude-code.md) | Project shell + manual MCP setup |
| [Connect Codex](docs/connect-codex.md) | `codex mcp add`, `config.toml` |
| [Connect OpenCode + Ollama](docs/connect-opencode.md) | Local models, end to end |
| [Connect Hermes](docs/connect-hermes.md) | Running a Hermes model against Hearth |
| [Connect any agent](docs/connect-any-agent.md) | Canonical MCP config + shell-only loop |
| **Reference** | |
| [Project format](docs/project-format.md) | Every file, every schema |
| [Architecture](docs/architecture.md) | Packages, command system, data flow |
| [Performance](docs/performance.md) | Benchmark harness, published numbers |
| [Roadmap](docs/roadmap.md) | What's next, and what's honestly missing |
| [Contributing](CONTRIBUTING.md) | Dev setup and the AI contribution policy |
| [Feedback](https://hearthengine.com/feedback) | Report a bug, request a feature, ask a question |

## Design principles

1. **The engine works without AI.** Agents are a first-class client, but
   nothing in the engine depends on them.
2. **One command system.** If it isn't a registered command, neither the UI
   nor agents can do it, so capabilities stay legible and auditable.
3. **Humans stay in charge.** Permission modes gate what agents may touch,
   snapshots and structural diffs make every agent session reviewable and
   revertible, and playtests make "it works" checkable.
4. **Local-first, readable files.** Projects are JSON you can diff, art you can
   open in anything, and plain Lua or JavaScript scripts.

## Contributing & building from source

Requires Node 20+.

```bash
git clone https://github.com/echoo19/hearth.git && cd hearth
npm install
npm run build:packages     # core → runtime → playtest → shipping → templates → cli → mcp-server
npm test                   # full suite, headless
npm run typecheck          # vitest does not typecheck; run this too
npm run dev                # editor at http://localhost:5173
```

Open an example from the launcher (try **Mini Platformer**) and press **Play**
(arrows/WASD to move, Space to jump). For the desktop app, `npm run app`
launches it and `npm run app:dist` packages an installer; see
[docs/desktop-app.md](docs/desktop-app.md). Eleven example projects live in
`packages/examples`, every one generated through the command system itself and
covered by playtests in CI. They double as reference projects for everything
the docs describe. Ground rules and the AI contribution policy are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Dependencies are all open-source-friendly: zod, commander,
PixiJS, React, wasmoon, and the MCP SDK.
