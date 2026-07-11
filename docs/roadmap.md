# Hearth Roadmap

v0.10 is the current milestone. Its first release, v0.10.0 (shipped,
below, "Write & See"), added a **Code panel** in the editor (lazy-loaded
CodeMirror 6, `ctx.` autocomplete driven by the same `CTX_API` the docs and
`hearth inspect api` use, inline `checkScript` lint, external-change
follow), a **Live panel** (read-only 10Hz runtime inspector: entity
transform/velocity/timers/tweens/recent events) plus toolbar **Pause**/
**Step** for frame-by-frame inspection, a full **post-processing system**
(`Camera.postEffects` — bloom/CRT/vignette/chromatic-aberration/pixelate/
color-grade, up to 8 stacked, rendered as hand-written Pixi filters — and
per-sprite `SpriteEffects` outline/hit-flash/dissolve, `ctx.effects.flash`,
the `assertPostEffect` playtest step), a typed `PostEffectsField` Inspector
control (no raw JSON for the new array field, same as everywhere else) and
a fix making a corner transform-drag on a sprite/collider commit as one
undo step instead of two (via the new `setProperties` batch command),
stricter property-path validation (`setComponentProperty`/`setProperties`
now reject an unknown dot-path segment with a did-you-mean suggestion
instead of silently succeeding against a throwaway key), a `checkScript`
command/CLI/MCP tool for pre-flighting a script without saving it,
Origin/Host enforcement on the local project server's `/api/*` routes and
WebSocket upgrade (closing a DNS-rebinding-style hole where a hostile
webpage could otherwise drive the loopback dev server), a code-split
editor bundle (Terminal and the spritesheet Slice dialog now lazy-load
instead of shipping in the main chunk), and the 10th example, **Ember
Arcade**, exercising the whole post-effects/SpriteEffects set. Registry
grew 60 → 62 commands; MCP grew 59 → 61 tools. See
[effects.md](./effects.md), [editor.md](./editor.md), and
[scripting.md](./scripting.md).

On top of v0.9's **prefabs** (tracked-stamp reusable entity templates: create/
instantiate/update/sync, CLI + MCP parity, `ctx.scene.spawnPrefab`) and a
round of **editor friendliness** — plain-language chrome
(Checkpoint/Review/Changes), visible toolbar Undo/Redo, a keybind registry
with a `?` shortcut cheat sheet, and direct-manipulation transform handles
in the scene view. On top of v0.8's embedded agent panel (a real terminal
running the user's own `claude`, pre-wired to the project via MCP, with a
live trust timeline and Snapshot/Review/Revert), the disk-backed command
journal that made the editor live-follow any external agent, published
performance numbers plus the perf work (spatial-hash broadphase,
entity/tilemap caching, particle pooling) that makes them look good, and
scene-management/tilemap-editing ergonomics with a 9th example proving the
new scale ceiling — v0.7's disk-backed undo/redo, gamepad input with
virtual analog axes,
deterministic camera effects (shake/flash/fade/zoom punch), and a second
generation of UI widgets (`UILayout`/`UISlider`/`UIToggle`, focus
navigation) — v0.6's asset pipeline v2 (imported spritesheets
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

## Shipped in v0.10.0

- **Post-processing system**: `Camera.postEffects`, an array of up to 8
  screen-space filters (`bloom`, `crt`, `vignette`, `chromaticAberration`,
  `pixelate`, `colorGrade`), rendered in stack order as hand-written Pixi
  GLSL filters, cached per view and only rebuilt on a stack-shape change
  (param edits just refresh uniforms). Paired with per-sprite
  `SpriteEffects` (outline/hit-flash/dissolve — every field defaults to a
  no-op) and `ctx.effects.flash(color?, seconds?)` for a one-entity hit
  flash, deterministic linear decay, no RNG. The `assertPostEffect`
  playtest step checks presence of an effect type on the main camera. Both
  work identically in the editor preview, `hearth screenshot`, and exported
  games — no editor-only preview effect. See [effects.md](./effects.md).
- **Editor: Code panel**: a single-document script editor (CodeMirror 6,
  lazy-loaded so the CM6 chunk never lands in the main bundle until
  opened) with `ctx.` autocomplete generated from the same `CTX_API` array
  `hearth inspect api` and the docs use, inline `checkScript` lint, and
  external-change follow (a dirty buffer never gets silently overwritten —
  a conflict banner offers Reload/Keep mine instead).
