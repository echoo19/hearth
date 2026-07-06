# Hearth Roadmap

v0.7 is the current milestone. Its first release, v0.7.0 (shipped,
below), added disk-backed undo/redo, gamepad input with virtual analog
axes, deterministic camera effects (shake/flash/fade/zoom punch), and a
second generation of UI widgets (`UILayout`/`UISlider`/`UIToggle`, focus
navigation). On top of v0.6's asset pipeline v2 (imported spritesheets
with typed frame slicing and sheet-backed animations, a single
crossfading music channel, real font assets) — v0.5's physics v2
(mass/restitution/friction, collision layers, one-way platforms,
circle-accurate resolution), script stdlib v2 (`ctx.math`,
`ctx.events`/`onEvent`), and pathfinding (`ctx.scene.findPath`, `hearth
inspect path`/`inspect_path`) — v0.4's 2D lighting, line
rendering, deterministic particles, sprite animation playback, a
debug-draw overlay, and screenshot capture for agents — v0.3's Lua-first
scripting, scene management, and chrome-free exports — v0.2's dockable
editor workspace, screen-space game UI, polygon colliders, working audio
with procedural sound effects, and production web export — and v0.1's
full human+agent loop (editor ⇄ command system ⇄ CLI/MCP ⇄ runtime ⇄
playtests ⇄ diff review). This page is the honest list of what's next and
what's deliberately missing.

The standing rule for everything below: **agent-native first**. Each system
ships as schemas + commands (inspectable via `hearth … --json`, exposed as
MCP tools, testable in headless playtests) before it gets editor UI.

## Shipped in v0.7.0

- **Undo/redo**: every mutating command (except `undo`/`redo`/
  `revertProject`/`snapshotProject` themselves) is captured into a
  disk-backed, 25-entry history under `.hearth/history/` — `undo`/`redo`/
  `listHistory` commands, `hearth undo|redo|history` on the CLI, `undo`/
  `redo`/`list_history` MCP tools, and Cmd+Z / Shift+Cmd+Z / Cmd+Y plus a
  History section in the editor's Diff panel. Independent of `snapshot`/
  `revert`'s single diff baseline — this steps through individual
  changes. Asset files removed with `deleteFile: false` are left alone by
  `undo`, but a subsequent `redo` moves the still-on-disk file into
  `.hearth/trash/` so disk stays consistent with the model (round-trip
  safe — the matching undo pulls it back out).
