# Wave E: Embedded Agent Panel + Content Scale — Design

Date: 2026-07-06. Target release: v0.8.0.
Chosen by Jake: backlog §9 (embedded agent panel, v1) + §14 (content scale &
perf) + top Wave D minors. Standing directives apply: by wave end the engine
is notably better, production-grade, and able to make more diverse and
higher-quality games; every feature ships CLI/MCP-first; editor UI is typed
and cohesive (no raw JSON fields); no engine chrome in shipped games; free
OSS core, nothing local gated.

## What this wave delivers

1. **The agent panel (§9 v1)** — the Hearth editor hosts the user's own
   coding agent in a real embedded terminal, pre-wired to the project via
   MCP, with a live trust timeline of every structured command the agent
   runs, permission modes up front, and Snapshot / Review / Revert one click
   away. Onboarding collapses to: download Hearth → open project → click
   Start Claude Code → describe your game.
2. **External-change awareness** — the editor live-follows *any* outside
   agent (embedded terminal, separate CLI, MCP session): a disk-backed
   command journal is the change signal, the editor reloads and refreshes
   automatically. Today the editor never notices external edits at all;
   this is the biggest production-grade gap the panel exposes and the fix
   benefits every agent workflow, not just the panel.
3. **Content scale (§14)** — published performance numbers from a real
   benchmark harness; a spatial-hash broadphase, tilemap-collider caching,
   frame-scoped entity caching, and particle pooling (all bit-identical to
   current behavior); scene management surfaced end to end (duplicate /
   rename / delete / set-initial in editor UI + CLI + MCP, with optional
   playtest cloning); a real `duplicateEntity` command; tilemap editing
   ergonomics (batched paint/fill/resize commands + an editor paint tool +
   a typed tileAssets control); and a 9th example that proves the new
   ceiling (a survivors-like horde scene running hundreds of live
   entities).
4. **Wave D minors** — gamepad axis hysteresis; `hearth delete asset` CLI
   parity; UI pointermove reflow throttling (folded into perf work).
   Drag-drop-import History staleness is fixed structurally by (2).

## Legal position (verified 2026-07-06)

Anthropic's June 2026 billing change makes the boundary explicit: the
official `claude` CLI running in a terminal — **including a terminal
embedded in an editor** (Zed is the named precedent) — draws from the
user's Pro/Max subscription. What does not: ACP integrations, third-party
UIs wrapping Claude Code, and `claude -p` headless wrapping. Hearth v1
therefore embeds a genuine, unmodified CLI in a real PTY and never touches
its stream, credentials, or flags beyond `cwd` and standard MCP project
config. The trust timeline is fed exclusively by Hearth's own command
registry (the journal below), which is orthogonal to how the agent runs.
A custom chat UI remains out of scope until it can be built API-key-only
(Agent SDK) or Anthropic OKs subscription use. Descriptive "works with
Claude Code" wording only; no logos or implied endorsement.

## Architecture decisions

### A. Command journal (core)

`HearthSession.execute` — the single mutation choke point
(`packages/core/src/session.ts`) — appends one JSON line per *noteworthy*
command to `.hearth/log/commands.jsonl`:

- Journaled: every `mutates` command, plus a fixed allowlist of meaningful
  non-mutating actions: `runPlaytest`, `validateProject`. (Pure `inspect*` /
  `list*` reads are not journaled — the editor calls them constantly.)
- Entry shape: `{ seq, ts, source, command, summary, ok, error?, detail? }`
  where `summary` reuses `summarizeCommand`, `source` is a short label the
  session is constructed with (`editor` | `cli` | `mcp` | `unknown`), and
  `detail` carries small command-specific facts (e.g. playtest pass/fail
  and assertion counts, validate error/warning counts). No params, no
  snapshots — the journal is a feed, not a backup; undo history remains
  separate.
- `seq` is monotonic per project: `max(seq in file) + 1` read at append
  time; concurrent writers use append-only `O_APPEND` single-`write`
  semantics (same durability class as the rest of the store). Exact
  cross-process seq collisions are tolerable (feed ordering ties break by
  ts) — the journal is informational, never load-bearing for correctness.
- Rotation: when the file exceeds 4000 lines, rewrite it to the newest
  2000 under the same isolated-failure rule as history capture: a journal
  write failure emits a warning and never fails the command.
