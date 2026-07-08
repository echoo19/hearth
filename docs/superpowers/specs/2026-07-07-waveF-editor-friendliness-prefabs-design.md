# Wave F — Editor friendliness + Prefabs (v0.9.0)

Date: 2026-07-07. Status: approved by Jake (scope + both design sections).
Backlog source: §15 (editor UX friendliness, Jake 2026-07-07) + prefabs
(open since v0.8.0) in `2026-07-02-v0.3-engine-systems-backlog.md`.

Theme: the editor *feels* like a real editor (plain language, keyboard,
direct manipulation) and *authors* like a real editor (prefabs). Standing
rules apply: every system ships CLI/MCP-first; no engine chrome in shipped
games; human-facing copy changes never rename agent-facing CLI/MCP surface.

---

## Part 1 — §15 Editor friendliness

### 1a. Plain-language chrome

Human-facing editor copy drops engine jargon. CLI verbs, MCP tool names,
core command names, and AgentPanel CLI hint strings (`hearth snapshot`,
`hearth diff`) are **unchanged** — agents keep the real vocabulary.

Renames (user-visible strings only):

| Surface | Today | Becomes |
| --- | --- | --- |
| Toolbar button (`Toolbar.tsx:105`) | "Snapshot" — "Save the diff baseline (snapshotProject)" | **"Checkpoint"** — "Save a checkpoint you can review and restore" |
| Toolbar button (`Toolbar.tsx:108`) | "Diff" — "Show changes since the last snapshot" | **"Review"** — "See what changed since your last checkpoint" |
| Workspace panel title (`Workspace.tsx:33-45`) | `diff: 'Diff'` | **"Changes"** |
| DiffPanel danger button | "Revert to snapshot" — "revertProject: restore the last snapshot" | **"Restore checkpoint"** — plain sentence, no command name |
| DiffPanel empty-state hint | "The review workflow: press Snapshot… Refresh diff…" | Rewritten: checkpoint → edit → review, plain terms |
| DiffPanel/Toolbar success logs | "Snapshot saved. …baseline." | "Checkpoint saved. Review shows changes since this point." |
| SceneMenu delete confirm (`SceneMenu.tsx:261`) | "snapshot first if you want an undo point" | "save a checkpoint first if you want a restore point" (or lean on undo) |
| Agent Timeline (`Timeline.tsx:208`) | "Snapshot" | **"Checkpoint"** ("Review changes" / "Revert session" already plain) |
| ViewMenu checkbox label | "Diff" | "Changes" |

Also sweep: any remaining "diff"/"snapshot"/"baseline" in titles, tooltips,
confirm dialogs, and log lines across `apps/editor/src` — internal
identifiers (`diffFocusRequest`, `refreshDiff`, panel id `diff`) may stay;
only rendered strings change. The History panel keeps the name "History".

Visible **Undo / Redo buttons move into the main toolbar** (next to
Play/Stop), enabled-state driven by `listHistory` cursor exactly as the
DiffPanel buttons are today; DiffPanel keeps its copies. Tooltips show the
shortcut (⌘Z / ⇧⌘Z).

### 1b. Keybind registry + cheat sheet

New module `apps/editor/src/keybinds.ts`:

- Declarative table: `{ id, combo, mac/win display, scope, label, group,
  action }`. One window-level keydown listener dispatches from the table.
- Shared typing-guard: skip when target is INPUT/TEXTAREA/contentEditable,
  when InputSettings key-capture is armed (it already swallows at capture
  phase — keep that), or when a `<dialog>` is open (except Escape).
- Existing bindings migrate in: Cmd+Z undo, Shift+Cmd+Z / Cmd+Y redo
  (delete the ad-hoc listener in `App.tsx:37-56`). Space-pan and
  mode-Escape handling stay local to SceneView (pointer-modal, not
  commands) but get *rows in the cheat-sheet table* so they're documented.

New bindings (all no-op with a quiet log when nothing is selected /
inapplicable):

| Combo | Action |
| --- | --- |
| ⌘D | Duplicate selected entity (`duplicateEntity`) |
| Delete / Backspace | Delete selected entity (`removeEntity`, no confirm — undo covers it) |
| ⌘S | "Saved automatically" reassurance log — swallows browser save dialog. (Amended during Wave F execution: binding checkpoint to habitual ⌘S would silently overwrite the review baseline; checkpoint moved to ⇧⌘S.) |
| ⇧⌘S | Checkpoint (`snapshotProject`) |
| F | Focus/zoom SceneView camera on selection (fit entity bounds, sensible min/max zoom) |
| ⌘Enter | Play/Stop toggle |
| Arrow keys | Nudge selected entity 1px (`moveEntity` on key **release**/debounce so one undo step per burst, not per press) |
| Shift+Arrows | Nudge 10px |
| Escape | Deselect (only when no mode/dialog/popover consumed it) |
| ? (Shift+/) | Toggle shortcut cheat-sheet overlay |