- **Gamepad input + virtual axes**: `inputMappings` gains named gamepad
  buttons (`a`/`b`/`x`/`y`/`lb`/`rb`/`lt`/`rt`/`back`/`start`/`ls`/`rs`/
  `dpad-*`), digital gamepad-axis-crossed-a-threshold bindings, and
  virtual analog axes (`ctx.input.axis(name)`, `-1..1`, gamepad stick or
  keyboard fallback, per-axis or global deadzone). Browser-only (the
  Gamepad API doesn't exist headlessly); playtests drive axes directly
  with the `setAxis` step. CLI `set-settings --input-gamepad-buttons/
  --input-gamepad-axes/--input-axes/--input-deadzone`, matching MCP
  `update_settings` fields, and an editor Input panel (key capture,
  gamepad dropdowns, axis rows). See [input.md](./input.md).
- **Camera effects**: `ctx.camera.shake/flash/fade/zoomPunch`, all
  deterministic (seeded shake) and last-call-wins per kind; `fade` is
  persistent and carries across scene switches. The `assertCameraEffect`
  playtest step counts calls per effect kind; results expose
  `cameraEffects` and `cameraOverlayAlpha`.
- **UI widgets v2**: `UILayout` (stacking containers), `UISlider`,
  `UIToggle`, `UIElement.focusable`, and a full keyboard/gamepad focus
  system (`ctx.ui.focus/getFocused/moveFocus/activate/adjust`).
  `onUiEvent`'s `type` union grows to `click|press|release|enter|exit|
  drag|change|focus|blur` with an optional `value`. Playtest steps
  `drag`/`assertFocus`. See [ui.md](./ui.md).
- The all-Lua `drift-cellar` example (the 8th) exercises the whole set:
  analog drift movement, wall-bump shake/flash, a gem run with a fade
  transition, and a pause menu with a focus-navigable slider and toggle.
- Editor: enum dropdowns everywhere a schema field is a fixed set of
  string values, replacing free-text/raw-JSON entry in the Inspector.

## Shipped in v0.6.0

- **Asset pipeline v2**: `importAsset` probes real image dimensions
  (PNG/JPEG/GIF/WebP/SVG) into `metadata`; `sliceSpritesheet` cuts an
  imported spritesheet into a named, typed frame grid stored on the
  asset itself (`metadata.frames`/`metadata.grid`), and
  `createAnimationFromSheet` builds animation assets from those frames
  (`<sheetAssetId>#<frameName>` refs); `SpriteRenderer.frame` draws a
  sliced frame instead of the whole texture, and every textured sprite
  is now tintable via its existing `color` field (default `#ffffff` is a
  no-op, so nothing existing changes color). See
  [architecture.md](./architecture.md#asset-pipeline) for the
  metadata/accessor design and [assets.md](./assets.md) for the full
  guide.
- **Music**: a single shared, crossfading music channel —
  `ctx.audio.playMusic`/`stopMusic`/`setMusicVolume`, `AudioSource.music`
  for scene-start autoplay, survives `ctx.scenes.load` scene switches,
  streamed through a real `<audio>` element in the browser host rather
  than fully decoded up front — plus the `assertAudioCount` playtest step
  (filter by asset/action/music, checked against equals/min/max).
- **Fonts**: `.ttf`/`.otf`/`.woff`/`.woff2` import as `font` assets,
  loaded via `FontFace` at mount and registered under exactly the
  asset's name, so `Text.fontFamily` references an imported font like
  any other asset name — no `@font-face` CSS to hand-write.
- Editor: a spritesheet slicing dialog and asset-browser thumbnails
  (frame grids, font samples, animation previews), plus `Text.fontFamily`
  and `SpriteRenderer.frame` pickers in the Inspector.
- The all-Lua `sky-courier` example is the first built from **imported
  binary assets** rather than procedural SVGs: a sliced PNG walk/idle
  spritesheet, a streamed WAV music loop, and an imported `.ttf` HUD
  font.

## Shipped in v0.5.0

- **Physics v2**: `mass`/`restitution`/`friction` on `PhysicsBody`
  (restitution/friction combine per contact pair by taking the max of both
  sides; restitution is suppressed below a 20 px/s incoming speed to kill
  micro-bounce jitter), named collision layers (`Collider.layer`/
  `collidesWith`, both sides must list each other, `'*'` matches any),
  one-way platforms (`Collider.oneWay`), and circle-accurate collision
  resolution (true circle-circle/circle-box/circle-polygon MTV, not
  bounding-box). Still a positional resolver deriving velocity response
  from the MTV normal, not an impulse solver — see
  [architecture.md](./architecture.md#physics-response).
- **Script stdlib v2**: `ctx.math` (16 pure vec2/color helpers — add, sub,
  scale, normalize, lerp, hex/RGB conversion, …) and `ctx.events`/`onEvent`
  (synchronous, deterministic pub/sub; an 8-deep recursion guard;
  subscriptions auto-removed when their owning entity is destroyed; the
  `assertEventCount` playtest step plus `events`/`eventCounts` in run
  reports).
- **Pathfinding**: deterministic grid A\* — `ctx.scene.findPath(from, to,
  opts?)` in scripts, `hearth inspect path` on the CLI, and the
  `inspect_path` MCP tool, all resolving to the same core module so an
  offline query matches what a running script gets.
- The all-Lua `bounce-patrol` example exercises the whole set headlessly:
  a bouncy ball, friction-contrasted floor strips, a one-way ledge, a
  findPath-chasing kinematic patroller, and coin pickups driving a
  `ctx.events`-based score UI.

## Shipped in v0.4.0

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
- Editor: gizmos for every new component (light radius, line points,
  particle emitter bounds, animator frame preview), a uniform Vec2
  point-list Inspector control (used by `LineRenderer` and colliders
  alike, replacing raw JSON editing), and a preview debug-draw toggle.

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

## Near term (later v0.7 releases)

- **Bulk asset import**: `importAsset` is one file per call today;
  a multi-file/folder import command is the natural follow-up.
- **Finer-grained editor undo**: today's undo/redo is whole-command
  (one entry per `execute()` call); an in-progress drag or text edit is
  one undo step, which is the right granularity for most operations but
  worth revisiting for continuous ones (Inspector number-drag, slider
  scrubbing) if it turns out too coarse in practice.

## Medium term

- **Desktop polish**: signed/notarized builds, custom app icon, auto-update.
- **TypeScript scripts** with a compile step and typed `ctx`.
- **Multi-instance components** (array form, `formatVersion: 2`).
- **MCP resources**: expose scenes/scripts as MCP resources (today:
  tools-only, which every client supports).
- **Prefabs**: reusable entity templates with overrides.
- **Scale/performance**: no profiling or stress-testing has been done yet
  on large scenes (hundreds of entities, big tilemaps) — the runtime is
  correctness-first so far, not benchmarked.

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
