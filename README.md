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

Both audiences use the same 65 engine commands: `createEntity`,
`setComponentProperty`, `runPlaytest`, `getDiff`, and so on. An agent can
build a level, wire input, write behavior scripts, import and slice art, run
headless playtests, and hand you a structural diff to review in the editor,
all without guessing at file formats. You stay in charge the whole way:
permission modes gate what agents may touch, every session can be
snapshotted, diffed, and reverted, and every command any agent runs — CLI,
MCP, or the editor's own embedded terminal — lands in a disk-backed journal
you can read as `hearth log` or watch live in the editor's Agent panel.

## What's in the engine

**Runtime.** A fixed-timestep, deterministic 2D runtime: sprites and
spritesheets, tilemaps with auto-generated colliders, text, 2D lighting,
polylines, deterministic particles, sprite animation, gamepad input with
analog virtual axes, camera effects (shake/flash/fade/zoom punch), a
screen-space post-processing stack (bloom/CRT/vignette/chromatic-
aberration/pixelate/color-grade, up to 8 stacked) plus per-sprite outline/
hit-flash/dissolve effects, and screen-space game UI with layout
containers, sliders, toggles, and focus navigation. Physics covers mass,
restitution, friction, named collision layers, one-way platforms, and
box/circle/convex-polygon colliders. Audio includes sound effects,
procedural synthesis, and a streamed music channel that survives scene
switches. The same runtime runs in the editor preview, headlessly in Node,
and in exported games — including every post-processing/sprite effect, see
[docs/effects.md](docs/effects.md).

**Scripting.** Lua by default (sandboxed, seed-deterministic), JavaScript
equally supported, both against the same `ctx` API: timers, tweens, seeded
RNG, pub/sub events, math helpers, grid pathfinding, camera control and
effects, a per-sprite hit-flash (`ctx.effects.flash`), UI focus, save data,
and scene switching for building your own menus. `hearth inspect api`
prints the whole surface, and the editor's Code panel autocompletes
straight off that same reference. `checkScript` (CLI `check-script`, MCP
`check_script`) syntax-checks a draft before you save it.