Cheat-sheet overlay: modal rendered from the same table, grouped (General /
Scene / Selection), platform-correct symbols (⌘ vs Ctrl), closed by Esc/?/
click-out. Discoverable via a "Keyboard shortcuts" item in ViewMenu and the
`?` hint in the toolbar area.

### 1c. Direct-manipulation transform handles

Selected entity in SceneView gets standard node handles:

- **8 size/scale handles** on the selection box (4 corners + 4 edge
  midpoints) and **1 rotation handle** floated above the box center with a
  stem line.
- What corner/edge drags edit, by component priority on the selected
  entity: `SpriteRenderer.width/height` → box `Collider.size` (circle
  collider: radius via any handle, uniform) → `UIElement.size` → fallback
  `Transform.scale`. Exactly one target per gesture (the highest-priority
  present). Polygon colliders keep the existing vertex editor ("Edit
  points") — handles don't fight it; while point-edit mode is active,
  transform handles hide.
- Rotation handle edits `Transform.rotation`; Shift snaps to 15°
  increments. Size drags: corners edit both axes (Shift = lock aspect),
  edges edit one axis. Values round like existing drag-move; sizes clamp
  to a small positive minimum (no zero/negative via handles).
- Commit model matches drag-move and the vertex editor: live local ghost
  during drag; **one** `setComponentProperty` (or `moveEntity`) on pointer
  release with `{quiet:true}` → one undo step per gesture. Handles render
  in screen-space constant size (compensate zoom), with cursors per handle
  (nwse/ns/ew resize, grab for rotate).
- Handles respect play mode (hidden while playing) and multi-component
  entities (priority rule above); rotated entities get correctly rotated
  handle geometry (drag axes in entity-local space).

### Part 1 testing

- keybinds table unit tests (dispatch, guards, platform combos); cheat
  sheet renders every table row (no-drift assertion).
- handle-geometry math extracted pure (like `polygonEditing.ts`) and
  unit-tested: handle positions under rotation/zoom, drag deltas → new
  size/scale/rotation, clamps, snap.
- copy sweep test: grep-style assertion that rendered editor strings don't
  contain "snapshot"/"diff"/"baseline" outside allowlisted agent surfaces
  (AgentPanel hints) — keeps the jargon from creeping back.

---

## Part 2 — Prefabs (tracked stamps)

Model decision (Jake): **tracked stamps.** Instantiate = deep copy;
instances carry a marker pointing at the source prefab; a sync command
re-stamps on demand. No live linking, no per-field override machinery
(door stays open for a future wave).

### 2a. Data model

- `ASSET_TYPES` gains `'prefab'`. Payload at
  `assets/prefabs/<slug>.prefab.json`, validated by new `PrefabDataSchema`:
  `{ name, entities: PrefabEntity[] }` where entities use **normalized
  local ids** (`pfe_1`, `pfe_2`, … root first, `parentId` in local-id
  space; root `parentId: null`). Root `Transform.position` stored as
  authored; instantiate overrides it. Deterministic serialization (stable
  key order via existing writeJson conventions) so payloads diff cleanly.
- Instance marker: `EntitySchema` gains optional
  `prefab: { asset: string } | undefined` on the **root entity only**
  (additive schema change — old scenes parse unchanged; snapshots capture
  it for free via scenes).
- Asset index/trash/history/undo all inherited: prefabs are assets, and
  scenes already snapshot.

### 2b. Commands (4 new: registry 56 → 60), each with CLI verb + MCP tool

CLI verbs ship as a `hearth prefab <create|place|update|sync>` group
(mirrors the core names; `place` = instantiate, chosen for plain CLI
ergonomics). MCP tools: `create_prefab`, `instantiate_prefab`,
`update_prefab`, `sync_prefab_instances`.

1. **`createPrefab { scene, entity, name }`** — BFS the subtree
   (duplicateEntity's walk), normalize to local ids, write payload,
   `registerAsset` (unique-name rule). Source entity gets the instance
   marker (it becomes the first tracked instance). Errors: entity not
   found, name taken.
2. **`instantiatePrefab { prefab, scene, position?, name? }`** — read +
   schema-validate payload, fresh `ent_*` ids, remap `parentId` **and
   component-embedded entity-id references** (see audit note), apply
   `position` to root (default: authored position), `name` default
   `<prefabName>`, uniquified. Root gets marker.
3. **`updatePrefab { prefab, scene, entity }`** — re-serialize the given
   instance subtree back into the payload (entity must be a marked
   instance of that prefab; error otherwise).
4. **`syncPrefabInstances { prefab, scene? }`** — for every marked
   instance (one scene or all): rebuild the subtree from the payload with
   fresh child ids, **preserving per-instance root `name`,
   `Transform.position`, and `enabled`**; root entity id is preserved
   (references to the instance root stay valid); children are replaced
   wholesale. Returns per-scene counts. Deterministic ordering.
5. **`listPrefabs`** — *not* a new command: `inspectAssets` already lists
   by type; extend its output with prefab payload summary (entity count,
   root components) the way sheet frames surface today.

Adapter parity rule from Wave D applies: MCP `inputShape` mirrors and CLI
flags land in the same task as the core command — no drift.

**Component entity-ref audit**: before implementation, audit
`schema/components.ts` for entity-id-typed fields (e.g. camera follow
target if stored, etc.). `instantiatePrefab` and `syncPrefabInstances`
remap intra-prefab refs through the idMap; refs pointing *outside* the
prefab are preserved as-is. If the audit finds the existing
`duplicateEntity`/`duplicateScene` share the gap, fix there too (same
helper), with tests.

### 2c. Validation

New `validateProject` passes (ANIMATION_FRAME_NOT_FOUND pattern):

- `PREFAB_DATA_INVALID` (error) — payload fails schema / local-id refs
  broken (bad parentId, non-root-first).
- `PREFAB_SCRIPT_NOT_FOUND` / `PREFAB_ASSET_NOT_FOUND` (error) — payload
  components reference missing scripts/assets.
- `PREFAB_INSTANCE_ORPHANED` (warning) — entity marker points at a
  missing/non-prefab asset. `removeAsset` on a prefab with live instances
  warns (instances stay playable — they're full copies).

### 2d. Runtime: `ctx.scene.spawnPrefab(name, opts?)`

- Spawns a full instance at play time: `opts = { position?, name? }`;
  returns the root entity handle like `ctx.scene.spawn`. Children spawn
  with it. Deterministic (ids from the session's seeded generator path,
  consistent with existing runtime spawn), so playtests can assert
  (`assertEntityCount` and friends work unchanged).
- Prefab payloads must reach the runtime/player: export bundler and
  player `loadStore` include prefab assets (remember the Wave A lesson —
  player asset-content loading has bitten before; pixel/behavior-verify in
  an exported build).
- Lua parity: same dot-call surface, documented in `docs/scripting.md`
  + `ctxApi.ts` (so `hearth inspect api` and AGENTS.md pick it up —
  Wave A's CTX_API gap lesson).

### 2e. Editor surfaces

- **Hierarchy**: per-row "Save as prefab" action (icon button beside
  Duplicate/Delete); instance rows get a small prefab badge (icon +
  prefab name in tooltip). Uniform-control rule applies (no raw JSON).
- **AssetsPanel**: prefab cards (entity-count detail) with **"Add to
  scene"** (instantiate into current scene at viewport center) and
  **"Sync instances"** (confirm dialog stating scope: "Rebuilds N
  instances from this prefab. Names and positions are kept.").
- **Inspector** (root instance selected): small banner "Instance of
  <prefab>" with "Update prefab" (updatePrefab) and "Sync all" actions.

### Part 2 testing

- Core round-trip: create → instantiate → mutate → updatePrefab → sync
  preserves name/position/enabled, rebuilds children, id invariants hold.
- Ref-remap tests incl. the audit findings; cross-scene sync; orphan
  validation; undo across create/instantiate/sync (history snapshots).
- Runtime spawnPrefab determinism (two runs, same seed → same report
  hash), Lua + JS, and an exported-player behavior check.
- Example #10: prefab-driven spawner game (see below).

---

## Example, docs, release

- **10th example**: a wave/spawner game (working title "Ember Warrens"):
  enemies + pickups authored as prefabs, placed instances synced during
  authoring (generate.mjs exercises createPrefab/instantiatePrefab/
  updatePrefab/syncPrefabInstances so the command path is proven), and
  runtime `ctx.scene.spawnPrefab` waves. Playtests probe-derived (never
  hand-computed), determinism-pinned.
- **Docs**: new `docs/prefabs.md`; `docs/editor.md` (or equivalent
  section) gains shortcuts table + handles + plain-language chrome notes;
  scripting/cli/mcp/components docs updated; AGENTS.md/agentFiles
  regenerated; README/roadmap counts truth-pass (60 commands, 59 MCP
  tools expected — verify actual counts at close, don't trust this line).
- **Release**: v0.9.0 across package.json + constants; all examples
  regenerated; full `npx vitest run` + `npm run typecheck` (vitest does
  NOT typecheck — Wave B lesson); final whole-branch review before tag.
  Website sync post-release (feature copy only — **no example showcase**
  per standing rule).

## Non-goals

- Live-linked prefabs / per-field overrides (future wave).
- Nested prefabs (a prefab payload containing instance markers is
  flattened at create time — markers are stripped from children; only the
  new root carries one).
- Renaming CLI/MCP/core command names for the chrome work.
- Multi-select in SceneView (handles operate on single selection).
