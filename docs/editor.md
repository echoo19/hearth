# Editor Guide

The editor is a dockable workspace over the same command system the CLI and
MCP server use. Every button here is a thin wrapper around a core command
(`hearth <command> --json` does exactly what the click does). This page
covers the editor's own chrome, keyboard shortcuts, and direct-manipulation
scene tools. For panel-by-panel content (Inspector fields, Assets browser,
etc.) see the component and asset guides linked from each section below; for
the embedded agent terminal see [agent-panel.md](./agent-panel.md).

The Agent panel starts a platform shell at the open project's root as soon as
the editor connection is ready. Type `claude`, `codex`, `opencode`, `hermes`,
or another installed agent command yourself; `hearth` is already on PATH.
Hearth does not detect agents or rewrite their configuration.

## Plain-language chrome

Human-facing editor copy avoids engine jargon; the underlying commands and
their CLI/MCP names (`snapshotProject` / `hearth snapshot`, `diffProject` /
`hearth diff`) are unchanged: agents and scripts keep the real vocabulary,
only the UI labels read differently:

| Button / panel | Label | What it does |
| --- | --- | --- |
| Toolbar | **Checkpoint** | `snapshotProject` — save a checkpoint you can review and restore |
| Toolbar | **Review** | Opens the **Changes** panel and refreshes it — see what changed since your last checkpoint |
| Toolbar | **Undo** / **Redo** | `undo` / `redo` — step through individual recorded changes |
| Changes panel | **Restore checkpoint** | `revertProject` — restore the project to the last checkpoint (confirm dialog) |
| Changes panel | **Refresh changes** | `diffProject` — recompute the diff against the last checkpoint |
| Agent panel timeline | **Checkpoint** / **Review changes** / **Restore checkpoint** | Same three operations, scoped to one agent session's activity |

"Checkpoint" and "Review" are the same operations documented elsewhere as
`hearth snapshot`/`hearth diff`. This page and the CLI/MCP docs are talking
about identical commands under different names for different audiences.

## Toolbar