**Editor.** A dockable workspace with a scene view (tilemap paint tool,
plus direct-manipulation transform handles — 8 resize + 1 rotate handle on
the current selection, always one undo step per gesture), hierarchy (with a
"Save as prefab" action), schema-driven inspector (enum dropdowns and typed
pickers for every fixed-choice or asset-reference field, including a
dedicated post-effects stack editor — no raw JSON textareas anywhere), asset
browser with spritesheet slicing, previews, and prefab cards ("Add to
scene" / "Sync instances"), live game preview with Pause/Step for
frame-by-frame debugging, a Code panel (lazy-loaded CodeMirror, `ctx.`
autocomplete, inline lint), a Live panel (a read-only runtime inspector:
live transform/velocity/timers/tweens/events for any entity while playing),
console, an Input settings panel (key capture, gamepad bindings), visible
toolbar Undo/Redo plus a history panel, a scene menu
(duplicate/rename/set-initial/delete), a plain-language
Checkpoint/Review/Changes review loop for agent sessions, a
keyboard-shortcut cheat sheet (`?`, driven by one keybind registry), and an
**Agent panel**: a real embedded terminal running your own `claude` CLI,
wired to the project via MCP, with a live activity timeline and
Checkpoint/Review/Revert one click away (see
[docs/agent-panel.md](docs/agent-panel.md)). The editor also live-follows
changes from any *external* agent session — CLI, MCP, or another editor —
reloading automatically instead of going stale, and its local project
server enforces Origin/Host on every request so a random webpage can't
drive it. Runs in the browser during development or as a packaged desktop
app (Electron) with native folder dialogs.

**Agent tooling.** The `hearth` CLI wraps every command with `--json`
envelopes, including `undo`/`redo`/`history` and `log` (a disk-backed
journal of every command any session has run). Property writes
(`set`/`set-many`, MCP `set_component_property`/`set_properties`) validate
the full dot-path against the component's real schema shape, with a
did-you-mean suggestion on a typo instead of silently corrupting the write.
The MCP server exposes 64 typed tools with per-session permission modes.
Playtests script input (including gamepad axes and pointer drags) and
assert on game state, events, particles, audio, camera effects, post
effects, and UI focus, entirely headless and CI-friendly. `hearth
screenshot` renders real frames through headless Chromium so agents can
see their own work.

**Prefabs.** Reusable entity templates: serialize any entity's subtree into
a prefab asset (`createPrefab`/`hearth prefab create`), place tracked
instances of it (`instantiatePrefab`/`hearth prefab place`), push edits
back onto the asset (`updatePrefab`), and propagate them to every existing
instance on demand (`syncPrefabInstances`) — CLI, MCP, and editor surfaces
all the way through. Scripts spawn prefabs live with
`ctx.scene.spawnPrefab`. See [docs/prefabs.md](docs/prefabs.md).

**Export.** `hearth export web` produces a static, self-contained build
(one folder, one HTML file, or a zip for itch.io) that boots straight into
your first scene. No engine splash screen, no branding, nothing of Hearth's
chrome ships in your game.

**Procedural placeholders.** Agents can create deterministic SVG sprites and
WAV sound effects through commands, so a game is playable and audible before
any real assets exist. Real art, sound, music, and fonts come in through the
same asset pipeline: import, probe, slice, animate.

## Status

Hearth is at **v0.10.0**, a developer preview. The full loop works end to
end: project model, editor, runtime preview, CLI, MCP, headless playtests,
diff review, web export. This release, "Write & See," added a full
**post-processing system** — `Camera.postEffects` (bloom/CRT/vignette/
chromatic-aberration/pixelate/color-grade, up to 8 stacked, rendered as
hand-written Pixi filters) and per-sprite `SpriteEffects`
(outline/hit-flash/dissolve, `ctx.effects.flash`), both scriptable,
testable (`assertPostEffect`), and typed end to end (a dedicated
`PostEffectsField` Inspector control, no raw JSON) — plus an editor **Code
panel** (lazy CodeMirror, `ctx.` autocomplete, inline lint), a **Live
panel** and **Pause**/**Step** for frame-by-frame runtime inspection,
stricter property-path validation with did-you-mean suggestions, a
`checkScript` pre-flight command, Origin/Host enforcement on the local
project server, and an editor bundle code-split — on top of earlier
releases' prefabs, embedded agent panel, disk-backed command journal,
published performance numbers, scene management, tilemap editing, undo/
redo, gamepad input, camera effects, UI widgets, asset pipeline, physics
v2, pathfinding, 2D lighting and particles, and Lua scripting. The
[roadmap](docs/roadmap.md) keeps an honest list of what's still missing,
including bulk asset import and notarized desktop builds.

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

Ten example projects live in `packages/examples`, every one generated
through the command system itself and covered by playtests in CI. They
range from a mini platformer and a visual novel up to all-Lua showcases:
**Ember Trail** (scene switching, timers, saved best score), **Glow Caves**
(lighting and particles in a torch-lit cave), **Bounce Patrol** (physics
layers and a pathfinding patroller), **Sky Courier** (a sliced pixel-art
spritesheet, streamed chiptune music, and an imported font), **Drift
Cellar** (analog gamepad movement, camera shake/flash/fade, and a
focus-navigable pause menu with a slider and toggle), **Ember Horde**
(a survivors-like horde of hundreds of concurrent pathing enemies, pooled
hit-spark particles, and camera shake — the playable proof behind
[docs/performance.md](docs/performance.md)'s numbers), and **Ember Arcade**
(a `Camera.postEffects` stack, `ctx.effects.flash` hit reactions, and a
seeded dissolve death animation — the playable proof behind
[docs/effects.md](docs/effects.md)). They double as reference projects:
everything the docs describe, one of them does.

## Documentation

| | |
| --- | --- |
| [Quickstart](docs/quickstart.md) | Install → first game in ten minutes |
| [Desktop app](docs/desktop-app.md) | Electron packaging, native folder dialogs |
| [CLI guide](docs/cli.md) | Every command, plus the JSON envelope |
| [MCP guide](docs/mcp.md) | Connecting agents, permission modes |
| [Agent panel](docs/agent-panel.md) | Embedded terminal, subscription safety, external-change model |
| [Agent workflow](docs/agents.md) | How agents should operate, and why |
| [Architecture](docs/architecture.md) | Packages, command system, data flow |
| [Project format](docs/project-format.md) | Every file, every schema |
| [Components](docs/components.md) | All 18 component types and their defaults |
| [Effects](docs/effects.md) | `Camera.postEffects`, `SpriteEffects`, `ctx.effects.flash`, determinism |
| [Prefabs](docs/prefabs.md) | Reusable entity templates, tracked-stamp sync, `ctx.scene.spawnPrefab` |
| [Assets](docs/assets.md) | Import, spritesheets, animations, music, fonts |
| [Scripting](docs/scripting.md) | Lua and JS, the full `ctx` API |
| [Input](docs/input.md) | Actions, keyboard, gamepad, virtual axes |
| [UI](docs/ui.md) | Widgets, layout, focus navigation |
| [Editor guide](docs/editor.md) | Chrome, keyboard shortcuts, transform handles, Code/Live panels |
| [Performance](docs/performance.md) | Benchmark harness, published numbers, honest guidance |
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
