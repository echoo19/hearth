# Hearth Roadmap

v0.14 is the current milestone. Its release, v0.14.0 (shipped, below,
"Tightening"), adds no new engine features — 129 commits that make the
editor *work properly everywhere*, front-load the workflows, and unify the
design language, driven by a 16-surface live audit (a 121-entry ledger, 100
fixed, every entry dispositioned) and closed by six independent re-audits.
Game keyboard capture is now scoped to the game, so editor dialogs, buttons,
and fields never lose Escape/Enter/Space again and WASD/axis-only bindings
work in play mode *and* exports; switching to the Code panel auto-pauses the
run (simulation *and* audio) and switching back auto-resumes; desktop-export
zips preserve executable bits so unzip-and-launch just works; a real
File/Edit/View/Help application menu, a minimal toolbar that holds up at
1024px, a hand-authored icon set, keyboard-accessible tooltips, and real
empty states retire the last raw-JSON Inspector fields; prefab edits are
trustworthy (same-value edits record no override, no-op reparents don't
detach, broken markers self-repair); the intermittent editor batch-pool
crash is root-caused and fixed for good (0 crashes in 250 stress sessions);
and every project now ships a fact-checked best-practices skill
(`.claude/skills/hearth/SKILL.md`, drift-gated against the canonical copy)
that agents can read. Registry is unchanged at **71 commands**; MCP grew
68 → 70 command tools (72 tools total, including `screenshot`/
`get_agent_instructions`, adding `set_entity_enabled`/`set_entity_tags`).
v0.13 projects open byte-non-destructively. See
[Shipped in v0.14.0](#shipped-in-v0140) below.

On top of v0.13's **ship-your-game wave** — desktop game export (Electron),
a macOS signing ladder, itch.io zip parity everywhere, and project
templates (see [Shipped in v0.13.0](#shipped-in-v0130) below) — v0.12's
**animation state machines** (an `AnimationStateMachine`
component drives a sibling `SpriteRenderer` from a params/states/
transitions asset — `assets/statemachines/*.asm.json`,
`createStateMachineAsset`/`updateStateMachineAsset`,
`ctx.animator.setParam/getParam/fire/state` in both Lua and JS, a typed
Animator editor panel), **47-blob tilemap autotiling** (`setTileAutotile`/
`hearth autotile set` binds a tile char to a blob47 rule so its sheet
frame is picked from its 8 neighbours at render time instead of
hand-placing every edge/corner variant, plus a per-char sprite/autotile
mode toggle in the Inspector), **live-linked prefabs with per-field
overrides** (editing an instance's field directly now records it as an
override instead of silently drifting; `updatePrefab` auto-syncs every
other instance in the same command, merging the new payload with each
instance's own overrides rather than replacing them wholesale;
`revertPrefabOverride`/`hearth prefab revert` plus ember override dots
and per-field/whole-instance revert buttons in the Inspector; a
structural edit inside an instance detaches it instead of guessing),
**in-scene particle preview** (a Scene toolbar toggle simulates the
selected entity's `ParticleEmitter` live, off the same deterministic
stepper the runtime uses, without pressing Play), and **bulk asset
import** (`importAssets`/`hearth import asset <paths...> [--recursive]`/
MCP `import_assets` — one atomic undo entry per batch, auto-suffixed name
collisions, bad files reported in `skipped` instead of failing the whole
import; the editor's Assets panel accepts multi-file picks and
whole-folder drag-drop). Registry grew 65 → 70 commands; MCP grew 64 → 67
command tools (69 tools total, including `screenshot`/
`get_agent_instructions`). See
[scripting.md](./scripting.md#animation-state-machines),
[editor.md](./editor.md#autotile), and
[prefabs.md](./prefabs.md#live-link-semantics-marker-merge-detach).

On top of v0.11's script hot-reload during play (edit a script, every live
entity running it picks up the new code without a Stop/Play round-trip),
live Inspector property patching during play, a "Scene changed — Restart"
badge for structural changes that can't be live-patched, runtime error →
exact line, format-on-save (StyLua/Prettier), Code panel tabs, `ctx.`
hover docs, in-file search, and cross-script search/replace (`⇧⌘F`;
`hearth script search|replace`/MCP `search_scripts`/`replace_in_scripts`,
dry-run-first) — Registry grew 62 → 65 commands; MCP grew 61 → 64 tools —
v0.10's **post-processing system** (`Camera.postEffects` —
bloom/CRT/vignette/chromatic-aberration/pixelate/color-grade, up to 8
stacked — and per-sprite `SpriteEffects` outline/hit-flash/dissolve,
`ctx.effects.flash`), editor **Code panel** (lazy CodeMirror 6, `ctx.`
autocomplete, inline `checkScript` lint) plus a **Live panel** and
**Pause**/**Step** for frame-by-frame inspection, stricter
property-path validation with did-you-mean suggestions, a `checkScript`
pre-flight command, and Origin/Host enforcement on the local project
server — v0.9's **prefabs** (tracked-stamp reusable entity templates:
create/instantiate/update/sync, CLI + MCP parity, `ctx.scene.spawnPrefab`
— the richer live-link model above is what v0.12 built on top of these)
and a round of **editor friendliness** — plain-language chrome
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

## Shipped in v0.14.0

**"Tightening."** No new engine features. 129 commits making the editor
*work properly
everywhere*, front-loading the workflows, and unifying the design language —
driven by a 16-surface live audit (a 121-entry ledger, 100 fixed, every
entry dispositioned) and closed by six independent re-audits.

- **Every control works**: game keyboard capture is scoped to the game, so
  editor dialogs, buttons, and fields never lose Escape/Enter/Space again;
  WASD and all axis-only bindings work in play mode *and* exports; Space
  activates the focused button app-wide; clicking the canvas arms game input
  and releases it cleanly afterward.
- **A tighter iteration loop**: switching to the Code panel auto-pauses the
  run — simulation *and* audio freeze in place — and switching back
  auto-resumes without stopping it; hot-reload never tears the session down;
  undo/redo is burst-safe, serialized, and narrates what it reverted;
  checkpoints refresh the Changes panel instantly; console errors deep-link
  to the failing line and the unread badge respects your scroll position.
- **Honest shipping**: desktop-export zips now preserve executable bits, so
  unzip-and-launch just works (silently broken for every shipped zip
  before); per-game macOS bundle ids; folder web builds explain the
  `file://` limitation instead of failing cryptically; window icons accept a
  sprite or tile asset and are validated before export.
- **One deliberate product**: a real File/Edit/View/Help application menu
  (native on macOS in the desktop app, a slim in-window strip in the
  browser), a minimal toolbar (transport, scene picker, undo/redo arrows)
  that holds up at 1024px, a hand-authored icon set, a keyboard-accessible
  tooltip primitive replacing every native `title`, shared Menu/Button
  primitives, a tokenized type scale with Bricolage Grotesque brand moments,
  and real empty states in every panel. No raw-JSON Inspector fields remain.
- **Prefab trust**: same-value edits no longer record overrides, no-op
  reparents no longer detach instances, renames stay unique, saving an
  instance as a new prefab warns before re-linking, and broken markers are
  repaired instead of masquerading as live instances.
- **Agents are first-class**: full editor↔agent capability parity — new
  `set_entity_enabled`/`set_entity_tags` close the last gaps (Registry
  unchanged at 71 commands; MCP grew 68 → 70 command tools, 72 tools total).
  Every project now ships a fact-checked best-practices skill
  (`.claude/skills/hearth/SKILL.md`, drift-gated against the canonical copy)
  plus a pointer in AGENTS.md and `get_agent_instructions` — agents don't
  just *have* the tools, they know the house playbook.
- **Stability**: the intermittent editor crash ("Cannot read properties of
  null (reading 'clear')") was root-caused to Pixi's global batch pool being
  released by scene-view teardown and fixed for good (0 crashes in 250
  stress sessions); saved dockview layouts from earlier versions self-heal;
  v0.13 projects open byte-non-destructively.
- Upgrade note: no format changes; v0.13 projects open unchanged.

## Shipped in v0.13.0

- **Desktop game export (Electron)**: `exportDesktop` wraps a project's web
  build in a minimal, hardened Electron shell (`contextIsolation: true`,
  `nodeIntegration: false`, no preload, navigation locked to the loaded
  file) and packages one app per platform — `darwin-arm64`, `darwin-x64`,
  `win32-x64`, `linux-x64`, all four by default. CLI `hearth export desktop
  [--out dir] [--platform p]...` (repeatable), MCP `export_desktop`, and a
  Desktop pane in the editor's Export dialog (platform checkboxes, output
  dir, a live per-platform progress stream, per-build zip paths) all wire
  into the same new `@hearth/shipping` package, which drives
  `@electron/packager` and moves the CLI's zip helper (now `zipDirectory`,
  shared by web and desktop output alike) out of the CLI and into one
  implementation. Output is `<project-slug>-<platform>.zip` next to a
  per-platform app directory, requires the `build` permission like `export
  web`. Cross-packaged Windows/Linux artifacts built from a macOS host are
  packaging-verified but not execution-verified — CI only runs the host
  platform's packaged app; the docs say so plainly. See
  [export.md](./export.md#desktop-export-electron).
- **macOS signing ladder**: ad-hoc `codesign` by default (falls back to
  unsigned rather than failing the export if codesign itself can't run);
  `HEARTH_MAC_IDENTITY` signs with a real identity (a signing failure here
  is a hard error); adding `HEARTH_APPLE_ID`/`HEARTH_APPLE_PASSWORD`/
  `HEARTH_TEAM_ID` also notarizes (`xcrun notarytool submit --wait`) and
  staples the ticket. Windows/Linux builds are unsigned this release. Each
  build reports its own `signed`/`notarized` state, surfaced in the CLI
  output and the editor's pre-export signing status line
  (`GET /api/export/capability`).
- **Shippable app icon + Game Settings panel**: `buildSettings.icon` (a
  sprite asset id, default `null`) is converted to `.icns`/`.ico` for
  desktop exports (`png2icons`, pure JS — falls back to a bundled default
  Hearth icon on a decode failure rather than failing the build). Setting
  it needed a settings surface that didn't exist yet, so this wave also
  added a typed **Game Settings** editor panel (Window/Loop/Loading/
  Shipping sections) covering every `buildSettings` field, not just the
  icon — closing a standing editor/agent parity gap where `buildSettings`
  had no UI at all. Every edit is a normal `updateSettings` call, so undo/
  journal/live-patch all work for free.
- **itch.io zip parity everywhere**: `export web --zip` (`<project-slug>-
  web.zip`, `index.html` at the zip root) was CLI-only; the MCP
  `export_web` tool gained a `zip` param and the editor's Export dialog
  gained a "Zip for itch.io" checkbox, both wired through the same
  `zipDirectory` implementation the desktop export uses. A zip failure
  after a successful export reports as a `ZIP_FAILED` warning rather than
  turning a real export into a failure. New guide:
  [shipping-to-itch.md](./shipping-to-itch.md) (web upload, one zip per
  desktop platform as separate itch.io channels, butler as a documented
  manual step — Hearth doesn't wrap it).
- **Project templates**: `hearth init <name> --template
  platformer|topdown|arcade` (default still `blank`) scaffolds a small,
  playable genre skeleton — one scene, a camera, a commented movement
  script, a few obstacles, one `smoke` playtest — instead of an empty
  scene. `--list-templates` prints the available ones; an unknown name
  lists them in the error. New checked-in workspace package
  `@hearth/templates` (mirrors how `packages/examples` is generated and
  regenerated on every version bump) backs both the CLI flag and a new
  template-picker card row in the editor's Launcher (`blank` first,
  preselected). Pre-project, so CLI/editor only — no MCP tool; see
  [cli.md](./cli.md#project-templates).
- Registry grew 70 → 71 commands (`exportDesktop`); MCP grew 67 → 68
  command tools (70 tools total, including `screenshot`/
  `get_agent_instructions`).

## Shipped in v0.12.0

- **Animation state machines**: an `AnimationStateMachine` component
  (`assetId`, `playing`) drives a sibling `SpriteRenderer` from a
  params/states/transitions asset (`assets/statemachines/*.asm.json`,
  `StateMachineDataSchema` — bool/number/trigger params, `exitTime`- and
  condition-gated transitions, `from: 'any'` wildcards) instead of a
  single looping clip; wins over a plain `SpriteAnimator` on the same
  entity (one warning, not a hard error). `createStateMachineAsset`/
  `updateStateMachineAsset` (CLI `create asset state-machine`/
  `set-state-machine`, MCP `create_state_machine_asset`/
  `update_state_machine_asset`) author the document; scripts drive it with
  `ctx.animator.setParam/getParam/fire/state`, identical in Lua and JS — a
  fired trigger latches until an eligible transition actually consumes it,
  never auto-expiring on its own. Script hot-reload preserves a machine's
  live state (current state, params, latched triggers); reloading the
  *asset* itself resets every entity on it to the new `initial` state on
  purpose, so a renamed/removed state can't leave a live machine dangling.
  Editor: a typed **Animator editor** panel (params/states/transitions row
  lists, no raw JSON, one `updateStateMachineAsset` per Save). See
  [scripting.md](./scripting.md#animation-state-machines) and
  [editor.md](./editor.md#animator-editor).
- **47-blob tilemap autotiling**: `setTileAutotile` (CLI `autotile set`,
  MCP `set_tile_autotile`) binds a `Tilemap` char to a blob47 rule — the
  char's on-screen frame is picked from its 8 neighbours (an 8-bit mask
  canonicalized down to the 47 visually-distinct shapes) every time the
  map changes, instead of hand-placing every edge/corner tile variant.
  `--mapping` overrides individual shape keys with custom frame names
  when a sheet's slice order doesn't already match the standard
  `blob_<shapeKey>` template. Editor: a per-char Sprite/Autotile mode
  toggle in the Inspector's `tileAssets` row list, with a collapsed
  Advanced-mapping editor for all 47 shapes; both the editor preview and
  the runtime re-render a map's tiles live the moment a rule or a paint
  changes, no restart. See [editor.md](./editor.md#autotile).
- **Live-linked prefabs with per-field overrides**: editing a component
  property directly on a prefab instance (root or descendant) now records
  it as an implicit override on the instance's marker instead of just
  silently drifting until the next full rebuild. `updatePrefab` auto-syncs
  every other tracked instance of that prefab, across every scene, in the
  same command — a true **merge**: locals that still exist keep their
  scene ids, new locals mint fresh ones, removed locals drop out, and
  every instance's own overrides are re-applied on top (a stale override
  that no longer fits is dropped with a `PREFAB_OVERRIDE_STALE` warning
  naming exactly what and why). `revertPrefabOverride` (CLI `prefab
  revert <scene> <entity> [component] [path]`, MCP
  `revert_prefab_override`) restores the prefab's own value(s) and clears
  the matching override records. A structural edit inside an instance
  (add/remove an entity or component) can't be merged, so it **detaches**
  that instance instead of guessing (`PREFAB_INSTANCE_DETACHED`).
  Editor: ember override dots + per-field **Revert** buttons in the
  Inspector, and a running override count + **Revert all** on the
  instance banner. See
  [prefabs.md](./prefabs.md#live-link-semantics-marker-merge-detach).
- **In-scene particle preview**: a Scene View toolbar **Particles**
  toggle simulates the currently-selected entity's `ParticleEmitter` live,
  directly over the canvas, without pressing Play — driven by the same
  seeded, deterministic `EmitterState` stepper the real runtime uses (not
  an approximation), so previewing `rate`/`spread`/`gravity`/color edits
  while dragging Inspector fields matches Play and exported builds
  exactly. See [editor.md](./editor.md#particle-preview).
- **Bulk asset import**: `importAssets` (CLI `import asset <paths...>
  [--recursive]`, MCP `import_assets`) imports many files — or a whole
  folder, recursively — in one atomic undo/journal entry, auto-suffixing
  name collisions instead of failing the batch and reporting any bad file
  in `skipped` (with a code and message) rather than aborting everything
  else. Editor: the Assets panel's file picker takes multiple files and
  the whole panel accepts folder drag-and-drop, both funneling through the
  same command and summarized in one toast. See
  [editor.md](./editor.md#bulk-import).
- **Ledger fixes**: `create script` gains `--no-format` (parity with
  `edit-script`'s existing flag — CLI-created scripts could not
  previously opt out of house-style reformatting), and `set-settings`'s
  boolean-flag parsing (`--format-on-save`, etc.) is now strict instead of
  accepting anything JS treats as truthy.
- Three existing examples were extended to showcase the new systems
  rather than adding an 11th: **ember-horde** gained a real `Enemy`
  prefab with a live-linked "Elite Enemy" override instance,
  **sky-courier** gained a `courier-motion` state machine driving its
  idle/walk animation off a `moving` param, and **glow-caves** gained
  blob47-autotiled cave terrain.
- Registry grew 65 → 70 commands (`setTileAutotile`,
  `createStateMachineAsset`, `updateStateMachineAsset`, `importAssets`,
  `revertPrefabOverride`); MCP grew 64 → 67 command tools (69 tools total
  including `screenshot`/`get_agent_instructions`).

## Shipped in v0.11.0

- **Script hot-reload during play**: saving a script while the editor is
  playing swaps its compiled code into every live entity running it,
  preserving `ctx.vars`, pending timers, and running tweens. `onStart`
  does **not** re-run on reload; an error-disabled script re-enables on a
  successful reload; a compile failure leaves the old code running
  unchanged. Pinned caveat: existing `ctx.events.on` subscriptions keep
  firing their old closure (reload can't re-register them) — `onEvent`
  always resolves to the newest code. Works for external CLI/MCP
  `edit_script` calls too, via the command journal, not just the editor's
  own Code panel. See
  [scripting.md](./scripting.md#hot-reload-during-play).
- **Live Inspector property patching during play**: an Inspector edit
  dual-writes — always saved and undoable through the normal
  `setComponentProperty`/`setProperties` command, and, while playing,
  live-patched straight into the running preview. Closes the
  long-standing "`ambientLight` needs Stop/Play" gap. Property writes
  from an external CLI/MCP session apply live too, resolved through the
  command journal. Structural changes (new/removed entity or component,
  reparenting, and the like) can't be live-patched — they raise a
  **"Scene changed — Restart"** toolbar badge instead of guessing.
- **Runtime error → exact line**: a script error logged to the Console
  during play is clickable, jumping the Code panel to the failing line.
  Lua errors always carry a line; JS errors resolve one on a best-effort
  basis (some have none).
- **Format-on-save**: `editScript`/`createScript` reformat to Hearth house
  style automatically — StyLua (2-space indent, 100-column) for `.lua`,
  Prettier defaults for `.js` — unless `format: false` is passed or the
  project's `codeStyle.formatOnSave` is off. CLI `hearth script
  format [path] [--all]`, MCP `format_script`.
- **`hearth script` CLI group**: `edit|check|format|search|replace` is the
  forward surface for every script-editing verb; the older top-level
  `edit-script`/`check-script` stay as aliases.
- **Cross-script search/replace**: `searchScripts`/`replaceInScripts`
  commands (line-based plain-text or regex matching, no multiline
  patterns) — CLI `hearth script search|replace`, MCP
  `search_scripts`/`replace_in_scripts`, and an editor panel (`⇧⌘F`).
  Replace always previews per-file match counts with `dryRun`/`--dry-run`
  before writing; a real apply writes verbatim (not reformatted — run
  `script format --all` after) and is one undo entry regardless of how
  many files it touched.
- **Editor: Code panel tabs**: scripts open as tabs (soft cap 12) with
  independent per-tab undo history, `ctx.` hover docs (signature +
  description + example, off the same `CTX_API` table the autocomplete
  and docs use), in-file search/replace (`Mod-F`, CodeMirror's own search
  panel), and a format-on-save toggle wired to the project setting.
- **WS-status dot**: a small toolbar indicator for the editor's WebSocket
  link to the local project server (connected / reconnecting).
- Registry grew 62 → 65 commands (`formatScript`, `searchScripts`,
  `replaceInScripts`); MCP grew 61 → 64 tools (`format_script`,
  `search_scripts`, `replace_in_scripts`).

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
without leaving the tool or hitting a wall.** The feature set is complete:
v0.13's ship-your-game wave closed the last feature gap, v0.14's tightening
wave made every surface actually work, and v0.15's game-craft wave sharpened
how agents make games with those tools. One step remains before 1.0. Each
release completed a loop rather than scattering features; anything that
didn't serve that loop waited (see Non-goals) and still does.

### Wave L2 — agent game-craft (shipped v0.15.0)

No engine features — a focused pass on how well agents actually *make games*
now that every tool works and each project ships the house skill.

- **A game-craft skill**: a second fact-checked skill,
  `.claude/skills/hearth-craft/SKILL.md`, teaches juice and game-feel as
  concrete `ctx` recipes (camera shake/flash/fade/zoom-punch, particle
  bursts, tweens, layered sound, animation state machines) plus game-UX
  conventions and an agent quality bar. It scaffolds into every new project
  and was backfilled into all 13 example/template fixtures — each now
  carries both `hearth` and `hearth-craft` — drift-gated against the
  canonical copy.
- **An asset-sourcing playbook**: where to get sprites, audio, and fonts an
  agent is licensed to ship — Kenney (CC0), itch.io's CC0 filter,
  OpenGameArt, Freesound, and OFL/Apache Google Fonts — with the licensing
  rules and a fetch → import → verify loop. Every source and license claim
  was fact-checked live.
- **One-command connectability**: the Agent panel launcher reached parity
  across Claude Code, Codex, OpenCode + Ollama, and Hermes —
  detect → prepare → launch with a per-tool native MCP config writer
  (`.mcp.json`, `opencode.json`, `codex mcp add`, Hermes YAML) and
  already-configured detection so it never double-writes. Every embedded
  terminal now guarantees the `hearth` CLI on `PATH` via a shim, so agents
  run `hearth …` with no setup.
- **Journey-grouped docs + guides**: the docs reorganized into a
  journey-grouped IA (get started / build / script / ship / agents /
  reference), with seven new guides — per-agent connect pages (Claude Code,
  Codex, OpenCode, Hermes, any agent) and ship-it destination guides (web
  hosting, desktop, with honest Gatekeeper/SmartScreen notes).
- **AI-native positioning**: the README and website say what Hearth is — an
  *AI-native* game engine whose knowledge layer (the house skill, the
  verification loop, journal review, determinism) is the story; MCP and the
  CLI are plumbing, one of several front doors.
- Counts unchanged: **71 commands**, **72 MCP tools** — no new engine
  commands this wave. No format changes; v0.14 projects open unchanged.

### Wave M — final hardening & verification (v1.0)

No features. A project-format stability guarantee (documented migrations,
upgrade tests — including advancing the `hearthVersion` stamp when older
projects are edited), docs completeness, performance regression fences, the
deferred L-114 native window-close/Cmd+Q unsaved-scripts intercept and the
rest of the deferred-M bug tail, and onboarding polish. Then 1.0.

## Parallel track / post-1.0

None of these block 1.0; they ride alongside or after it:

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
