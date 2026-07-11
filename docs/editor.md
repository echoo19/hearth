# Editor Guide

The editor is a dockable workspace over the same command system the CLI and
MCP server use — every button here is a thin wrapper around a core command
(`hearth <command> --json` does exactly what the click does). This page
covers the editor's own chrome, keyboard shortcuts, and direct-manipulation
scene tools. For panel-by-panel content (Inspector fields, Assets browser,
etc.) see the component and asset guides linked from each section below; for
the embedded agent terminal see [agent-panel.md](./agent-panel.md).

## Plain-language chrome

Human-facing editor copy avoids engine jargon; the underlying commands and
their CLI/MCP names (`snapshotProject` / `hearth snapshot`, `diffProject` /
`hearth diff`) are unchanged — agents and scripts keep the real vocabulary,
only the UI labels read differently:

| Button / panel | Label | What it does |
| --- | --- | --- |
| Toolbar | **Checkpoint** | `snapshotProject` — save a checkpoint you can review and restore |
| Toolbar | **Review** | Opens the **Changes** panel and refreshes it — see what changed since your last checkpoint |
| Toolbar | **Undo** / **Redo** | `undo` / `redo` — step through individual recorded changes |
| Changes panel | **Restore checkpoint** | `revertProject` — restore the project to the last checkpoint (confirm dialog) |
| Changes panel | **Refresh changes** | `diffProject` — recompute the diff against the last checkpoint |
| Agent panel timeline | **Checkpoint** / **Review changes** / **Revert session** | Same three operations, scoped to one agent session's activity |

"Checkpoint" and "Review" are the same operations documented elsewhere as
`hearth snapshot`/`hearth diff` — this page and the CLI/MCP docs are talking
about identical commands under different names for different audiences.

## Toolbar