- `.hearth/log/` joins the gitignore-managed engine-state convention.
- **Parity:** new read-only core command `listJournal { since?, limit? }`
  → entries newest-last; CLI `hearth log [--since <seq>] [--limit <n>]
  [--json]`; MCP tool `list_journal`. `SessionOptions` gains
  `source?: string`; the CLI passes `cli`, the MCP server `mcp`, the
  editor project server `editor`.

### B. External-change awareness (editor)

- The project server (shared vite/Electron `projectServer.ts`) watches the
  open project's `.hearth/log/commands.jsonl` (fs.watch with a 2 s polling
  fallback; debounced). On growth beyond the server's own last-seen seq
  from a *different* source, it: (1) drops/reloads the cached
  `HearthSession` for that root so the in-memory `ProjectStore` re-reads
  disk, and (2) pushes an event to connected editors.
- Transport: one WebSocket endpoint `/api/ws` (the `ws` package), served by
  both hosts — the vite plugin attaches to the dev server's HTTP upgrade
  event; the Electron loopback server does the same. JSON frames with a
  `type` discriminator; this same socket multiplexes the PTY (below).
  Frame types: `journal` (new entries), `pty-data`, `pty-exit`,
  `pty-input`, `pty-resize`, `pty-start`.
- Editor store: on a `journal` frame from an external source, bump
  `commandSeq` and `refresh()` — every existing panel (Hierarchy,
  Inspector, Diff, History, Assets) already re-queries off that signal.
  This structurally fixes the Wave D minor where drag-drop asset import
  bypassed `commandSeq`.
- Conflict model stays last-writer-wins per file with a much smaller
  window; the editor never auto-writes on external change (only re-reads).
  Documented in docs/agent-panel.md.

### C. PTY terminal (agent panel v1)

- Server side: a PTY manager in the project-server context using
  **`@lydell/node-pty`** (prebuilt binaries for mac/win/linux — no
  node-gyp in CI or on user machines; MIT). One PTY per open project at a
  time (v1); spawn cwd = project root; cols/rows tracked from the client;
  killed on socket close, panel close, or project switch. Works
  identically under the vite dev server and Electron (both are plain Node
  processes).
- Renderer: `@xterm/xterm` + fit addon inside the existing **Agent panel**
  (panel id `agent` — it evolves from static setup instructions into the
  live panel; the copy-paste setup blocks move to a "Manual setup" section
  within it). Terminal I/O rides the `/api/ws` frames.
- Packaging: `@lydell/node-pty` becomes a real dependency of the assembled
  app — `assemble-app.mjs` adds it to `release-app/package.json` and
  installs it there; electron-builder `asarUnpack`s the package so its
  `.node` prebuilds load from disk. esbuild keeps it `external` (it is
  server-side only, required lazily so browser-mode code never touches
  it). Smoke coverage via `HEARTH_SMOKE=1` extended to assert the PTY
  module loads in the packaged app.

### D. Agent launch, login, permission modes

- `GET /api/agent/detect` reports which agent CLIs are on PATH (`claude`,
  `codex`) with versions, plus whether `.mcp.json` already wires hearth.
- **Start Claude Code** (the happy path): the panel writes/merges a
  project-root `.mcp.json` entry pointing at the bundled `hearth-mcp.mjs`
  (`meta.toolPaths`) with the chosen permission mode, then starts the PTY
  running plain `claude`. Claude Code itself discovers `.mcp.json`, asks
  the user to approve the server, and handles its own OAuth login in the
  terminal (browser pops; credentials persist on the machine; we never see
  them). Restarting with a different mode rewrites `.mcp.json` and
  restarts the CLI.
- Permission mode selector sits above the terminal, default `safe-edit`,
  mirroring the MCP `--mode` ladder (`read-only`/`safe-edit`/`full`/`all`)
  with the existing one-line descriptions.
- Not installed → the panel offers the official install command and runs
  it *visibly in the terminal* on click (no hidden installs), then
  re-detects.
- **Open Terminal** (always available): a plain shell (`$SHELL` /
  PowerShell) in the project root for Codex or any other tool; the Manual
  setup section carries the copy-paste wiring for non-Claude agents. Codex
  gets detect + launch, but MCP wiring for it stays manual in v1 (its
  config story is TOML-based; first-class wiring is future work).
- The `.mcp.json` write happens server-side (`POST /api/agent/prepare`);
  it is agent wiring, not project content, so it is not a registry command
  — CLI users keep using `claude mcp add` as documented.

### E. Trust UX