Left to right: project name and scene picker, **+ Scene**, **Play/Stop**,
**Pause**/**Resume** and **Step** (enabled only while playing; see
[Pause and Step](#pause-and-step) below), **Undo**/**Redo** (enabled state
follows `listHistory`'s undo/redo cursor, tooltip shows the platform
shortcut), **Debug** (toggles the collider/ velocity/light debug overlay in
the preview; never on in exports), the view menu, **Checkpoint**,
**Review**, **Export** (opens the Export dialog: a Web/Desktop segmented
control; Web has the folder/single-file/zip options `hearth export web`
takes, Desktop has platform checkboxes, an output dir, a signing status
line, and a live per-platform progress stream; see
[export.md](./export.md#desktop-export-electron)), and **Close project**.
A "Every change saves
automatically" note sits near Export as a reminder that there's no separate
save step. See [⌘S](#shortcuts) below for why that matters for the
keyboard. While playing, a **Scene changed — Restart** button appears next
to Play/Stop whenever something changed that can't be applied to the
running game live. See [Live iteration during
play](#live-iteration-during-play) below.

A small **connection dot** next to the toolbar shows the editor's
WebSocket link to the local project server (the same channel the external
agent watcher and the Agent panel timeline read from): solid when
connected, pulsing while it reconnects. The dot tracks the dev-server
connection only. It says nothing about a running game or an agent
session.

## Pause and Step

**Pause** freezes the running game in place without stopping it: the
`SceneRuntime` simply stops advancing fixed frames; nothing is torn down,
so **Resume** continues exactly where it left off. **Step** (enabled only
while paused) advances the frozen game by exactly one fixed frame per
click, for frame-by-frame inspection of physics/animation/script behavior
that's too fast to see at full speed. Both are toolbar buttons only, no
keyboard shortcut. Pair Pause/Step with the [Live panel](#live-panel) to
watch an entity's live state change one frame at a time.

## Code panel

A multi-buffer script editor (CodeMirror 6, lazy-loaded: the CM6 chunk
only downloads once you actually open this panel) with a tab strip, a
dirty-state dot per tab, Save (`⌘S` while the editor has focus), and:

- **Tabs, per-buffer undo**: open scripts stack up as tabs (soft cap of 12:
  opening a 13th evicts the oldest *clean* tab; dirty tabs are never
  auto-evicted, so the count can briefly exceed 12 if every tab has unsaved
  changes). Each tab keeps its own CodeMirror document, selection, and undo
  history, cached per file and swapped in on tab switch. Undoing in one
  tab never touches another's history. Closing a dirty tab (✕, or
  middle-click) asks first; closing a clean one closes immediately.
  Arrow/Home/End keys move focus across the tab strip.
- **`ctx.` autocomplete**: suggestions are generated from the same
  `CTX_API` array that backs `hearth inspect api` and
  [scripting.md](./scripting.md), so the completion list and the docs can
  never silently drift apart. Registered additively via CodeMirror's
  language-data facet, so JavaScript's own built-in keyword/snippet
  completions still work alongside it (Lua gets a small static
  reserved-word list on top, since the legacy Lua mode has no language-data
  completion of its own).
- **`ctx.` hover docs**: hovering a `ctx.foo.bar` token shows a tooltip
  with its signature, description, and a language-appropriate example,
  resolved from the exact same `CTX_API` trie the autocomplete reads, so
  hovering and completing a member can never show different information.
  Hovering the bare `ctx` token itself shows nothing; you need at least one
  `.member`.
- **Inline lint**: every edit (debounced) runs the buffer through
  `checkScript`, the same read-only pre-flight command available on the
  CLI/MCP (see [scripting.md](./scripting.md#errors-and-validation)), and
  surfaces diagnostics in CodeMirror's lint gutter, without ever saving the
  draft.
- **In-file search** (`Mod-F`, Ctrl-F on Windows/Linux, ⌘F on macOS):
  CodeMirror's own search panel: find, find next/previous, replace,
  replace-all, case-sensitive and regex matching, scoped to the open
  buffer. See [Search across scripts](#search-across-scripts) below for
  project-wide search/replace.
- **External-change follow**: if the open script changes outside the
  editor (another CLI/MCP session, an agent) while your buffer is clean, it
  silently reloads; while your buffer is **dirty**, it never overwrites
  your edits: a conflict banner offers **Reload** or **Keep mine**
  instead, so a later Save can never clobber an external change without you
  knowing.
- **Format on save**: a toolbar checkbox toggles the project's
  `codeStyle.formatOnSave` setting (default on): StyLua for `.lua`
  (2-space indent, 100-column) and Prettier defaults for `.js`. It's a thin
  UI over the same project setting `hearth set-settings
  --format-on-save`/`updateSettings` writes, so toggling it here changes
  behavior for the CLI and MCP `edit_script` too, not just the editor.

## Search across scripts

**⇧⌘F** opens a project-wide search/replace panel over every script file,
backed directly by the `searchScripts`/`replaceInScripts` commands (see
[cli.md](./cli.md#command-tour)), the same line-based, no-multiline-regex
matching either surface uses. Results group by file with a "N matches in M
scripts" summary (results cap at 500; narrow the query or the `--glob`
equivalent if you hit it).

Replace is a two-step flow, matching the CLI/MCP `--dry-run`/`dryRun`
convention: **Preview** runs the replacement with dry-run on and shows
per-file match counts with nothing written; **Replace all** then runs it
for real. A real apply goes through the normal command/undo pipeline, so
one **Undo** reverts every file the replace touched, atomically, like any
other command. Any open tab for a touched file reconciles automatically:
a clean tab silently reloads the new source, a dirty one gets the same
conflict banner as an external change.

## Shortcuts

`apps/editor/src/keybinds.ts`'s `KEYBINDS` table is the single source of
truth for every shortcut below: it drives both the global key dispatcher
and the in-app cheat sheet (press **`?`**, or **View → Keyboard shortcuts**),
and a test (`apps/editor/tests/keybinds.test.ts`) asserts the two can never
drift apart. If this table and that file ever disagree, trust the file.

| Shortcut | Action | Group |
| --- | --- | --- |
| ⌘Z | Undo | General |
| ⇧⌘Z | Redo | General |
| ⌘Y | Redo (alternate) | General |
| ⌘S | "Saved automatically" reassurance log (swallows the browser's Save dialog — see below) | General |
| ⇧⌘S | Save a checkpoint (`snapshotProject`) | General |
| ⇧/ (`?`) | Show keyboard shortcuts | General |
| ⇧⌘F | [Search across scripts](#search-across-scripts) | General |
| ⌘Enter | Play / Stop | Scene |
| F | Focus the selected entity (fit camera to bounds) | Scene |
| Space (hold) | Pan the canvas | Scene |
| Escape | Deselect · exit the current mode | Scene |
| ⌘D | Duplicate selection | Selection |
| Delete / Backspace | Delete selection | Selection |
| ↑ ↓ ← → | Nudge selection 1px | Selection |
| ⇧↑ ⇧↓ ⇧← ⇧→ | Nudge selection 10px | Selection |

(⌘ = Ctrl on Windows/Linux; the in-app cheat sheet renders the correct
symbols for your platform automatically.) "Selection" rows only fire while
an entity is selected; the rest are always live. Shortcuts yield to typing
(any focused `<input>`/`<textarea>`/contenteditable) and to an open dialog
(except Escape).

**Why ⌘S doesn't checkpoint:** projects save automatically after every
command, so there's no "unsaved changes" state for ⌘S to protect, but
typing ⌘S out of habit is common enough that it's still bound, purely to
intercept the browser's native Save-page dialog and log a reassurance
message ("Your changes are saved automatically"). Checkpointing needs its
own gesture (it resets the Changes panel's comparison point, which *is* a
meaningful action to trigger by accident), so it lives on **⇧⌘S** instead.

## Live panel

A read-only runtime inspector for the game while it's playing (empty with
a hint until you press Play). Polls the running `SceneRuntime` at 10Hz
(only while the panel is actually visible and a run is playing, so it costs
nothing when docked behind another tab), and shows, for one selected
entity (defaults to the current scene selection, or the first live entity;
pick any other from the dropdown, including ones spawned at runtime):

- **Identity/state**: name, id, tags, enabled, live world position, and
  `PhysicsBody` velocity if present.
- **Timers** and **Tweens**: every pending `ctx.timers`/`ctx.tweens` entry
  on this entity (interval/remaining/repeats for timers; property/progress/
  from/to for tweens), via `runtime.getSchedulerSnapshot(entityId)`.
- **Recent events**: the last 10 scene-wide `ctx.events.emit` calls
  (name + frame), newest first.

Every value shown is a specific typed field pulled off the live runtime,
never a raw state dump, matching the rest of the editor's no-raw-JSON
convention. Pair with [Pause and Step](#pause-and-step) to watch a value
change frame by frame instead of at full speed.

## Live iteration during play

While the game is playing, three kinds of edits apply to the running
scene without a Stop/Play round-trip:

- **Inspector property edits** dual-write: the change always goes through
  the normal `setComponentProperty`/`setProperties` command first (so it's
  saved and undoable exactly like when stopped), and while playing it's
  also live-patched straight into the running preview, so you see the
  effect immediately instead of after a restart. Camera fields
  (`Camera.ambientLight` and friends) take effect immediately this way.
- **Script edits hot-reload**: saving a script (Code panel Save, or
  format-on-save) swaps its compiled code into every live entity running
  it, preserving `ctx.vars`, timers, and tweens. See
  [scripting.md](./scripting.md#hot-reload-during-play) for exactly what
  survives, the `ctx.events.on` caveat, and how a compile failure is
  handled.
- **External agent edits apply too**: an `edit_script`, `setComponentProperty`,
  or `setProperties` command run by a CLI or MCP session against the same
  project (while this editor is open and playing) live-patches or
  hot-reloads the same way a local edit would, via the command journal
  (the editor resolves the current value with one read-only query first,
  since the journal records the target, not the value).

Some changes can't be applied to a running scene in place: adding or
removing an entity or component, reparenting, or anything else structural.
Those raise the **Scene changed — Restart** button next to Play/Stop
instead of guessing at a live patch; click it (or Stop then Play again) to
pick up the change.

## Direct-manipulation transform handles

Selecting an entity in the Scene View draws 8 resize handles (4 corners + 4
edge midpoints) plus 1 rotate handle floated above the box with a stem line.

- **Rotate** (top handle): drags `Transform.rotation`; hold Shift to snap to
  15° increments.
- **Resize** (the other 8): edge handles resize one axis, corner handles
  resize both (hold Shift on a corner to lock the aspect ratio). Handles
  resize about the box's center (not the opposite edge), so a resize
  gesture always commits as exactly one undo step, even a corner drag that
  edits two fields at once (see **Undo granularity** below).
- **What a handle actually edits** is resolved per selected entity, in this
  priority order, stopping at the first component present:
  1. `SpriteRenderer.width` / `.height`
  2. Box `Collider.width` / `.height` (a circle `Collider`: any handle
     drags `.radius` uniformly)
  3. `Transform.scale` (fallback when neither of the above applies)

  Polygon colliders keep their existing vertex editor ("Edit points")
  instead. Transform handles hide while point-edit mode is active.

- **Undo granularity**: every gesture commits as exactly **one** undo step,
  full stop. Most gestures touch a single scalar property, so that's one
  `setComponentProperty` call; a corner drag on a `SpriteRenderer` or box
  `Collider` edits two separate scalar fields at once (`width` **and**
  `height`, since there's no vec-shaped size property to set in one call), so it
  commits through `setProperties` instead, batching both writes into the
  same single undo entry (`HearthSession` snapshots once per `execute()`
  call, and `setProperties` is one `execute()` call regardless of how many
  keys it carries; see [cli.md](./cli.md#command-tour)). Older releases
  committed a corner drag as two sequential `setComponentProperty` calls
  (two undo steps for one gesture); that's fixed. Edge drags (which only
  ever touch one axis), circle radius, `Transform.scale`, and rotation all
  stay their original single `setComponentProperty` call.

## Animator editor

A typed, list-based editor for a state-machine asset's document (params,
states, transitions), with no raw JSON anywhere. Open it from the View menu,
the Assets panel's "Edit state machine" card action, or the Inspector's
`AnimationStateMachine` component row (which opens the asset the
component's `assetId` currently points at). Three sections, each backed
by a typed row list:

- **Params**: add/remove/rename, a type dropdown (`bool`/`number`/
  `trigger`), and a default-value field for `bool`/`number` params
  (triggers have none).
- **States**: add/remove/rename, an animation-asset picker (only
  `animation`-type assets), and a `speed` multiplier.
- **Transitions**: `from` (a state, or `any`), `to`, an optional
  `exitTime` (clip-progress gate, `0..1`), and a condition-row list per
  transition, each row picks a param and, for `bool`/`number` params,
  an operator (`=`/`≠`/`>`/`≥`/`<`/`≤`, narrowed to what that param type
  allows) and a value; trigger conditions are just the param name, no
  operator or value.

**Save** commits exactly one `updateStateMachineAsset` call (a single
undo entry) after validating the whole draft is complete (every state
has an animation, `initial` names a real state, every transition is
gated by at least one condition or an `exitTime`, and so on; the same
rules `StateMachineDataSchema` enforces on the CLI/MCP side, surfaced
here as inline field errors instead of a rejected command). See
[scripting.md](./scripting.md#animation-state-machines) for the asset
shape, `ctx.animator` API, and trigger semantics, and
[cli.md](./cli.md#command-tour) for the CLI/MCP equivalents
(`create asset state-machine`/`set-state-machine`).

## Autotile

Painting a 47-blob ("blob47") autotile terrain instead of single fixed
tiles: bind a `Tilemap` char to a sliced spritesheet and the tile's
on-screen frame is picked automatically from its 8 neighbours every time
the map changes, so a cave wall or a patch of grass gets consistent
edges/corners without hand-placing every variant.

**Per-char mode toggle** (Inspector, `Tilemap.tileAssets` row list; see
[components.md](./components.md#tilemap)): each char has a **Sprite** /
**Autotile** mode `<select>`, disabled (with an explanatory tooltip)
until the project has at least one sliced spritesheet asset to bind to.
Switching a char to **Autotile** shows a sheet picker (defaulting to the
first available sliced sheet), a locked "Blob47 (47-shape)" template
field (the only template today), and a collapsed **Advanced mapping**
section listing all 47 shape keys, each with a frame-name `<select>`
that defaults to the standard template name and can be overridden
per-shape. Every edit here dispatches its own `setTileAutotile` call (or
`setComponentProperty` for a plain sprite-mode char) rather than a
whole-map commit: the autotile rule shape is rejected by
`setComponentProperty` entirely, so it always goes through the dedicated
command.

**Frame-naming convention.** The standard blob47 template names every
frame `blob_<shapeKey>`, where `shapeKey` is a neighbour bitmask
(N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128) reduced from 256 raw
combinations to the 47 that are visually distinct: a diagonal neighbour
only changes a tile's silhouette when both of its adjacent edges are
also present, so a lone corner bit collapses away. `blob_0` is a fully
isolated tile (no same-char neighbours); `blob_255` is fully surrounded.
`sliceSpritesheet` always names frames sequentially (`<prefix>_0`,
`<prefix>_1`, … in row-major order). It has no way to produce
`blob_<shapeKey>` names directly, since a raw shape key (e.g. `4`, `7`,
`255`) isn't the same as a sequential slice index. In practice a tileset
laid out in the standard 47-tile order (many blob47 tilesets are) slices
to `blob_0`, `blob_1`, `blob_2`, … in that same order, so the Advanced
mapping section is where you translate: shape key `0` → `blob_0`, shape
key `1` → `blob_1`, shape key `4` (the 3rd tile in canonical order) →
`blob_2`, and so on, one row per shape key, done once per tileset. A
rule is only valid once every shape key it needs (every one of the 47,
unless overridden) resolves to a real frame on the sheet.

```
        N (1)
   NW  ┌───┐  NE
  (128)│ X │ (2)
        │   │
   W    │   │   E
  (64)  └───┘  (4)
   SW           SE
  (32)          (8)
        S (16)

  Edge bits set only when that exact neighbour holds the SAME char.
  A corner bit (NE/SE/SW/NW) counts only when BOTH adjacent edges are
  also set — e.g. NE only contributes if N and E are both present.
  shapeKey = sum of set bits, canonicalized this way; frame = blob_<shapeKey>.

  Example — a tile with neighbours to the N, E, and NE (a convex corner,
  both edges present so the diagonal counts):
    N(1) + NE(2) + E(4) = shapeKey 7  →  frame "blob_7"

  Example — a tile with only a NE neighbour (no N, no E):
    the NE bit is masked out (its edges aren't both set) → shapeKey 0
    →  frame "blob_0", same as a fully isolated tile.
```

Off-grid neighbours (map edges) always count as "same tile", so terrain
never sprouts a spurious outline at the map boundary. See
[cli.md](./cli.md#command-tour) for `hearth autotile set`, and
`packages/core/src/tilemap/autotile.ts` for the canonical bit order and
the full 47-shape table (`AUTOTILE_SHAPES`) if you need it verbatim.

## Particle preview

The Scene View toolbar's **Particles** toggle (persisted per-browser)
turns on a live, in-place simulation of the **currently selected**
entity's `ParticleEmitter`, drawn directly over the canvas, without
pressing Play. It runs only while the Scene panel is visible, the toggle
is on, and an entity with a `ParticleEmitter` is selected; deselecting,
hiding the panel, or switching off the toggle stops it. This is a
genuine simulation, not an approximation: it drives the same seeded,
deterministic `EmitterState` stepper the real runtime uses (own RNG
stream keyed by the emitter's `seed`, same size/color-lerp math), just
paced by real time instead of the fixed-timestep game loop, so what you
see previewing an emitter's `rate`/`spread`/`gravity`/colors while
dragging its Inspector fields is exactly what the emitter looks like in
Play or in an exported game. Editing a field restarts the preview from a
clean slate; dragging the entity around the canvas does not (particles
keep their world positions and new ones spawn from the emitter's current
location, matching real runtime behavior).

## Bulk import

The Assets panel's **Import…** button (multi-select file picker) and
whole-panel drag-and-drop both funnel through one `importAssets` call:
one atomic undo/journal entry regardless of how many files, with
collision-safe auto-suffixed naming (`walk -> walk-2`) instead of
failing on a name clash. Dropping a **folder** onto the panel walks it
recursively (dotfiles/dot-directories skipped) and imports every file it
finds, exactly like `hearth import asset <folder> --recursive` on the
CLI. See [cli.md](./cli.md#command-tour). A per-file 25 MB size cap and
an extension allowlist (images/audio/fonts) apply the same as a single
`Import…` pick; anything rejected shows up in the summary toast
("Imported N, skipped M (reason ×count)") rather than silently
vanishing or aborting the whole batch.

## Prefab authoring surfaces

- **Save as prefab** (Hierarchy, per-entity row action): serializes the
  selected entity's subtree via `createPrefab`.
- **Add to scene** (Assets panel, on a prefab asset's card): calls
  `instantiatePrefab` into the currently open scene.
- **Update prefab** / **Sync all** (Inspector, "Instance of `<name>`"
  banner shown when the selection carries a `prefab` marker): **Update
  prefab** re-serializes this instance over the asset and auto-syncs
  every other instance in the same command; **Sync all** force-rebuilds
  every instance from the asset's current payload after a preflight
  confirm dialog stating the affected count.
- **Override dots + per-field revert** (Inspector): once an instance's
  field diverges from its prefab (any direct edit to a non-root field;
  root name/position/enabled don't count, they're per-instance
  placement), that field's label grows a small ember dot and a **Revert**
  button appears next to it on hover, calling `revertPrefabOverride`
  scoped to that exact field. The banner itself shows a running
  "N overrides" count and a **Revert all** button (confirm-gated) that
  clears every override on the whole instance in one action.
- **Structural edits detach**: adding/removing a child entity or a
  component inside an instance breaks its live link: the instance's
  marker is removed (a `PREFAB_INSTANCE_DETACHED` warning explains why)
  and it becomes a normal, unlinked entity. Reparenting counts too, when it
  changes the subtree's membership: moving a member out of or within the
  subtree, or moving a foreign entity into it, detaches; duplicating a
  non-root member also detaches (duplicating the instance root instead
  spins up a second, independent, live-linked instance). Moving the
  instance root itself elsewhere in the hierarchy (without changing which
  entities belong to it) does not detach. Property edits never detach.

See [prefabs.md](./prefabs.md#editor-flows) for the full data model
behind all of this: the marker shape, implicit override recording, and
exactly what a merge-sync preserves vs. drops.
