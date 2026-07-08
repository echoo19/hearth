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
**Undo**/**Redo** (enabled state follows `listHistory`'s undo/redo cursor,
tooltip shows the platform shortcut), **Debug** (toggles the collider/
velocity/light debug overlay in the preview — never on in exports), the view
menu, **Checkpoint**, **Review**, **Export**, and **Close project**. A
"Every change saves automatically" note sits near Export as a reminder that
there's no separate save step — see [⌘S](#shortcuts) below for why that
matters for the keyboard.

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

## Direct-manipulation transform handles

Selecting an entity in the Scene View draws 8 resize handles (4 corners + 4
edge midpoints) plus 1 rotate handle floated above the box with a stem line.

- **Rotate** (top handle): drags `Transform.rotation`; hold Shift to snap to
  15° increments.
- **Resize** (the other 8): edge handles resize one axis, corner handles
  resize both (hold Shift on a corner to lock the aspect ratio). Handles
  resize about the box's center — not the opposite edge — so a resize
  gesture always commits as exactly one undo step (see below for the one
  exception).
- **What a handle actually edits** is resolved per selected entity, in this
  priority order, stopping at the first component present:
  1. `SpriteRenderer.width` / `.height`
  2. Box `Collider.width` / `.height` (a circle `Collider`: any handle
     drags `.radius` uniformly)
  3. `Transform.scale` (fallback when neither of the above applies)

  Polygon colliders keep their existing vertex editor ("Edit points")
  instead — transform handles hide while point-edit mode is active.

- **Undo granularity**: every gesture commits as **one** `setComponentProperty`
  call — one undo step — with one specific, spec'd exception: **a corner
  drag on a `SpriteRenderer` or box `Collider` edits both `width` and
  `height`, which are two separate scalar schema fields (there's no
  vec-shaped size property to set in one call), so a corner drag on those
  two kinds unavoidably commits two `setComponentProperty` calls — two undo
  steps for that one gesture.** Edge drags (which only ever touch one axis)
  and every other kind (circle radius, `Transform.scale`, rotation) stay a
  single undo step.

## Prefab authoring surfaces

See [prefabs.md](./prefabs.md#editor-flows) for **Save as prefab**
(Hierarchy), **Add to scene** / **Sync instances** (Assets panel), and
**Update prefab** / **Sync all** (Inspector).