Left to right: project name and scene picker, **+ Scene**, **Play/Stop**,
**Pause**/**Resume** and **Step** (enabled only while playing; see
[Pause and Step](#pause-and-step) below), **Undo**/**Redo** (enabled state
follows `listHistory`'s undo/redo cursor, tooltip shows the platform
shortcut), **Debug** (toggles the collider/ velocity/light debug overlay in
the preview — never on in exports), the view menu, **Checkpoint**,
**Review**, **Export**, and **Close project**. A "Every change saves
automatically" note sits near Export as a reminder that there's no separate
save step — see [⌘S](#shortcuts) below for why that matters for the
keyboard.

## Pause and Step

**Pause** freezes the running game in place without stopping it — the
`SceneRuntime` simply stops advancing fixed frames; nothing is torn down,
so **Resume** continues exactly where it left off. **Step** (enabled only
while paused) advances the frozen game by exactly one fixed frame per
click, for frame-by-frame inspection of physics/animation/script behavior
that's too fast to see at full speed. Both are toolbar buttons only, no
keyboard shortcut. Pair Pause/Step with the [Live panel](#live-panel) to
watch an entity's live state change one frame at a time.

## Code panel

A single-document script editor (CodeMirror 6, lazy-loaded — the CM6 chunk
only downloads once you actually open this panel) with a script picker,
dirty-state dot, Save (`⌘S` while the editor has focus), and:

- **`ctx.` autocomplete**: suggestions are generated from the same
  `CTX_API` array that backs `hearth inspect api` and
  [scripting.md](./scripting.md), so the completion list and the docs can
  never silently drift apart. Registered additively via CodeMirror's
  language-data facet, so JavaScript's own built-in keyword/snippet
  completions still work alongside it (Lua gets a small static
  reserved-word list on top, since the legacy Lua mode has no language-data
  completion of its own).
- **Inline lint**: every edit (debounced) runs the buffer through
  `checkScript` — the same read-only pre-flight command available on the
  CLI/MCP (see [scripting.md](./scripting.md#errors-and-validation)) — and
  surfaces diagnostics in CodeMirror's lint gutter, without ever saving the
  draft.
- **External-change follow**: if the open script changes outside the
  editor (another CLI/MCP session, an agent) while your buffer is clean, it
  silently reloads; while your buffer is **dirty**, it never overwrites
  your edits — a conflict banner offers **Reload** or **Keep mine**
  instead, so a later Save can never clobber an external change without you
  knowing.

## Shortcuts

`apps/editor/src/keybinds.ts`'s `KEYBINDS` table is the single source of
truth for every shortcut below — it drives both the global key dispatcher
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
command, so there's no "unsaved changes" state for ⌘S to protect — but
typing ⌘S out of habit is common enough that it's still bound, purely to
intercept the browser's native Save-page dialog and log a reassurance
message ("Your changes are saved automatically"). Checkpointing needs its
own gesture (it resets the Changes panel's comparison point, which *is* a
meaningful action to trigger by accident), so it lives on **⇧⌘S** instead.

## Live panel

A read-only runtime inspector for the game while it's playing (empty with
a hint until you press Play). Polls the running `SceneRuntime` at 10Hz —
only while the panel is actually visible and a run is playing, so it costs
nothing when docked behind another tab — and shows, for one selected
entity (defaults to the current scene selection, or the first live entity;
pick any other from the dropdown, including ones spawned at runtime):

- **Identity/state**: name, id, tags, enabled, live world position, and
  `PhysicsBody` velocity if present.
- **Timers** and **Tweens**: every pending `ctx.timers`/`ctx.tweens` entry
  on this entity (interval/remaining/repeats for timers; property/progress/
  from/to for tweens), via `runtime.getSchedulerSnapshot(entityId)`.
- **Recent events**: the last 10 scene-wide `ctx.events.emit` calls
  (name + frame), newest first.

Every value shown is a specific typed field pulled off the live runtime —
never a raw state dump — matching the rest of the editor's no-raw-JSON
convention. Pair with [Pause and Step](#pause-and-step) to watch a value
change frame by frame instead of at full speed.

## Direct-manipulation transform handles

Selecting an entity in the Scene View draws 8 resize handles (4 corners + 4
edge midpoints) plus 1 rotate handle floated above the box with a stem line.

- **Rotate** (top handle): drags `Transform.rotation`; hold Shift to snap to
  15° increments.
- **Resize** (the other 8): edge handles resize one axis, corner handles
  resize both (hold Shift on a corner to lock the aspect ratio). Handles
  resize about the box's center — not the opposite edge — so a resize
  gesture always commits as exactly one undo step, even a corner drag that
  edits two fields at once (see **Undo granularity** below).
- **What a handle actually edits** is resolved per selected entity, in this
  priority order, stopping at the first component present:
  1. `SpriteRenderer.width` / `.height`
  2. Box `Collider.width` / `.height` (a circle `Collider`: any handle
     drags `.radius` uniformly)
  3. `Transform.scale` (fallback when neither of the above applies)

  Polygon colliders keep their existing vertex editor ("Edit points")
  instead — transform handles hide while point-edit mode is active.

- **Undo granularity**: every gesture commits as exactly **one** undo step,
  full stop. Most gestures touch a single scalar property, so that's one
  `setComponentProperty` call; a corner drag on a `SpriteRenderer` or box
  `Collider` edits two separate scalar fields at once (`width` **and**
  `height` — there's no vec-shaped size property to set in one call), so it
  commits through `setProperties` instead, batching both writes into the
  same single undo entry (`HearthSession` snapshots once per `execute()`
  call, and `setProperties` is one `execute()` call regardless of how many
  keys it carries — see [cli.md](./cli.md#command-tour)). Older releases
  committed a corner drag as two sequential `setComponentProperty` calls
  (two undo steps for one gesture); that's fixed. Edge drags (which only
  ever touch one axis), circle radius, `Transform.scale`, and rotation all
  stay their original single `setComponentProperty` call.

## Prefab authoring surfaces

See [prefabs.md](./prefabs.md#editor-flows) for **Save as prefab**
(Hierarchy), **Add to scene** / **Sync instances** (Assets panel), and
**Update prefab** / **Sync all** (Inspector).
