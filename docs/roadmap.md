# Hearth Roadmap

v0.3 is the current milestone. Its first release, v0.3.0 (shipped, below),
made Lua the first-class scripting language, added scene management and a
script stdlib, and removed every trace of engine chrome from exported games.
On top of v0.2's dockable editor workspace, screen-space game UI, polygon
colliders, working audio with procedural sound effects, and production
web export — and v0.1's full human+agent loop (editor ⇄ command system ⇄
CLI/MCP ⇄ runtime ⇄ playtests ⇄ diff review). This page is the honest
list of what's next and what's deliberately missing.

The standing rule for everything below: **agent-native first**. Each system
ships as schemas + commands (inspectable via `hearth … --json`, exposed as
MCP tools, testable in headless playtests) before it gets editor UI.

## Shipped in v0.3.0

- **Lua scripting, first-class**: `hearth create script` emits Lua by
  default (`--language js` keeps JavaScript, which remains fully
  supported); the same sandboxed Lua 5.4 VM (wasmoon) runs in the editor
  preview, headless playtests, and exported games, with the identical
  `ctx` API in both languages.
- **Scene management + script stdlib v1**: `ctx.scenes.load` (user-built
  menus/start screens), `ctx.timers`, `ctx.tweens`, seeded `ctx.random`,
  persistent `ctx.save`/`ctx.load`, and `ctx.camera` control — one
  deterministic surface, documented via `hearth inspect api`.
- **No-chrome export**: shipped games boot straight into the initial
  scene; loading visuals come from `buildSettings.loading` (reachable via
  the new `updateSettings` command); audio unlocks silently on the first
  natural input. Zero Hearth branding anywhere a player can see.
- **Structured script diagnostics**: `hearth validate` reports script
  syntax errors with file + line for both languages.
- Playtests gained `seed`, `click`, and `assertScene` steps; the all-Lua
  `ember-trail` example proves the whole stack headlessly.
- **Rendering v2**: `Light2D` + `Camera.ambientLight` (a lightmap pass that
  costs nothing when unused — existing projects with no lights render
  byte-identical to before), `LineRenderer` polylines, deterministic
  `ParticleEmitter`s (`ctx.particles.burst`/`count`, per-emitter `seed`, and
  the `assertParticleCount` playtest step), a toggleable debug-draw overlay
  (colliders, velocity vectors, light radii — off by default, never in
  exports), and `SpriteAnimator` playback (`ctx.animate`, frames from
  `createAnimationAsset`). The all-Lua `glow-caves` example exercises the
  whole set headlessly.
- **Screenshot capture for agents**: `hearth screenshot [scene] [--debug]`
  (and the MCP `screenshot` tool) renders a deterministic PNG via headless
  Chromium, so an agent can see its work.

## Shipped in v0.2

- Dockable editor workspace (drag tabs, splits, persisted layouts).
- Game UI: `UIElement` component (anchor + offset screen space,
  `interactive` + `onUiEvent` pointer events).
- Convex polygon colliders with SAT physics.
- Audio: `ctx.audio.play/stop`, functional `AudioSource` autoplay,
  `audioEvents` in headless run reports, and procedural sound effects
  (`hearth create sound --preset coin`).
- Web export: `hearth export web [--single-file] [--zip]` — static
  self-contained builds, itch.io-ready zips.

## Near term (later v0.3 releases)

- **Physics v2**: mass, restitution, friction on `PhysicsBody`; collision
  layers/masks; one-way platforms; circle-accurate resolution. The runtime
  stays deterministic (fixed timestep) — that's the playtest and
  future-multiplayer story.
- **Script standard library v2**: `ctx.math` (vec2 ops, clamp, color
  helpers) and `ctx.events` (global pub/sub with an `onEvent` hook;
  emitted events recorded in run reports so playtests can assert them),
  building on the v0.3.0 stdlib (scenes/timers/tweens/random/save/camera).
- **Undo/redo in the editor** (command journal; the diff baseline already
  proves the model).

## Medium term

- **Pathfinding**: grid A* over tilemap solids —
  `ctx.scene.findPath(from, to)` plus a CLI/MCP inspect surface so agents
  can reason about reachability without running a scene.
- **Asset pipeline v2**: spritesheet import + slicing, streamed long-form
  audio (music), font assets, editor thumbnails and bulk import.
- **UI widgets v2**: layout containers (stacks/anchor groups), sliders,
  toggles, focus + keyboard navigation — still composed from
  Text/SpriteRenderer rather than a parallel widget tree.
- **Desktop polish**: signed/notarized builds, custom app icon, auto-update.
- **TypeScript scripts** with a compile step and typed `ctx`.
- **Multi-instance components** (array form, `formatVersion: 2`).
- **MCP resources**: expose scenes/scripts as MCP resources (today:
  tools-only, which every client supports).
- **Prefabs**: reusable entity templates with overrides.

## Long term / research

- Multiplayer-friendly deterministic core (already fixed-timestep; needs
  input serialization + rollback investigation).
- Visual logic editor that round-trips to the same command system and
  generated scripts, so agents and humans edit the same artifact.
- Agent-facing "explain this scene" summaries (structured scene semantics
  rather than screenshots).
- Plugin/component SDK for third-party components with schema registration.
- Native executable export (per-platform player templates; web export
  covers distribution today).

## Non-goals (for now)

- Competing with Unity/Godot on 3D, shaders, or console targets.
- Built-in AI/LLM API calls. Agents connect **from outside** via MCP/CLI;
  the engine stays model-agnostic and fully usable offline.
- Cloud project storage. Projects are local files; use git.
- Concave polygon decomposition (split concave colliders into convex
  pieces yourself) and audio mixing buses.