Agent panel layout: terminal on the left, an **activity timeline** on the
right fed by journal frames — one row per command (icon by kind, summary,
ok/✗, relative time; playtest rows show pass/fail + assertion counts;
validate rows show error/warning counts). Header actions: permission mode,
**Snapshot** (snapshotProject), **Review changes** (focuses the Diff
panel), **Revert session** (revertProject with confirm), and a link to the
History panel for granular undo. No token/cost readout in v1 — we do not
parse the CLI's stream, and that is deliberate (see Legal position).

### F. Benchmark harness + published numbers (§14)

- `packages/runtime/bench/` with `npm run bench` at the root: builds
  synthetic projects in memory (no shipped example needed for the harness)
  across scenarios — `colliders-small/medium/large` (100 / 500 / 1500
  moving colliders + a 100×60 solid tilemap), `particles` (50 emitters at
  cap), `mixed` (survivors-like: 800 movers, layers, events). Each runs
  1000 headless frames after warmup and reports mean / p95 / worst ms per
  frame and steady-state entity counts, as a table.
- `docs/performance.md` (new): the numbers table (machine noted), what
  they mean in game terms, how to re-run, and honest guidance (what scale
  is comfortable, where the next ceiling is). CI runs the bench in smoke
  mode (few frames, no thresholds — perf assertions in CI are flaky by
  design decision; the doc numbers are the honest artifact).
- Bench runs before AND after the perf work land in the doc as the
  improvement story.

### G. Perf work (bit-identical, all guarded by golden determinism tests)

1. **Frame-scoped entity-list cache**: `getEntities()` returns a cached
   array invalidated on spawn/destroy/enable mutation and at frame
   boundaries — callers must not mutate the returned array (audit + note).
2. **Tilemap collider cache**: per-entity cache of `tilemapBoxes` keyed on
   grid/tileSize/solid/world-position; invalidated via the same component
   mutation paths. Tilemaps stop allocating N boxes per frame.
3. **Spatial-hash broadphase**: uniform grid keyed by AABB, used to prune
   candidate pairs for movers×obstacles and mover×mover. **Order
   preservation is the contract**: surviving pairs are iterated in exactly
   today's order (movers in entity order; per mover, obstacle candidates
   in ascending collection index; mover pairs in ascending (i, j), i<j).
   The broadphase never touches any RNG stream. Cell size = max collider
   AABB extent in the scene (recomputed when colliders change), min 32 px.
   Always on — no threshold switch; a naive reference pair-generator stays
   in the test suite and golden tests assert identical full-run state
   hashes on seeded synthetic scenes (including one-way platforms,
   triggers, polygon SAT paths).
4. **Particle pooling**: free-list reuse of particle objects per emitter;
   spawn/expiry semantics and counts unchanged (playtest asserts hold).
5. **UI pointermove throttle** (Wave D minor): coalesce pointermove
   reflows to once per frame instead of per event.

### H. Scene management & templating (§14)

- **Surface `duplicateScene`** (command exists, unsurfaced): CLI
  `hearth duplicate scene <scene> <newName> [--with-playtests]`, MCP
  `duplicate_scene`, and editor UI. New option `withPlaytests` clones
  playtests targeting the source scene: retarget `scene` to the new id and
  remap entity-id references in steps through the duplicate's old→new id
  map; cloned playtests get `<name> (<newScene>)` names with collision
  suffixing.
- **`renameScene` collision fix**: reject a rename to a name that resolves
  to a different existing scene (create/duplicate already reject; rename
  is the gap that lets duplicates in).
- **New core `duplicateEntity`** `{ scene, entity, newName?, offset? }`:
  deep copy including descendants (flat-list walk of `parentId`), fresh
  ids remapped across the subtree, optional Transform position offset
  (default +16,+16 so copies are visible), tags/components carried
  verbatim (asset ids and script paths shared by design). CLI
  `hearth duplicate entity`, MCP `duplicate_entity`; the editor Hierarchy
  “Duplicate” switches to this command (today it is a shallow client-side
  copy that silently drops children).
- **Editor scene manager**: the Toolbar scene dropdown grows a scene menu
  (⋯) with Duplicate / Rename / Set as initial / Delete (confirm), backed
  by the existing commands — closing the gap where rename/delete/
  set-initial exist in core but nowhere in the app.

### I. Tilemap ergonomics (§14)