- **Editor: Live panel + Pause/Step**: a read-only 10Hz runtime inspector
  (entity transform/velocity/timers/tweens/recent events, including
  runtime-spawned entities) alongside new toolbar **Pause** (freezes the
  running game in place) and **Step** (advances exactly one fixed frame
  while paused) controls, for frame-by-frame debugging.
  `SceneRuntime.getSchedulerSnapshot`/`stepFrame` back both.
- **`PostEffectsField` + one-undo corner drags**: a typed Inspector control
  for `Camera.postEffects` (per-effect cards, typed number/color fields,
  reorder, an 8-entry cap) — no raw JSON, ever. Also fixed: a corner
  transform-drag on a `SpriteRenderer`/box `Collider` (which edits two
  separate scalar fields) now commits as one undo step instead of two,
  using the new `setProperties` batch command internally.
- **Strict property paths + `setProperties` batch**: `setComponentProperty`
  and the new `setProperties` (set several dot-path properties on one
  entity in a single undo step, all-or-nothing validated; CLI `set-many`,
  MCP `set_properties`) both now reject an unknown dot-path segment with a
  did-you-mean suggestion and the valid-keys list, instead of Zod silently
  stripping it and corrupting the write. `hearth validate` also warns
  `UNKNOWN_COMPONENT_KEY` on scene files with a stray key. Registry grew
  60 → 62 commands, MCP 59 → 61 tools.
- **`checkScript` command**: syntax-check script source or an existing
  script file without saving — read-only, a pre-flight before
  `editScript`/`edit-script`/`edit_script`. CLI `check-script`, MCP
  `check_script`; also what the Code panel's inline lint runs.