- **New core commands** (all `safe-edit`, batched, validated against
  `tileAssets` keys ∪ `.`/space):
  - `paintTiles { scene, entity, cells: [{x, y, char}] }` — batched cell
    writes (one undo entry per stroke);
  - `fillTilemapRect { scene, entity, x, y, width, height, char }`;
  - `resizeTilemap { scene, entity, width, height, anchor? }` — grow pads
    with `.`, shrink crops; anchor top-left default.
  Out-of-bounds cells are command errors (suggestions say to resize
  first). CLI verbs (`hearth paint tiles`, `hearth fill tiles`,
  `hearth resize tilemap`) + MCP tools for all three.
- **Editor paint tool**: selecting an entity with a Tilemap adds a Paint
  mode to the SceneView — a palette of the map's chars (swatches rendered
  from `tileAssets` textures, plus eraser); click/drag paints (batched
  into one `paintTiles` per stroke); shift-drag rect-fills via
  `fillTilemapRect`. Undo = one Cmd+Z per stroke (history already handles
  it).
- **Typed `tileAssets` Inspector control** (no-raw-JSON rule): a char →
  asset-picker row list (add/remove rows, char field validated
  single-char, asset dropdown filtered to images), replacing the JSON
  textarea fallback.

### J. Example: **Ember Horde** (9th, generated)

A survivors-like proof of the new ceiling, all-Lua, generated via
`packages/examples/generate.mjs`: one arena scene; a player with virtual-
axis movement; waves of enemies spawned via `ctx.scene.instantiate` up to
several hundred concurrent, pathing toward the player on collision layers;
pooled hit-spark particles; camera shake on hits; an on-screen HUD counter
(UI widgets) and a pause menu; gamepad supported. Playtests: probe-derived
asserts including a sustained-horde frame (entity count assert at scale)
and event/collision behavior. The bench doc references it as the playable
companion to the synthetic numbers. Engine-repo only (never on the
website, per standing rule).

### K. Wave D minors folded in

- **Gamepad axis hysteresis**: threshold bindings latch with ±0.05
  hysteresis around the effective threshold so stick noise cannot flap
  synthetic codes / `justPressed`.
- **`hearth delete asset` CLI verb** for `removeAsset` (with
  `--keep-file`), closing the CLI parity gap.
- Pointermove throttle in G5; import-staleness fixed by B.

## Explicit non-goals (this wave)

- Custom chat UI over the agent (subscription-unsafe; API-key path is
  future work), token/cost readout, multiple simultaneous terminals,
  first-class Codex MCP auto-wiring, ACP.
- §12 tier 2 custom shaders (still research).
- Physics islands/sleeping, worker-thread physics, renderer culling —
  only if bench numbers demand more than the planned work delivers.
- Prefabs as a first-class asset type (duplicateEntity/Scene are the
  stepping stone).
- Scene-content merge/conflict resolution beyond reload-on-external-change.

## Testing strategy

- Core: journal unit tests (allowlist, rotation, isolated failure,
  cross-session append), listJournal, duplicateEntity (deep trees, id
  remap, offset), duplicateScene withPlaytests (retarget + step remap),
  renameScene collision, tilemap commands (bounds, validation, undo
  round-trips through history).
- Runtime: golden determinism tests — full-run state hashes identical
  with broadphase vs naive reference on seeded scenes covering one-way
  platforms, triggers, circles, polygons, tilemaps; particle pooling
  count/behavior asserts; entity-cache invalidation (spawn/destroy
  mid-frame).
- Bench: harness self-test (runs a tiny scenario in CI smoke mode).
- Editor/server: PTY manager lifecycle tests (spawn/kill/resize with a
  fake pty), WS frame routing, journal-watch → session-reload (write via a
  second session, assert editor session reloads and a frame is emitted),
  agent detect/prepare handlers (`.mcp.json` merge semantics).
- Playtests: Ember Horde probe-derived suites; cross-session regression
  shape (fresh ProjectStore.load) for anything touching disk, per the
  Wave D lesson.
- `npm run typecheck` alongside vitest, always. Packaged-app smoke
  (`HEARTH_SMOKE=1`) asserts PTY module load.

## Release

Version 0.8.0 across all package.json + constants mirrors. Docs: new
docs/agent-panel.md + docs/performance.md; updates to README, cli.md,
mcp.md, project-format.md (journal), components.md (unchanged counts),
input.md (hysteresis), roadmap.md. Website sync + deploy at the end
(feature copy; no example mentions). Tag v0.8.0 → Release workflow; verify
all 11 assets + the packaged apps still build with the native dep.