- **`/api` + WebSocket Origin/Host enforcement**: the local project
  server's `/api/*` routes and `/api/ws` upgrade now reject a present
  `Origin`/`Host` header that doesn't resolve to a loopback hostname —
  closing a hole where a hostile webpage could otherwise drive the local
  dev server just by pointing a browser tab at its port (no Origin header
  at all, e.g. from the CLI or MCP server, is still allowed). See
  [agent-panel.md](./agent-panel.md#the-external-change-model).
- **Editor bundle code-split**: the Agent panel's embedded Terminal
  (`@xterm/xterm`) and the spritesheet `SliceDialog` now lazy-load with
  `React.lazy`, alongside the already-lazy Code panel editor — the
  editor's main chunk dropped from 1,251,480 B to 910,263 B (-27.3%
  raw, -26.3% gzip). See [performance.md](./performance.md#bundle-sizes).
- **Seeded ids + CI clean-tree check**: example generation now uses
  deterministic seeded id generation so regenerating the bundled examples
  is byte-reproducible, and CI verifies the working tree is clean after a
  fresh `npm run build:packages && node packages/examples/generate.mjs`.
- **`Tilemap.grid` size cap**: rows/columns are capped at 1024
  (`TILEMAP_MAX_DIM`), enforced at the schema level, shared by
  `resizeTilemap`/`fillTilemapRect`.
- The all-Lua `ember-arcade` example (the 10th) is a showcase built to
  exercise the whole post-effects/SpriteEffects surface: a stacked
  `Camera.postEffects` look, `ctx.effects.flash` hits, and a dissolve
  death animation.

## Shipped in v0.9.0

- **Prefabs (tracked stamps)**: reusable entity templates. `createPrefab`
  serializes an entity's full descendant subtree into a new prefab asset
  (`assets/prefabs/<slug>.prefab.json`, normalized local ids, root-first);
  `instantiatePrefab` places a fresh, freshly-id'd copy into a scene;
  `updatePrefab` pushes a modified instance's subtree back onto the asset;
  `syncPrefabInstances` rebuilds every tracked instance (one scene or all)
  from the current payload, preserving each instance's id/name/position/
  enabled state but replacing its whole descendant subtree. Registry grew
  56 → 60; CLI `hearth prefab create|place|update|sync`, MCP
  `create_prefab`/`instantiate_prefab`/`update_prefab`/
  `sync_prefab_instances`, four new `PREFAB_*` validation codes, and
  `ctx.scene.spawnPrefab(name, opts?)` for runtime spawning (returns `nil`/
  `null` on an unknown name; destroying the returned root does not cascade
  to its children). No live linking, no per-field overrides — a sync is an
  all-or-nothing rebuild by design. Editor surfaces: Hierarchy's "Save as
  prefab", Assets panel's "Add to scene"/"Sync instances", and Inspector's
  "Update prefab"/"Sync all" banner on a selected instance. See
  [prefabs.md](./prefabs.md).
- **Editor friendliness**: human-facing chrome dropped engine jargon
  (Toolbar/Changes-panel copy: Snapshot → **Checkpoint**, Diff →
  **Review**/**Changes**; agent-facing CLI/MCP names are unchanged) and
  gained visible **Undo/Redo** buttons in the main toolbar (previously only
  in the Changes panel). A new central keybind registry
  (`apps/editor/src/keybinds.ts`) is the single source of truth for every
  shortcut and drives a `?` cheat-sheet overlay, so the dispatcher and the
  documentation can never drift apart. New bindings: ⌘D duplicate, Delete
  removes the selection, F focuses the camera on it, arrow keys nudge
  1px/10px, and ⇧⌘S checkpoints (⌘S alone just logs a "saved
  automatically" reassurance and swallows the browser's Save dialog —
  binding checkpoint to plain ⌘S would silently reset the review baseline
  on a habitual keypress). The Scene View also gained direct-manipulation
  transform handles: 8 resize handles + 1 rotate handle on the current
  selection, targeting `SpriteRenderer`/box-or-circle `Collider`/
  `Transform.scale` by priority, one undo step per gesture except a corner
  drag on a sprite or box collider (which edits two separate scalar
  fields, so it commits two). See [editor.md](./editor.md).

## Shipped in v0.8.0

- **Embedded agent panel**: the editor hosts a real terminal
  (`@lydell/node-pty` + `@xterm/xterm`) running the user's own `claude` CLI,
  pre-wired to the project by merge-writing a `hearth` entry into
  `.mcp.json`. A 4-tier permission-mode picker, install/detect for
  `claude`/`codex`, an always-available plain-shell "Open Terminal" for
  Codex or anything else, a live activity timeline fed by the command
  journal, and Snapshot/Review changes/Revert session header actions. The
  panel embeds a genuine, unmodified CLI in a real PTY and never touches
  its stream, credentials, or flags beyond `cwd` and standard MCP config —
  see [agent-panel.md](./agent-panel.md) for the full subscription-safety
  position, permission-mode table, and troubleshooting.
- **Command journal + external-change awareness**: `.hearth/log/
  commands.jsonl` records every mutating command (plus `runPlaytest`/
  `validateProject`) from any session — CLI, MCP, or editor — independent
  of undo/redo history; `listJournal` command, `hearth log`, MCP
  `list_journal`. The editor now watches this file over a WebSocket
  channel and live-reloads/refreshes whenever an *external* agent session
  changes the project, instead of going stale until a manual reload — this
  benefits every agent workflow, not just the panel, and structurally
  fixes the earlier drag-drop-import staleness gap. See
  [project-format.md](./project-format.md#hearthlogcommandsjsonl).
- **Content scale & published performance numbers**: a headless benchmark
  harness (`npm run bench`) with results and honest guidance in
  [performance.md](./performance.md); a spatial-hash broadphase, a
  per-entity tilemap-collider cache, a frame-scoped entity-list cache, and
  particle-object pooling — all bit-identical to prior behavior (golden
  determinism tests pin full-run state hashes) — turned the worst
  synthetic scenario (1500 colliders) from over 2x the 60Hz frame budget
  to comfortably under it (13.5x mean speedup).
  Also: pointermove reflow coalesced to once per rendered frame instead of
  once per native event.
- **Scene management surfaced end to end**: `duplicateScene` (fresh entity
  ids, optional `--with-playtests` cloning) and a new `duplicateEntity`
  (deep-copies an entity and its full descendant subtree with fresh ids in
  one command) are now real CLI verbs, MCP tools, and an editor scene-menu
  (⋯ next to the scene picker: Duplicate/Rename/Set as initial/Delete) —
  closing the gap where several of these existed only as core commands.
  `renameScene` also rejects collisions with an existing scene the way
  `create`/`duplicate` already did.
- **Tilemap editing ergonomics**: batched `paintTiles`/`fillTilemapRect`/
  `resizeTilemap` core commands (one undo entry per stroke, not one per
  cell), CLI `paint tiles`/`fill tiles`/`resize tilemap`, matching MCP
  tools, an editor Scene View paint tool (palette + click/drag paint +
  shift-drag rect-fill), and a typed `tileAssets` Inspector control (a
  char → asset-picker row list) replacing the old raw-JSON textarea.
- **Gamepad axis hysteresis**: digital gamepad-axis-crossed-threshold
  bindings latch with ±0.05 hysteresis around the effective threshold so
  stick noise can't flap synthetic key codes or `justPressed`. See
  [input.md](./input.md).
- **`hearth delete asset`** CLI verb for `removeAsset` (with
  `--keep-file`), closing the last CLI delete-verb parity gap.
- The all-Lua `ember-horde` example (the 9th) is a survivors-like proof of
  the new ceiling: waves of enemies pathing toward the player up to
  several hundred concurrent, pooled hit-spark particles, camera shake, a
  HUD counter and pause menu, gamepad supported.

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

## The road to 1.0

The end goal, stated so every release aims at it: **a solo dev or an agent
can take a 2D game from empty project to a polished, distributable game
without leaving the tool or hitting a wall.** Four waves remain. Each one
completes a loop rather than scattering features; anything that doesn't
serve that loop waits (see Non-goals).

### v0.11 — the iteration loop

Write → play → tweak becomes professional:

- **Script hot-reload during play** — edit a script, the running game picks
  it up; no Stop/Play round-trip.
- **Live property patching** — Inspector edits apply to the running game
  (this also closes the long-standing "ambientLight needs Stop/Play" gap).
- **Runtime error → exact line** — a script error in the Console jumps to
  the failing line in the Code panel.
- **Format-on-save** for Lua and JS, **code tabs** (multi-file editing),
  **hover docs** on the `ctx` API, **find/replace across scripts**.

Every item doubles for agents: hot-reload makes iteration cheaper over
CLI/MCP too, and error→line makes self-fixing faster.

### v0.12 — the content ceiling

What games can be stops being tooling-limited:

- **Animation state machines** (SpriteAnimator is frame-loop only today).
- **Tilemap autotiling** — the single biggest level-design quality-of-life
  in any 2D engine.
- **Particle preview** in the editor.
- **Live-linked prefabs with per-field overrides** (v0.9 shipped tracked
  stamps; this is the richer model it deliberately deferred).
- **Bulk asset import** (folder/multi-file `importAsset`).

### v0.13 — ship your game

Exports stop being web-only:

- **Desktop game export** — per-platform packaged builds of *your game*,
  not just the editor.
- **Signed/notarized engine builds**, custom app icon, auto-update.
- **itch.io-ready output** and **project templates** for the
  empty-project moment.

### v1.0 — hardening

No features. Project-format stability guarantee (documented migrations,
upgrade tests), docs completeness, performance regression fences,
onboarding polish, and a bug-tail burn-down. Then 1.0.

## Parallel track / post-1.0

None of these block 1.0; they ride alongside or after it:

- **Codex first-class MCP wiring** (the agent panel launches Codex today;
  `.mcp.json` auto-preparation is Claude-Code-only — Codex's config story
  is TOML-based and needs its own path).
- **Custom chat UI over the agent** — only when it can be built
  API-key-only (Claude Agent SDK) or subscription terms allow a wrapped
  UI; see [agent-panel.md](./agent-panel.md#why-a-terminal-not-a-custom-chat-ui).
  The embedded terminal is the answer for now.
- **Custom shader assets (user GLSL)** — the curated `postEffects` set
  covers the common cases; user-authored shaders need a sandboxing and
  asset-format design first.
- **TypeScript scripts** with a compile step and typed `ctx`;
  **multi-instance components** (`formatVersion: 2`); **MCP resources**.
- **Incremental spatial hash** and further scale headroom (physics
  islands/sleeping, worker physics, culling) — only if a real benchmark
  demands it (see [performance.md](./performance.md#current-bottlenecks)).
- **Multi-select transform handles**; **finer-grained undo** for
  continuous gestures, if whole-command granularity proves too coarse.
- Agent-facing "explain this scene" structured summaries; plugin/component
  SDK; multiplayer-friendly determinism research (input serialization +
  rollback).

## Non-goals

- **A visual logic editor.** Cut, not deferred: agents write code, and
  humans get a real code editor and an approachable scripting language. A
  node graph is a second, worse programming language to maintain, and it
  drags every future feature into building two UIs.
- Competing with Unity/Godot on 3D, shaders, or console targets.
- Built-in AI/LLM API calls. Agents connect **from outside** via MCP/CLI;
  the engine stays model-agnostic and fully usable offline.
- Cloud project storage. Projects are local files; use git.
- Concave polygon decomposition (split concave colliders into convex
  pieces yourself) and audio mixing buses.
