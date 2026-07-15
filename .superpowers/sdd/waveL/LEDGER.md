# Wave L — Editor Audit Ledger

Merged, deduped, severity-ranked findings from the 16 Phase-0 surface audits
(`.superpowers/sdd/waveL/audits/`) plus the Wave-K editor-facing tail
(`docs/superpowers/plans/2026-07-14-waveL-tightening.md`, Task 1 Step 4).

Entry format per plan §"Ledger conventions". Dispositions: `open` /
`fixed <commit>` / `by-design (<where>)` / `deferred-M (<why>)`. Nothing is
deleted; T13 fails if any entry is still `open`.

**Dedupe notes.** Three root-cause merges collapse many audit findings:
- **L-001** folds the runtime `attachKeyboard` global-`preventDefault` break
  (TOOLBAR-2/3, HIER-1). **L-002** is its sibling in the same input subsystem
  (PLAYMODE-1 axis-code gap) but a distinct fix, kept separate.
- **L-108** is the systemic "silent rejection / no inline field-commit
  feedback" pattern (INSPECTOR-1/2, INSPSPEC-1, INPUT-1/2/3/4, GAMESETTINGS-4,
  ASSETS-2, HIER-7) — one shared field-commit-feedback mechanism fixes all.
- **L-003** is the dockview init race — the intermittent null-`clear` crash
  plus the "all panels are closed" stale mount (TOOLBAR-9, ASSETS-3,
  INSPECTOR-6, and the crash seen by the agent + gamesettings + inspector +
  electron auditors).

**Re-ranking notes.** L-003 promoted to high defect (cross-audit evidence:
reproduced on essentially every fresh open by nearly every auditor; blocks
first contact). L-108 ranked high defect because it bundles four high-severity
defects behind one shared fix. INSPSPEC-3 kept at its auditor severity (polish
high) though it borders on a defect (values unreadable).

---

## runtime / core

### L-001 · runtime · defect · high
- Element: `PixiSceneView.attachKeyboard()` window `keydown` listener
  (`packages/runtime/src/pixi/index.ts` ~542-559), which `preventDefault()`s
  any key code the open project maps — installed unconditionally on mount,
  active even in edit mode / game not focused / not playing.
- Observed: three symptoms, one root cause —
  - Shortcut sheet `<dialog>` won't close on Escape (ember-horde maps
    `Escape`→pause) — TOOLBAR-2.
  - Toolbar buttons don't activate on Enter/Space (ember-horde maps
    `Enter`→ui-confirm) — near-universal keyboard-a11y break — TOOLBAR-3.
  - Hierarchy delete `ConfirmDialog` won't close on Escape — HIER-1.
  - Breadth: every mapped code (arrows, WASD, Space, Enter, Escape) gets
    window-level `preventDefault` at all times in any project; editor keybind
    dispatcher explicitly passes Escape through when a dialog is open, and the
    runtime defeats it.
- Expected: the runtime key capture must not `preventDefault` while an editor
  `<dialog>` is open, while the game canvas isn't focused, or while not
  playing. Editor/browser UI keys (Enter/Space/Escape/arrows) must work
  regardless of the project's gameplay bindings.
- Source: TOOLBAR-2, TOOLBAR-3, HIER-1
- Disposition: fixed c0fde3e (game keyboard capture gated on focus/dialog/paused; exports keep full capture via ambient body focus)

### L-002 · runtime · defect · high
- Element: `InputState.codeToActions` build (`packages/runtime/src/input.ts`
  ~111-140) + `attachKeyboard`'s `isMappedCode` gate.
- Observed: `codeToActions` is built only from `mappings.actions` /
  `gamepadButtons` / `gamepadAxes` — never from
  `mappings.axes[*].negativeCodes/positiveCodes`. So an axis-only code (WASD in
  drift-cellar: `KeyA/D/W/S` bound only to `moveX/moveY`) never passes
  `isMappedCode`, never reaches `handleKeyDown`/`downCodes`, and `axisValue()`'s
  keyboard fallback reads nothing → holding `KeyD` produces zero velocity.
  Arrow keys work only because drift-cellar also binds them to `ui-*` actions
  (coincidence). Affects the Game preview and, since this is
  `packages/runtime`, exported/built games too.
- Expected: axis `negativeCodes`/`positiveCodes` must be included in
  `isMappedCode` / `codeToActions` so WASD (and any axis-only binding) moves
  the player exactly like arrow keys. Same input subsystem as L-001, distinct
  fix.
- Source: PLAYMODE-1
- Disposition: fixed 35fbd9d (axis negative/positive codes registered as mapped codes; WASD verified moving the player in a real-browser export)

## workspace shell

### L-003 · workspace-shell · defect · high
- Element: dockview mount/init in `Workspace.tsx` (`buildDefaultLayout`'s
  `api.clear()`), and the panel-group mount lifecycle.
- Observed: two related dockview-init symptoms —
  - Intermittent uncaught `Cannot read properties of null (reading 'clear')`
    on project open (`api.clear()` racing a not-yet-ready dockview api),
    which leaves the toolbar `View` menu button disabled/unresponsive until
    a full page reload — seen by the agent, gamesettings, inspector-core,
    inspector-specialized, and electron auditors as an idle-time page error.
  - "All panels are closed / Reopen them from the View menu" shown in
    Hierarchy, Inspector, and the whole bottom tab group on essentially every
    fresh project open, even though the tabs exist and the View menu shows
    every panel checked (checkbox state disagrees with reality — TOOLBAR-9).
    Only toggling each panel off→on via the View menu forces a fresh mount;
    `View > Reset layout` does NOT fix it, a renderer reload does
    (electron-probe data point).
- Expected: panels mount when their tab exists/is clicked; the init `clear()`
  must not run against a null api; the View menu's checked state must match
  what's actually rendering. Blocks first contact with most panels on every
  open; the single highest-frequency issue across the whole audit.
- Source: TOOLBAR-9, ASSETS-3, INSPECTOR-6 (+ agent/gamesettings/inspector-
  specialized/electron page-error corroboration)
- Root cause: dockview paints the watermark into any group that has panels but
  no *active* panel. `buildDefaultLayout` seeds each side/bottom group's
  leading panel (hierarchy, inspector, assets) with `inactive: true`, so those
  groups came up headless and showed "All panels are closed" while their tabs
  existed; `toJSON` persisted the headless state (`activeView: null`) so warm
  reopens restored it too. Toggling a panel off→on re-added it *active*, which
  is why that (and only that) unstuck it. The intermittent null-`clear` crash
  is the same headless condition feeding dockview's fragile watermark/`clear`
  path, plus a stale-dock race where a View-menu closure calls `clear()` on a
  dockview disposed by a project switch / StrictMode remount.
- Fix: `ensureGroupsActive()` activates every headless group's first panel
  (Scene keeps global focus), called after both `buildDefaultLayout` and
  `fromJSON` (self-heals old persisted layouts); `resetLayout`/`showPanel`
  guard against a disposed dock via `isDockAlive`. Regression tests in
  `workspaceLayout.test.ts` cover the heal + focus-restore logic.
- Repro (headless, port 5315, swiftshader, fresh profile, ember-horde):
  before — watermark on 5/5 cold + 5/5 warm opens, only 1/4 group panels
  mounted. After — 0 watermark and 4/4 panels across 5 cold + 5 warm opens
  and 6 A↔B project switches; 0 null-`clear` pageerrors (incl. 80 extra
  reload loops). Full editor suite (798 tests) green.
- Disposition: fixed 341fcec

## toolbar + menus

### L-004 · toolbar · defect · high
- Element: Scene-actions "⋯" and View menu popovers — click-outside-to-close.
- Observed: clicking the Scene canvas (the largest surface) didn't dismiss
  either popover (SceneView's `stopPropagation` swallowed the document-level
  pointerdown the popovers relied on); clicks elsewhere closed them.
- Expected: clicking anywhere outside, incl. the canvas, dismisses the menu.
- Source: TOOLBAR-1
- Disposition: fixed 2b35b11 (Menu primitive owns click-outside/Escape; SceneMenu/ViewMenu migrated)

### L-005 · toolbar · defect · high
- Element: toolbar responsive behavior at narrow widths.
- Observed: no responsive handling at all — natural content width 1323px,
  `flex-wrap: nowrap`, `overflow-x: visible`, no media query. At 1024/900px
  Checkpoint/Review/Export/Close were pushed off-screen with no scroll or
  overflow path to reach them.
- Expected: a defined narrow-width collapse / overflow so no control becomes
  permanently unreachable at common laptop widths.
- Source: TOOLBAR-5 (Wave-K: "toolbar no collapse <1323px")
- Disposition: fixed 3c1d9c5 (toolbar slimmed to essentials + app menu bar)

### L-006 · toolbar · defect · med
- Element: `.restart-badge-slot` ("Scene changed — Restart") layout effect.
- Observed: badge appearing mid-play reflowed the toolbar — project name
  truncated further, "Every change saves automatically" wrapped and overflowed
  the 46px bar; the doc-comment claim that the slot reserves width when idle
  didn't match the CSS.
- Expected: badge appearance must not truncate/overflow other toolbar text.
- Source: TOOLBAR-4
- Disposition: fixed 3c1d9c5 (restart-badge reflow addressed in toolbar rework)

### L-007 · toolbar · friction · med
- Element: Undo/Redo console feedback — keybind vs. button.
- Observed: toolbar buttons log a specific message
  (`Undo: reverted "createEntity" (#44).`); ⌘Z/⇧⌘Z/⌘Y instead log a generic
  `undo: modified script, modified script, …` because keybinds call
  `store.exec('undo')` directly, bypassing the button wrapper's `quiet`+`log`.
- Expected: same action, same feedback regardless of trigger.
- Source: TOOLBAR-6
- Disposition: fixed 3c1d9c5 (undo/redo routed through the store)

### L-008 · toolbar · friction · low
- Element: View / Scene-actions popover keyboard navigation.
- Observed: ArrowUp/Down did nothing once open (focus stayed on trigger),
  despite `role="menu"`/`menuitem*` implying arrow-key nav; only Tab moved
  focus (DOM order, not roving-tabindex).
- Expected: implement Up/Down roving nav to match the ARIA menu contract (or
  drop the menu roles). May be partly resolved by the T4 Menu primitive;
  verify at T13.
- Source: TOOLBAR-7
- Disposition: fixed 2b35b11 (verified T9-U8, no further change needed) — the
  T4 Menu primitive implements the full contract this asked for
  (`menuNavIndex`: ArrowUp/Down with wrap, Home/End, separator/disabled
  skipping, roving tabindex reflected into DOM focus, first item focused on
  open) and both popovers this finding was filed against now render through
  it: SceneMenu uses MenuButton directly, and the old toolbar View menu became
  a MenuBar section (menu/MenuBar.tsx), which is also a MenuButton per
  section. Unit coverage in menu.test.tsx.

### L-009 · toolbar · polish · low
- Element: "View" toolbar button — missing `title`.
- Observed: every other primary toolbar control has a tooltip; View's is null.
- Expected: a short tooltip for consistency (may be moot after T6 folds View
  into the menu bar).
- Source: TOOLBAR-8
- Disposition: by-design (mooted by 3c1d9c5, verified T9-U8) — the standalone
  "View" toolbar button this was filed against no longer exists: T6's toolbar
  rework folded View into the app menu bar, where its trigger is a MenuButton
  with a visible text label plus `aria-label` (Menu.tsx renders both). A
  tooltip restating the visible one-word label would be noise; nothing left
  to fix.

### L-010 · toolbar · friction · low
- Element: Scene delete when only one scene exists.
- Observed: only-scene delete now surfaces a clear disabled reason
  ("Cannot delete the only scene in a project") instead of a bare disabled
  control.
- Expected: an actionable reason on the disabled affordance.
- Source: scene-lifecycle (toolbar verified-working)
- Disposition: fixed 9f1d11a

## hierarchy

### L-011 · hierarchy · defect · med
- Element: rename flow (inline input) — `renameEntity`.
- Observed: renaming "Hint"→"Player" yielded two rows named "Player";
  `renameEntity` has no uniqueness check, while every create path in the panel
  carefully uniquifies. Duplicate names make name-based command references
  ambiguous.
- Expected: reject/auto-suffix duplicate renames (or stop uniquifying on
  create) — one consistent invariant.
- Source: HIER-4
- Disposition: fixed 5a9e079 (renameEntity auto-suffixes a colliding rename, matching the create/instantiate uniqueness invariant) · 6a7d9d1 (editor cue: the Hierarchy now logs a one-line console info — `Renamed to "X 2" — "X" is already taken.` — when a rename settles to a different name than typed, so the auto-suffix isn't silent. Live-verified: renaming a row to "Main Camera" settled to "Main Camera 2".)

### L-012 · hierarchy · defect · med
- Element: "Save as prefab" on rows that are already prefab instances.
- Observed: the button renders identically on instance rows; `createPrefab`
  unconditionally overwrites `root.prefab`, silently re-linking the instance
  to the new asset and discarding its membership/overrides against the
  original — no warning, contradicting the row's own live-link badge.
- Expected: differentiate the affordance on instance rows or confirm before
  re-linking.
- Source: HIER-8
- Disposition: fixed b2fd8be (createPrefab severs the old live link and warns PREFAB_INSTANCE_RELINKED instead of silently re-linking; editor row-affordance differentiation remains editor-owned)

### L-013 · hierarchy · defect · med
- Element: no-op reparent (reparent to the same parent) — `moveEntity`.
- Observed: reparenting an entity to the parent it already has still runs the
  prefab-instance detach policy, detaching the instance for a change that
  changed nothing.
- Expected: a `parentId`-equality guard so a no-op reparent is a true no-op
  (no detach). Core-command fix.
- Source: Wave-K tail ("no-op reparent detaches")
- Disposition: fixed 5a9e079 (moveEntity skips the detach policy when the target parent equals the current parent)

### L-014 · hierarchy · friction · high
- Element: tree rows — drag-to-reparent / sibling reorder.
- Observed: rows aren't draggable at all; the only reparent path in the whole
  editor is the Inspector's Parent dropdown (one entity at a time, buried).
  Engine `moveEntity` already supports it (cycle guard + detach policy) — this
  is purely a missing UI affordance; table stakes vs. Unity/Godot/Unreal.
- Expected: drag-to-reparent in the Hierarchy.
- Source: HIER-2
- Disposition: fixed 6a7d9d1 (rows are draggable; drop ON a row reparents into
  it via moveEntity, drop on the panel background reparents to scene root.
  Drop-into highlight, a UI cycle-guard that refuses self/own-subtree drops
  before the drop, hover-dwell auto-expand of a collapsed target, and
  Escape/dragend clearing all drag state. Prefab-instance detach warnings ride
  moveEntity's own console output. Command GAP: moveEntity exposes no ordering
  (index) param, so between-rows sibling REORDER is not implemented — every
  drop reparents; reorder needs a core-command change. Inspector Parent
  dropdown remains as the keyboard-only reparent path. Live-verified in
  ember-horde: reparent, into-collapsed dwell-expand, drop-into highlight,
  Escape-cancel.)

### L-015 · hierarchy · friction · med
- Element: Delete/Backspace keybind vs. row trash button.
- Observed: keybind deletes instantly with no confirm (silently re-parenting
  children one level up); the trash button opens a ConfirmDialog that warns
  about exactly that. Two different deletion contracts.
- Expected: one deletion contract (both confirm, or neither).
- Source: HIER-3
- Disposition: fixed a5e733f (the Delete/Backspace keybind now bumps a
  `deleteSelectionRequest` counter instead of calling deleteSelection()
  directly; the Hierarchy observes it and opens the SAME ConfirmDialog as the
  row trash button. Both paths confirm. Live-verified: Delete on a selected row
  opens "Delete "…"?". Note: the dialog is Hierarchy-owned, so a keyboard delete
  while the Hierarchy panel is closed is a no-op rather than a silent delete —
  an acceptable trade for one honest contract.)

### L-016 · hierarchy · friction · med
- Element: tree keyboard navigation.
- Observed: `role="tree"`/`treeitem` declared but no keyboard contract —
  Arrow nav, Left/Right collapse-expand, F2, Home/End all absent; every row is
  a tab stop plus 4 more for a selected row's actions (~19 tab stops for 15
  entities).
- Expected: roving tabindex, arrow nav, Left/Right expand-collapse, F2 rename.
- Source: HIER-5
- Disposition: fixed 6a7d9d1 (roving tabindex — only the selected row (or first
  row) is a tab stop, action buttons are tabIndex=-1; ArrowUp/Down move
  selection, ArrowRight expands then steps into, ArrowLeft collapses then steps
  out to the parent, Home/End jump to the ends, F2 opens rename. Also closes
  HIER-12: rows now expose aria-level and aria-expanded. Nav logic is a pure
  `treeNav` helper with unit tests. Live-verified: arrow nav + collapse/expand
  in ember-horde.)

### L-017 · hierarchy · friction · med
- Element: row selection — multi-select.
- Observed: no multi-select; Shift/Cmd-click just replace the single
  selection. Multiplies the cost of L-014/L-015.
- Expected: Shift/Cmd range- and toggle-select for bulk ops.
- Source: HIER-6
- Disposition: deferred-M (T9-U8) — this is a selection-model rework, not a
  panel patch: `selection` is a single entity id across the store, SceneView
  (drag/gizmos/outline), Inspector (single-entity contract), Hierarchy
  (roving tabindex keyed to the one selected row), and the delete/reparent
  flows. Every consumer needs defined multi-select semantics (what does the
  Inspector show? what does drag-reparent move? what does the delete confirm
  name?) before the click modifiers mean anything. Real design work for the
  editor-ergonomics track / M, not a closing-sweep fix.

### L-018 · hierarchy · friction · low
- Element: panel search/filter.
- Observed: none; fine at 15 entities, unusable at scale.
- Expected: a filter box / Cmd+F scoping in the header.
- Source: HIER-9
- Disposition: deferred-M (T9-U8) — a tree filter is not the Assets panel's
  flat filter: matches must reveal their collapsed ancestors (or the result
  reads as missing children), and the filtered row list has to stay coherent
  with L-016's keyboard nav (`treeNav` walks the full visible-row model) and
  L-014's drag-reparent targets. That interaction design belongs with the
  editor-ergonomics track; at the audit's own 15-entity scale nothing is
  blocked today.

### L-019 · hierarchy · friction · low
- Element: tree rows — context menu.
- Observed: right-click shows nothing; all row ops live in the hover cluster.
- Expected: right-click menu mirroring row actions.
- Source: HIER-10
- Disposition: fixed 6a7d9d1 (right-click on a row opens a ContextMenu — a new
  cursor-anchored primitive in components/ui/Menu.tsx reusing MenuItems +
  dismiss contracts — with Rename / Duplicate / New child entity / Save as
  prefab / Delete (danger). Right-click on empty panel area offers New entity.
  Live-verified both in ember-horde.)

### L-020 · hierarchy · friction · low
- Element: tree contents during play mode.
- Observed: during play the tree shows only the 15 design-time entities while
  130+ spawned enemies run on screen, with no hint that this is the edit-time
  document (Live panel holds runtime state).
- Expected: a subtle play-mode header hint.
- Source: HIER-15
- Disposition: fixed b6e4b78 (while `playing`, the Hierarchy header shows a
  subtle "edit-time" detail chip whose Tooltip explains that this tree is the
  edit-time scene and runtime-spawned entities appear in the Live panel —
  keyboard-focusable so the explanation is reachable without a pointer).

### L-021 · hierarchy · polish · low
- Element: `.tree-name` native `title` tooltip.
- Observed: hovering an entity name shows the raw internal id (`ent_7ltyzbrz`).
- Expected: show the (truncated) name; ids belong in the Inspector header.
- Source: HIER-11
- Disposition: fixed 6a7d9d1 (`.tree-name` title is now `entity.name` — useful
  when the name is truncated with ellipsis; the id stays an Inspector/CLI
  concern. Live-verified: hovering a row shows "Main Camera", not `ent_…`.)

### L-022 · hierarchy · polish · low
- Element: Delete confirm dialog — initial focus.
- Observed: `autoFocus` on the confirm button loses a race to showModal's
  first-focusable (Cancel); Cancel-focused is arguably safer but is accidental.
- Expected: decide which button owns focus and wire it deterministically.
- Source: HIER-13
- Disposition: fixed 75de4be (decision made explicit in the shared
  ConfirmDialog: `danger` dialogs focus Cancel — Enter must never destroy
  something by reflex — and plain confirms focus the confirm button. Wired
  with refs + an effect that runs after Modal's showModal(), so the winner is
  deterministic, not a mount-order race; `autoFocus` removed. Applies to every
  ConfirmDialog in the app, incl. the Hierarchy delete this was filed on.)

### L-023 · hierarchy · polish · low
- Element: `.tree-actions` hidden-until-hover idiom (`display:none`).
- Observed: `display:none` removes row actions from tab order for unselected
  rows; the Inspector's `.field-revert-btn` deliberately uses opacity to stay
  tab-reachable — the two panels disagree. (T7 hover-only parity target.)
- Expected: one idiom repo-wide.
- Source: HIER-14
- Disposition: deferred-M (T9-U8 → T12) — picking the one idiom is exactly the
  kind of repo-wide consistency call the T12 design pass owns, and the naive
  unification (flip `.tree-actions` to the opacity idiom) would re-add ~4 tab
  stops to every selected row, undoing part of L-016's deliberate roving-
  tabindex cleanup (action buttons are tabIndex=-1 by design there). The two
  idioms currently coexist without breaking anything; T12 should decide
  opacity-vs-display *together with* the tab-order contract. Flagged for T12.
- Resolution (T12, design pass): kept BOTH idioms — each is correct for its
  context — and made the governing rule explicit instead of forcing one.
  Canonical rule documented as a "Reveal idiom" block in primitives.css:
  `display:none` for action CLUSTERS inside a roving-tabindex container
  (tree rows `.tree-actions`, asset cards `.asset-card-actions`; buttons are
  tabIndex=-1, so hiding costs no tab stop and preserves L-016's work), and
  `opacity:0` for STANDALONE tab-order controls that must stay Tab-reachable
  (`.field-revert-btn`, `.hearth-tab-close`, `.code-tab-close`). All five sites
  now carry a one-line back-reference to that note. The two opacity reveals were
  unified to the shared reveal timing `var(--t-fast)` (the tab-closes were on a
  stray 140ms literal). Focus parity verified at every site; added the missing
  `.dv-tab:focus-within .hearth-tab-close` so a keyboard-focused dockview tab
  reveals its close like the Code tab-cell already did. No idiom flipped, so no
  tab stops were re-added. Verified live (hover + focus reveal both fire).

## sceneview

### L-024 · sceneview · defect · high
- Element: any `UIElement`-anchored entity in the Scene view.
- Observed: SceneView positions entities purely from `Transform.position` up
  the parent chain; it never reads `UIElement.anchor`/`offset`. Every
  UI-anchored entity (ember-horde HUD/Pause Menu children, all at
  `position {0,0}`) collapses to world origin as overlapping illegible text,
  nowhere near its real screen anchor. Still selectable/draggable there, but a
  drag never affects the runtime position (runtime computes from anchor+offset
  via `uiScreenPosition`), so editing them in the Scene view is meaningless.
- Expected: render/select/drag UI-anchored entities at their resolved
  anchor+offset screen position matching `uiScreenPosition`.
- Source: SCENEVIEW-1
- Disposition: fixed a8220f5 (worldPos resolves UIElement entities via the runtime's resolveUiPositions — anchor/offset/UILayout — mapped 1:1 over the active camera; selectable, not scene-draggable, with an anchor+offset Inspector hint; live before/after verified in ember-horde)

### L-025 · sceneview · defect · med
- Element: entity drag-to-move and tilemap paint while `playing === true`.
- Observed: the transform-handle gizmo is hidden while playing, but the
  entity-drag and tilemap-paint paths have no `playing` guard — in a
  split-panel layout that keeps Scene+Game both visible (so Play stays
  running), a drag/paint would mutate the scene under the live game. In the
  default tabbed layout this is masked because leaving the Game tab hard-stops
  Play (see L-067). Flagged as a likely gap (couldn't force the split layout
  live — the tab-drag hung the automated session).
- Expected: guard drag/paint on `playing` for parity with `showHandles`.
- Source: SCENEVIEW-4
- Disposition: fixed a8220f5 (startPaint and the entity-drag start now early-return when `playing`, matching showHandles' guard, so a split-layout drag/paint can't mutate the live scene)

### L-026 · sceneview · friction · med
- Element: SceneView persistent hint bar (`SceneView.tsx` ~line 1852).
- Observed: a persistent floating hint bar sits over the scene chrome.
- Expected: **[JAKE-STEER 2026-07-14, mandatory]** delete the hint bar; the
  `?` shortcut sheet keeps the reference. No floating scene-level chrome.
- Source: JAKE-STEER (plan T9 Step 1)
- Disposition: fixed a8220f5 (`.scene-hint` element + its CSS deleted; pan/zoom/drag reference now lives solely in the ? sheet — pan label notes middle-drag, new "Move the selected entity (Shift snaps to grid)" row added; live-verified gone)

### L-027 · sceneview · friction · med
- Element: floating "Particles" toggle + its localStorage pref
  (`SceneView.tsx` ~111-131, ~1832; `hearth.scene.particlesPreview`).
- Observed: a floating scene-level "Particles" toggle governs emitter preview
  via a global pref.
- Expected: **[JAKE-STEER 2026-07-14, mandatory]** delete the floating toggle
  and its pref; emitter preview becomes always-on for selected emitters
  (object-owned, Unity/Godot model). If a control proves necessary it goes on
  the Inspector ParticleEmitter card, not floating chrome.
- Source: JAKE-STEER (plan T9 Step 1)
- Disposition: fixed a8220f5 (floating Particles toggle + `hearth.scene.particlesPreview` pref + read/write helpers deleted; setToggleEnabled(true) always, render gate is now selection+panel-visible only, so preview is always-on for the selected emitter; toggle-gone live-verified in ember-horde + glow-caves) · sceneview · friction · low
- Element: toolbar "Debug" button while the Scene tab is active.
- Observed: toggling Debug has zero effect on the Scene view (pixel-identical);
  SceneView never reads `store.debugDraw` — the flag only affects the Game
  tab's overlay. Scene gizmos always render and can't be hidden.
- Expected: gray out/relabel Debug on the Scene tab, or wire it to the Scene
  gizmo layer so "Debug" means one thing across tabs.
- Source: SCENEVIEW-2
- Disposition: by-design a8220f5 (scoped honestly: SceneView renders authoring gizmos — collider/light/particle/camera — unconditionally; Debug governs the Game runtime overlay. A true Scene debug-draw layer isn't "cheap via existing debugDraw data" — debugDraw is a bare boolean, the geometry would duplicate physics/collider rendering — and the toolbar relabel/disable lives in Toolbar.tsx/appMenu.ts, outside this file's serialized scope. Flagged for the Toolbar owner to relabel Debug on the Scene tab.) · Handoff resolved b2d701b (L-028, from B4): the toolbar Debug button was folded into the View menu during the T6 toolbar rework, so the honest-scope fix landed there — the View menu's "Debug overlay" item is relabeled "Game view overlay", naming exactly what it governs (the Game runtime overlay) and no longer implying a Scene effect. Existing `debug-overlay` id/checkbox tests unaffected (they key on id, not label).

### L-029 · sceneview · friction · low
- Element: move/resize drag vs. the always-drawn 32px grid.
- Observed: nothing snaps to the grid; move rounds to integer px, resize to
  integer px / 0.01 scale, never to a grid multiple. Only the rotate handle
  has an optional 15° snap. The grid is purely decorative.
- Expected: a modifier-triggered (or default) snap-to-grid to match the
  expectation the drawn grid sets.
- Source: SCENEVIEW-3
- Disposition: fixed a8220f5 (move-drag: hold Shift to snap to the 32px grid — snaps the WORLD position, mapped back through the ancestor offset to the committed local Transform.position; synthetic shift-drag verified snapping Arena to 64,32. Resize keeps Shift = aspect-lock and rotate keeps Shift = 15°, each handle's most useful modifier; resize grid-snap intentionally not added to avoid displacing aspect-lock.)

### L-030 · sceneview · polish · low
- Element: polygon Collider / LineRenderer vertex live-drag.
- Observed: during a vertex drag only the orange draft overlay updates; the
  real underlying shape keeps the pre-drag geometry until commit, producing a
  brief double-image on thick strokes.
- Expected: a single consistent live shape during the drag.
- Source: SCENEVIEW-5
- Disposition: fixed a8220f5 (renderLineRenderer draws from the live `draftPoints` while a vertex of the selected LineRenderer is being dragged — same local space as lr.points — so the real stroke tracks the orange guide with no stale double-image)

### L-031 · sceneview · polish · low
- Element: particle in-scene preview React list keys.
- Observed: the particle-circle preview uses array index as the React key.
- Expected: stable per-particle keys to avoid reconciliation churn.
- Source: Wave-K tail ("particle circle index keys")
- Disposition: by-design (T9-U8) — there is no stable identity to key on:
  runtime `Particle` objects carry no id and are POOLED/reused across spawns
  (EmitterState's free-list, packages/runtime/src/particles.ts), so object
  identity is also unstable. Adding an id field means touching the runtime's
  hot spawn path for an editor-only preview — an engine change the anti-bloat
  rule bars. And the churn concern doesn't apply here: each particle renders
  as a stateless leaf `<circle>` (no component state, no CSS transitions),
  so an index-keyed reconcile is pure attribute patching — exactly the cheap
  path. Index keys are the deliberate choice.

## inspector

### L-032 · inspector · defect · med
- Element: same-value instance edit → `recordInstanceOverride`.
- Observed: editing a prefab-instance field to its existing value still records
  an override, dirtying the instance against the prefab for a no-op edit.
- Expected: a value-equality check before `recordInstanceOverride` so
  same-value edits record nothing.
- Source: Wave-K tail ("same-value instance edits record overrides")
- Disposition: fixed 5a9e079 (setComponentProperty/setProperties skip recordInstanceOverride when the value is unchanged)

### L-033 · inspector · friction · high
- Element: `Tilemap.grid` (a `string[]` of raw row-strings).
- Observed: falls through to the generic `StringListField` (built for tag
  lists) — each grid row is a free-text input with "Add layer"/"Remove item N"
  copy and ZERO validation (any string, any length, chars absent from
  `tileAssets` all accepted silently), sitting directly under the carefully
  validated Tile Assets editor. The one place in the Tilemap card where a typo
  silently corrupts level layout.
- Expected: a dedicated Grid editor, or at least row validation against the
  current `tileAssets` char set + "row"/"Remove row N" copy.
- Source: INSPSPEC-4
- Disposition: deferred-M (T9-U8) — the honest fix is the dedicated grid
  editor (per Jake's direct-manipulation-editors direction, a paint/canvas
  surface, and the Scene view's TilemapPainter already IS that surface for
  the same data — the Inspector field is the fallback path). The "at least"
  half (per-row validation against tileAssets) isn't a small patch either:
  StringListField is a generic primitive with no access to the sibling
  tileAssets record, so validation means a bespoke Tilemap-grid branch in the
  Inspector — a mini-editor that M's real grid editor would immediately
  replace. Building the throwaway now is churn; belongs to the editor-
  ergonomics track with the painter as the mitigation in the meantime.

### L-034 · inspector · friction · med
- Element: `Script` component — `Script Path` and `Params`.
- Observed: `scriptPath` is a plain TextField (no picker/autocomplete/"open in
  Code"); `params` matches no typed branch and renders read-only via
  `UnsupportedField` (`JSON.stringify` + "edit via agent or CLI"). Player's
  gameplay knobs (speed/HP/cooldowns) are uneditable from the Inspector — the
  single biggest gap in "every field gets a real control", and the last
  raw-JSON surface (Jake's Inspector rule).
- Expected: a dropdown/picker for `scriptPath`, and a typed key/value editor
  (string→TextField, number→NumberField, bool→checkbox) for `params`.
- Source: INSPECTOR-5, INSPSPEC-8 (Wave-K: "Script.params raw-JSON fallback")
- Disposition: fixed 41cc00d (scriptPath → dropdown of the project's scripts/* with a Custom… free-text fallback; params → typed key/value editor — one row per param by inferred kind (number/boolean/string/color, lists + nested objects recursively), add/remove/rename keys, NO JSON textarea. Scalar edits write Script.params.<key> honoring the CommitOutcome rejection contract; add/remove/rename write the whole record. Record helpers in scriptParams.ts (0d87b21 widened the key column + monospaced keys). Live-verified in ember-horde: Player speed 170→250 round-tripped to the scene file and into the running game via Play with 0 runtime errors; added a param; no textarea/JSON dump renders. The last raw-JSON surface in the Inspector is closed.)

### L-035 · inspector · friction · med
- Element: Prefab-instance banner — "Update prefab" button.
- Observed: `handleUpdatePrefab` calls `exec('updatePrefab')` immediately with
  NO confirm, while its two neighbors ("Sync instances"/"Revert all") both get
  blast-radius-aware ConfirmDialogs — yet Update prefab is the broadest-blast
  action (rewrites the shared prefab every other instance reads).
- Expected: the same confirm treatment, ideally naming how many other
  instances exist (`countPrefabInstances` is already available).
- Source: INSPSPEC-5
- Disposition: fixed 17c29f1 ("Update prefab" now runs the same
  countPrefabInstances preflight as Sync (button shows "Checking…", result
  dropped if selection moved), then a danger ConfirmDialog whose body names
  the blast radius via new pure `updatePrefabConfirmBody(count)` — "N other
  instances read this prefab and will follow the update (each keeps its own
  overrides)", with an honest zero-others variant. prefabActions.ts +
  Inspector.tsx.)

### L-036 · inspector · friction · med
- Element: prefab-instance detach on structural edit (`detachOnStructuralEdit`).
- Observed: adding/removing a component on an instance silently detaches it —
  banner + Hierarchy badge vanish with no dialog, toast, or tab-badge; the
  explanation lives only in a Console log line the user has no reason to be
  watching. One-way from the Inspector's view (no reattach).
- Expected: a transient inline notice in the Inspector when a detach happens.
- Source: INSPSPEC-6
- Disposition: fixed 17c29f1 (the Inspector watches the selected entity's
  prefab marker: when it goes set → gone while the SAME entity stays
  selected, a dismissible inline banner appears where the prefab banner was —
  "Detached from the "<prefab>" prefab — adding or removing a component makes
  an instance standalone. Undo restores the link." The old asset id is
  captured before the link vanishes so the notice can name the prefab.
  Cleared on selection change or Dismiss.)

### L-037 · inspector · friction · med
- Element: component cards — collapse/expand.
- Observed: no collapse affordance anywhere; a multi-component entity (~40
  field rows) forces scrolling past cards you aren't touching.
- Expected: per-card collapse (chevron by the remove button, state persisted
  at least per session).
- Source: INSPECTOR-4
- Disposition: fixed 41cc00d (per-card collapse chevron on the header — a keyboard-reachable disclosure button, aria-expanded — plus a panel-header collapse-all/expand-all toggle; collapsed set persisted per project in localStorage, keyed by component type, via inspectorCollapse.ts (713b03d). Live-verified: collapsing Transform persisted across a full page reload; collapse-all folded all six of Player's cards to headers.)

### L-038 · inspector · friction · med
- Element: component remove confirm for `Transform`.
- Observed: removing Transform gets the same generic "Remove {Type}?" copy as
  any optional component, even though the command layer emits its own
  `REMOVED_TRANSFORM` warning ("the entity will not be positioned or
  rendered") that never reaches the dialog.
- Expected: a stronger, Transform-specific confirm mirroring what the command
  layer already knows.
- Source: INSPECTOR-3
- Disposition: fixed 41cc00d (removing Transform now shows Transform-specific confirm copy — "Without a Transform, '<entity>' will no longer be positioned or rendered in the scene." — mirroring the command layer's REMOVED_TRANSFORM warning; every other component keeps the generic copy.)

### L-039 · inspector · friction · med
- Element: `TileRowEditor` sprite-mode row.
- Observed: switching a tile-char row's mode away and back (or re-picking)
  forgets the previously assigned sprite asset, forcing re-selection.
- Expected: remember the prior asset across mode switches.
- Source: Wave-K tail ("sprite-mode forgets prior asset")
- Disposition: fixed 17c29f1 (TileRowEditor keeps per-row refs of the last
  sprite assetId AND the last autotile rule; switching modes restores the
  remembered value when its asset/sheet still exists, falling back to the old
  defaults otherwise — both directions, not just sprite).

### L-040 · inspector · friction · low
- Element: prefab-instance revert granularity.
- Observed: only per-field Revert and whole-instance "Revert all" exist; no
  "revert this component" in between, though a card is a natural unit (all 3
  Elite Enemy overrides live on SpriteRenderer, reverted one field at a time).
- Expected: a "Revert component" affordance in the component header.
- Source: INSPSPEC-7
- Disposition: fixed 41cc00d (a "Revert" button appears on a component card's header whenever any field in it is overridden on a prefab instance; it calls revertPrefabOverride with `component` and no `path`, which clears every override on that component at once — the Wave-I command granularity was already there. Live-verified: reverting Elite Enemy's SpriteRenderer card cleared all its overrides in one click.)

### L-041 · inspector · friction · low
- Element: `.field-revert-slot` column width on instances with zero overrides.
- Observed: a non-instance entity correctly reclaims full control-column
  width, but an instance with zero overrides still reserves the ~62px
  revert-slot on every row for consistency; the width isn't reclaimed where it
  could be. (T10 row-grid target.)
- Expected: reclaim the revert-slot width when the entity isn't a prefab
  instance / has no revertable field on that row.
- Source: Wave-K tail ("field-revert-slot width reclaim"), INSPSPEC verified-list
- Disposition: by-design (fixed 5e7b54e, pre-T10; re-verified during T10's
  row-grid unification, no further change needed). The slot is gated on
  `prefabInfo != null` (Inspector.tsx) — per-entity, not per-row: a
  non-instance entity reclaims the full control width on every row, exactly
  as this entry asks. A prefab instance always reserves the slot on every one
  of its rows even when that specific row isn't overridden, by deliberate
  choice (see the in-code comment above `.field-revert-slot`'s render site):
  gating per-row instead would make sibling rows in the same instance's card
  disagree on control width depending on each row's own override state,
  which reads worse than a consistently-reserved slot across the whole
  instance. T10 did not change this file's revert-slot logic.

### L-042 · inspector · polish · high
- Element: `PostEffectsField` `EffectFieldRow` number/color inputs.
- Observed: every post-effect numeric field renders as a ~36×36px square with
  the value not even wide enough to show a digit (compare the full-width
  `Ambient Light 0.15` two rows above). A user can't read strength/threshold/
  etc. without clicking into each box. Reproduces for every effect type.
- Expected: the input should stretch to fill its grid column like every other
  `.inspector-row`.
- Source: INSPSPEC-3
- Disposition: fixed 9a095c5, folded into the shared system by T10 (superseding
  commit 15b2169). The page-specific `.effect-card-body .inspector-row`
  override is gone; `EffectFieldRow` now applies a named, reusable
  `.editor-row--nested` class (primitives.css) that any nested row can opt
  into — same 84px compact label track and full-width control as before, just
  no longer scoped to PostEffects by a descendant selector. The Inspector's
  autotile Template row (L-043-adjacent, see below) now uses the same variant.

### L-043 · inspector · polish · med
- Element: `PostEffectsField` `EffectFieldRow` labels.
- Observed: raw camelCase schema keys shown verbatim (`strength`, `threshold`,
  `scanlineIntensity`, …) while every other Inspector field — including the
  effect *type* title above them — runs through `humanizeFieldLabel`.
- Expected: route `field` through the same humanize transform ("Scanline
  Intensity", not "scanlineIntensity").
- Source: INSPSPEC-2
- Disposition: fixed 9a095c5 (EffectFieldRow routes the field key through PostEffectsField's existing humanize() — "scanlineIntensity" → "Scanline Intensity" — matching every other Inspector label; the raw camelCase key stays in the row's title tooltip. Render test in postEffectsFieldRow.test.tsx.)

## assets

### L-044 · assets · friction · high
- Element: asset card — rename / delete / duplicate.
- Observed: no way to rename or delete an asset from the UI (no context menu,
  no details-row button, no keybind, no multi-select). `removeAsset` exists
  with excellent delete-while-referenced protection, but the messaging is
  reachable only by agents; a human can only edit assets.json by hand.
- Expected: card context menu / details-row Rename·Delete·Duplicate, delete
  surfacing the referenced-by conflict in a dialog.
- Source: ASSETS-1
- Disposition: fixed a4fe855 (T9-U3), scoped to delete only — rename/
  duplicate need new core commands (`renameAsset`/`duplicateAsset` don't
  exist yet) and are deferred so the editor never does something an agent
  can't mirror through a command. Delete ships as a per-card hover/focus
  trash `IconButton` (the `.tree-actions` idiom) plus a right-click context
  menu (Menu primitive) with Delete/Copy id/Assign to selection/Add to scene/
  a type-appropriate Edit item (Slice… for sheets, Edit state machine for
  asm, Play/Stop preview for audio). Delete confirms via `ConfirmDialog`,
  then calls `removeAsset({ deleteFile: true })`; a referenced-by CONFLICT
  opens a dedicated error dialog showing the command's own message verbatim
  (no summarizing). Live-verified headless (port 5328, sky-courier scratch):
  deleting a referenced sprite (`courier-sheet`) surfaced "Asset
  "courier-sheet" is still referenced by: Courier (ent_e11krpgv) in scene
  scn_85roa0bz. Remove references first." verbatim and left the card in
  place; deleting an unreferenced asset (`delivery-sound`) removed the card,
  moved the file into `.hearth/trash/<id>/`, and Cmd+Z undo restored both the
  card and the file to disk. Files: AssetsPanel.tsx.

### L-045 · assets · friction · med
- Element: asset grid — search / filter / sort.
- Observed: none; sky-courier's 19 assets sit in one flat insertion-order grid,
  found only by visual scan. Real projects will have hundreds.
- Expected: at least a name search; ideally a type filter (label already on
  every card).
- Source: ASSETS-4
- Disposition: fixed a4fe855 (T9-U3) — a filter input at the panel top
  matches name OR type substrings (so typing "stateMachine" filters by type),
  instant on every keystroke, Escape clears it, and Cmd/Ctrl+F focuses it
  whenever a card or the panel itself has focus. Sorting deferred (not asked
  for; insertion order is stable and the filter covers the "hundreds of
  assets" case the audit raised). Live-verified: "courier" narrowed 11 cards
  to 4, "stateMachine" to 1 (`courier-motion`), Escape restored all 11, and
  Cmd+F while a card was focused moved focus to the filter box. Files:
  AssetsPanel.tsx.

### L-046 · assets · friction · med
- Element: asset card — double-click.
- Observed: double-click runs the single-click toggle twice (select then
  deselect) — reads as a flicker/no-op; the primary action (open Animator /
  open Slice / play audio) never fires.
- Expected: double-click performs the asset's primary action (or at least
  doesn't undo the selection).
- Source: ASSETS-5
- Disposition: fixed a4fe855 (T9-U3) — double-click now explicitly selects
  the card (never a toggle) and runs a type-appropriate primary action:
  stateMachine opens the Animator, audio toggles its preview, prefab adds an
  instance to the current scene, everything else (sprite/tile/font/
  animation/data/other) assigns to the selected entity when a compatible
  component is present. Slice… was deliberately NOT made the sheet
  double-click action per the dispatch's judgment call — Slice is a heavier,
  less-frequent operation than Assign, and stays reachable via the details
  row / context menu. Documented per-card via the (non-interactive, Gate-D-
  exempt) `.asset-name` title rather than a Tooltip wrapper on every grid
  cell. Files: AssetsPanel.tsx.

### L-047 · assets · friction · low
- Element: asset grid — keyboard navigation.
- Observed: cards are Tab-focusable and Enter/Space toggle, but arrow keys do
  nothing; tabbing through 19+ cards is the only keyboard path.
- Expected: roving-tabindex grid nav (arrows move focus, Home/End).
- Source: ASSETS-6
- Disposition: fixed 10747ef (roving tabindex — the selected card, or the
  first, is the grid's ONE tab stop; ArrowLeft/Right step ±1 clamped,
  ArrowUp/Down step a whole row (column count read from the grid's computed
  gridTemplateColumns at keydown, so it tracks panel resizes), Home/End jump
  to the ends, Down from a full row above a shorter last row lands on the
  last card. Pure `gridNavIndex` helper unit-tested in assetsGridNav.test.ts
  incl. degenerate 0/1-column cases. Live-verified headless (port 5343,
  swiftshader, ember-horde): ArrowRight moved focus card 1→2, End jumped to
  the last card, exactly one card had tabindex=0.)

### L-048 · assets · friction · low
- Element: import error banner (`.export-errors`).
- Observed: after a failed/partial import the red banner persists indefinitely
  (no dismiss); it only clears when the next import starts.
- Expected: a dismiss ✕ (or auto-expiry once acknowledged).
- Source: ASSETS-7
- Disposition: fixed a4fe855 (T9-U3) — a corner ✕ (`.export-errors-dismiss`)
  clears `importErrors` on click; the pre-existing clear-at-next-import-start
  behavior (verified in the original audit) is unchanged. Scoped as
  `.export-errors-dismissible`, not the shared `.export-errors` base class, so
  Animator/export's own error banners (which have no dismiss control) are
  untouched. Live-verified: importing an unsupported `.xyz` file showed the
  banner; clicking ✕ removed it. Files: AssetsPanel.tsx, styles/panels/
  assets.css.

### L-049 · assets · friction · low
- Element: toolbar create affordances vs. `createSound`.
- Observed: toolbar offers "+ Sprite"/"+ Tile" only; the engine has a
  `createSound` command (procedural audio, even special-cased in the Agent
  Timeline) with no UI affordance — users can only import audio.
- Expected: a "+ Sound" affordance for parity, or a documented decision.
- Source: ASSETS-9
- Disposition: fixed 10747ef (a "+ Sound" toolbar Button between Tile and
  State machine opens a small dialog — name field + a preset `<select>` over
  the engine's real `SOUND_PRESETS` list (imported from @hearth/core, so the
  dropdown can never drift from what createSound accepts) — and calls the
  existing `createSound` command with no seed override, so the editor and an
  agent produce byte-identical audio for the same preset. On success the new
  card is selected; a CONFLICT (duplicate name) surfaces inline in the dialog
  per the L-108 idiom. Live-verified headless: preset list rendered
  coin…blip, creating "u8-test-blip" produced the audio card, re-creating the
  same name showed the command's conflict message inline.)

### L-050 · assets · polish · low
- Element: import skip-reason copy.
- Observed: the skip reason is a capability wall of text repeated per file; it
  never states the actual problem ("`.xyz` files aren't supported").
- Expected: lead with the problem, supported list secondary.
- Source: ASSETS-8
- Disposition: fixed a4fe855 (T9-U3) — `unsupportedExtensionReason()` now
  returns just `".xyz" files aren't supported` (or "files without an
  extension aren't supported"), dropping the images/audio/fonts capability
  list entirely per the audit's own alternative ("or in the Import button's
  tooltip only, where it already lives"). Live-verified banner text:
  `unsupported.xyz: ".xyz" files aren't supported`. Files: AssetsPanel.tsx.

### L-051 · assets · polish · low
- Element: prefab / stateMachine / unresolved-animation card thumbnails.
- Observed: faint `--ink-faint` icon on the checkerboard transparency
  background — reads as nearly empty, and the checkerboard implies
  "transparent image" for something that isn't an image.
- Expected: higher-contrast glyph on a flat tile; reserve the checkerboard for
  real image previews.
- Source: ASSETS-10
- Disposition: fixed a4fe855 (T9-U3) — a new `.asset-thumb-glyph` span (22px
  icon, `--ink-mute`, `position: absolute; inset: 0` on a flat `--bg-3` tile)
  fully covers the checkerboard for these three cases; every other thumbnail
  kind (sprite/tile image, resolved animation crop, audio button, font
  sample) is unchanged. Live-verified via a card screenshot: the stateMachine
  card now shows a clearly-visible animator glyph on a flat dark tile instead
  of a barely-visible icon on the transparency pattern. Files: AssetsPanel.tsx,
  styles/panels/assets.css.

### L-052 · assets · polish · low
- Element: audio asset details row.
- Observed: shows only name/path/id/Copy-id/Assign — no play control, no
  duration/format (sheets get a FrameGrid, fonts a live sample; audio nothing).
- Expected: details-row play/stop + duration/format.
- Source: ASSETS-11
- Disposition: by-design (T9-U3) — duration/format scoped down to "if cheaply
  available from probe metadata (skip if not stored)" per the dispatch;
  `assetCommands.ts`'s import path only runs `probeImage` (dimensions), never
  an audio probe — `asset.metadata` never carries a duration/format field to
  read. Reading `HTMLAudioElement.duration` client-side would mean creating a
  real `<audio>` element per audio card just to show a number, which isn't
  "cheap" at the "hundreds of assets" scale the audit itself raised (L-045).
  Deferred to whichever phase adds an audio-metadata probe to the import
  command; the details-row play/stop control this entry also asks for
  already exists (the card's play button plus the existing Assign row) and
  was out of this pass's scope. Not touched.

## code

### L-053 · code · defect · high
- Element: Space key inside the Code panel editor (`.cm-content`).
- Observed: pressing Space inserts nothing (`hello world`→`helloworld`);
  `insertText` works, proving CodeMirror accepts the char — only the discrete
  keydown path is broken. Root cause: `SceneView.tsx`'s hold-Space-to-pan
  handler (lines ~476-495) is installed on `window` unconditionally and uses
  its own narrow `isTyping` (INPUT/TEXTAREA/SELECT only, no
  `isContentEditable`), so it `preventDefault`s Space over CodeMirror's
  contenteditable div project-wide. Breaks writing virtually any line of code.
- Expected: use the shared `isTypingTarget()` (or check `isContentEditable`)
  in the space-to-pan guard. (Root cause file is SceneView.tsx.)
- Source: CODE-1
- Disposition: fixed a8220f5 (space-to-pan guard replaced its narrow INPUT/TEXTAREA/SELECT check with the shared isTypingTarget via a new pure panSpaceKey helper, so it yields to CodeMirror's contenteditable; live-verified "hello world foo bar" types with spaces intact in the Code panel)

### L-054 · code · defect · high
- Element: external-edit detection for a script changed directly on disk
  (bypassing the command layer — shell, another editor, an agent using plain
  file writes).
- Observed: writing `scripts/enemy-chase.lua` directly (no journal entry)
  produces NO conflict banner even with a dirty buffer open; a subsequent Save
  silently clobbers the external edit. The whole mechanism watches only
  `.hearth/log/commands.jsonl`, which only CLI/MCP/editor writes — the CLI path
  IS detected correctly. Real clobber risk for agents using ordinary
  file-edit tools.
- Expected: at minimum document the limitation; ideally an mtime/hash check on
  Save or a filesystem watch on `scripts/` as a backstop.
- Source: CODE-2
- Fix: save-time backstop in `CodePanel.runSave` — before writing, re-read the
  on-disk source and, if it no longer matches the buffer's saved baseline,
  raise the existing conflict banner instead of overwriting (pure
  `shouldBlockSaveForDrift` decides). `keepMine` now adopts the on-disk bytes
  as the new baseline so the next Save knowingly overwrites (and doesn't
  re-flag the edit the user chose to keep). No server/fs-watcher change needed —
  a content comparison is cheaper and more precise than mtime.
- Repro (headless, port 5320, swiftshader, ember-horde): open a dirty buffer,
  write the script directly on disk via fs.writeFileSync (no journal entry),
  click Save → conflict banner appears (was: none) and the external marker is
  still on disk (not clobbered). Editor suite + typecheck green.
- Disposition: fixed 90191ea

### L-055 · code · defect · med
- Element: `ctx.` hover docs (`hoverDocs.ts` `hoverTooltip`).
- Observed: hovering a `ctx.scene.find`-style token never produced a
  `.cm-ctx-hover` tooltip across multiple synthesis methods, while `ctx.`
  autocomplete rendered fine in the same session. Flagged medium-confidence:
  headless hover-dwell is hard to trust; implementation reads soundly and has
  unit tests. Needs a real-browser sanity check before treating as confirmed.
- Expected: `ctx.` hover docs appear on dwell (verify manually).
- Source: CODE-5 (unconfirmed)
- Disposition: by-design (verified working, T9-U8 — no code change). Live
  re-check in a real Chromium (headless shell, swiftshader, port 5343,
  ember-horde, horde-director.lua): hovering the `vars` segment of
  `ctx.vars.count` with a real mouse-move sequence produced the
  `.cm-ctx-hover` tooltip with the signature ("vars: Record<string,
  unknown>") and description. Two audit-artifact explanations confirmed:
  (1) synthetic hover-dwell often fails to trip CM6's hoverTooltip, exactly
  the caveat the auditor flagged; (2) hovering the bare `ctx` token shows
  nothing BY DESIGN (`ctxChainMatchAt` returns null before the first dot —
  "ctx" alone isn't a documented path), which a probe aimed at the chain's
  start would misread as broken.

### L-056 · code · friction · med
- Element: ⌘S while the Code panel is open but focus is outside CodeMirror
  (checkbox, script picker, banner button).
- Observed: the keypress falls to the global `save` keybind, which only logs
  "Your changes are saved automatically — no need to save." and never calls
  the panel's `save()` — leaving the dirty script unsaved while telling the
  user it's safe. The Code panel is the one surface where auto-save is false.
- Expected: the global binding should route to the real save when a dirty
  script buffer is open.
- Source: CODE-3
- Disposition: fixed b319cba (the Code panel root claims mod+s: when focus is
  anywhere in the panel but OUTSIDE CodeMirror it preventDefault+
  stopPropagations — same pattern as the Animator's L-081 fix, so the global
  "saved automatically" keybind never sees it — and runs the real `save()`
  through the existing `shouldSave` guard (no-op when clean/saving). Focus
  inside `.cm-editor` is explicitly yielded to CM6's own Mod-s keymap so the
  key can't double-save. Live-verified headless: dirtied a script, focused
  the toolbar Search button, pressed ⌘S → dirty dot cleared, zero "saved
  automatically" console lines.)

### L-057 · code · friction · med
- Element: Code panel empty state + lack of a "new script" affordance.
- Observed: the empty-state hint points at a "Script component in the
  Inspector" that does not exist, and there's no New-script button anywhere;
  the only `createScript` caller is a missing-file recovery path. A human with
  a blank project and no agent has no discoverable path to a first script.
- Expected: fix the false hint, or add a real "New script" action /
  Script-component path.
- Source: CODE-4
- Disposition: fixed b319cba (both halves: a "New script" toolbar button +
  the same action in the no-scripts empty state open a small dialog — name +
  Lua/JS language select — that calls the existing `createScript` command
  (template source) and opens the new file in a tab; command failures (e.g. a
  name CONFLICT) render inline. The empty-state hint no longer points at a
  flow that can't create a file: "Scripts drive entity behavior via the
  Script component. Create one here, or ask an agent." — icon + one-line
  purpose + primary next action, per the T9 standing item. Live-verified
  headless: creating "u8 probe" opened u8-probe.lua in a tab.)

### L-058 · code · friction · med
- Element: open script buffers across a project switch.
- Observed: the Code panel carries the prior project's open file/buffer into a
  newly opened project instead of resetting.
- Expected: reset Code-panel buffers on project switch.
- Source: Wave-K tail ("Code panel carries prior file across project switch")
- Fix: two parts — (1) CodePanel resets its buffer list / state cache when
  `projectPath` changes (covers a persisted mount); (2) `afterOpen`/`selectScene`
  clear the store's `codeOpenRequest`, so a stale "open this script" request
  from the previous project can't re-open a now-missing script when the Code
  panel remounts on the layout rebuild. Also, verified the close-project
  data-loss gap: `closeProject` was an unconfirmed in-place reset, so unsaved
  script buffers were silently discarded (scripts are the one non-autosave
  surface). Added a confirm: CodePanel publishes `hasUnsavedScripts`; the
  "Close project" menu routes through `requestCloseProject()`, which closes
  immediately when clean but bumps `closeProjectRequest` (Workspace reveals the
  Code panel, CodePanel shows a "Discard and close" ConfirmDialog) when dirty.
- Repro (headless, port 5320): open a script in project A via the toolbar
  dropdown (tab present), switch to project B → Code panel tabs reset to none.
- Disposition: fixed 90191ea (+ ddae647 stale-request clear)

## console / changes

### L-059 · console-changes · defect · high
- Element: Console auto-scroll effect (`scrollTop = scrollHeight`, keyed on
  `entries.length`).
- Observed: two symptoms of one effect —
  - Keyed on `entries.length`, which pins at `MAX_CONSOLE = 500` forever once
    the cap is hit, so the effect never re-fires and the view freezes
    mid-list while entries keep arriving underneath (scrollTop 542 of 10707).
  - Below the cap it fires on *every* entry with no scroll-position check:
    scroll up to reread an error and any new log line yanks you back to bottom
    (no scroll-lock).
- Expected: key on the last entry's id (or a monotonic counter) AND only
  auto-scroll when the user was already at/near the bottom — one change fixes
  both.
- Source: CONSOLE-CHANGES-1, CONSOLE-CHANGES-2
- Fix: the auto-scroll effect keys on the last entry's monotonic `id` instead
  of `entries.length` (so it never goes dormant once the list pins at
  MAX_CONSOLE), AND only scrolls to the bottom when the user was already parked
  there — a `stickToBottom` ref updated by the body's own scroll handler (pure
  `isNearBottom` predicate). One change fixes both symptoms.
- Repro (headless, port 5320): pump 600 log lines → 500 rendered, view pinned
  to bottom (scrollTop 10510/10707); scroll to top + pump 20 more → stays at 0
  (scroll-lock holds); scroll to bottom + pump 1 → resumes following. Editor
  suite + typecheck green.
- Disposition: fixed 298c7b5

### L-060 · console-changes · defect · high
- Element: Checkpoint (⇧⌘S + toolbar button) and Undo/Redo (Changes-panel +
  toolbar) vs. the Changes-panel diff body.
- Observed: `store.checkpoint()`, `Toolbar.snapshot()`, and `DiffPanel`'s
  undo/redo all mutate state but none call `refreshDiff()`, so when the
  Changes panel is the focused tab it keeps showing the stale diff (or stale
  "no checkpoint" empty state) — the console message promises a fresh
  comparison that the panel doesn't reflect until a manual Refresh or a tab
  blur/refocus. Verified for both checkpoint and undo (405→406 still shown
  after the position reverted server-side).
- Expected: every one of these call sites calls `refreshDiff()` on success,
  like `DiffPanel`'s own in-panel Checkpoint already does.
- Source: CONSOLE-CHANGES-5, CONSOLE-CHANGES-6
- Fix: `store.checkpoint()` calls `refreshDiff()` on success; `store.undo()`/
  `store.redo()` call it too, guarded by `refreshDiffIfTracking()` (only when a
  baseline is tracked — `snapshotTaken` or a diff already on screen — so an
  undo with no checkpoint doesn't spam a NOT_FOUND info line). DiffPanel's own
  Undo/Redo/Checkpoint buttons now delegate to these shared store actions (same
  friendly log line, same refresh) instead of a duplicated local `exec`.
- Repro (headless, port 5320, Changes tab focused): Checkpoint → diff refreshes
  with no manual Refresh; move an entity, Undo → diff body updates immediately
  (was: stale until a manual Refresh / tab blur). Editor suite + typecheck green.
- Disposition: fixed 62c8e13 (the store.ts fix — `checkpoint()`'s `refreshDiff`,
  `refreshDiffIfTracking()`, and undo/redo call sites — landed here; the
  follow-up 9aebc72 only migrated DiffPanel's own Undo/Redo/Checkpoint buttons
  to delegate to those shared store actions)

### L-061 · console-changes · defect · med
- Element: Console error entry for a script load failure at scene start/Play.
- Observed: the message contains the line (`shake-toggle.lua:14`) but the
  clickable link renders bare `scripts/shake-toggle.lua` with `link.line`
  null, opening the file at the top. The reload-path failure correctly
  extracts and links the line for the identical error shape — the extraction
  logic exists, it's just not applied on the initial-load path.
- Expected: apply the same line-extraction on the load-time path.
- Source: CONSOLE-CHANGES-3
- Fix: `recordRuntimeError` recovers the line from the message when the runtime
  left `error.line` null — a `lineFromMessage(script, message)` helper matches
  the `<script>:<digits>` occurrence (skipping the "Failed to load script
  <path>:" prefix) — so the load-time link jumps to the exact line like the
  reload path already does. Both the Console link and the message text reflect
  the recovered line.
- Repro (headless, port 5320): record a load-time compile error with line null
  but ":14" in the message → console link is `{path, line: 14}` (was: null).
- Disposition: fixed 62c8e13

### L-062 · console-changes · defect · med
- Element: Console entries for a hot-reload compile failure while playing.
- Observed: a single failure logs two near-identical lines (a `runtime`
  `recordRuntimeError` line and a `Hot-reload failed:` line) because
  `reloadScript` both returns `{ok:false}` (which `applyReload` logs) and
  internally calls `recordError` (which bridges to another log).
- Expected: one user-visible line per failure.
- Source: CONSOLE-CHANGES-4
- Fix: `recordRuntimeError` skips the Console log when `error.phase === 'reload'`
  (still records it into `runtimeErrors`). A hot-reload compile failure is
  already surfaced as one "Hot-reload failed: …" line by `applyReload` (which
  logs the `{ok:false}` result of `view.reloadScript`); the runtime also bridges
  the same error here via `recordError(phase:'reload')` → `onErrorEntry`, so
  suppressing that second log leaves exactly one user-visible line per failure.
- Repro (headless, port 5320): bridge a reload error via recordRuntimeError with
  phase:'reload' → 0 extra console lines (applyReload owns the single line).
- Disposition: fixed 62c8e13

### L-063 · console-changes · friction · med
- Element: undo/redo History-list rows (`.history-row`).
- Observed: each row is a plain `<div>` with no `onClick` — clicking does
  nothing, though the `seq` maps 1:1 to an undo/redo target, so click-to-jump
  reads as an expected affordance that isn't there (and no hover state).
- Expected: make rows clickable (jump the undo cursor), or make them not look
  interactive.
- Source: CONSOLE-CHANGES-8
- Disposition: by-design (T9-U8, taking the finding's second branch) — the
  rows already satisfy "not look interactive": plain divs with NO hover
  state, no cursor:pointer, no button styling (changes.css `.history-row` is
  padding + ink colors only); the audit itself noted the missing hover state.
  Click-to-jump is a real feature, not an affordance patch: the engine has no
  jump-to-seq command, so it means chaining N undo/redo execs with busy
  state, partial-failure semantics, and cancel — that belongs to the
  editor-ergonomics track if history scrubbing is ever wanted. Flagged for
  T12 as a candidate, not owed by this sweep.
- Resolution (T12, design pass): NOT implemented — by-design stands. Judged
  live against the goal ("reads as one deliberately designed product", quiet >
  loud): the history rows already read correctly as a non-interactive log
  (plain mono, no hover, no pointer cursor), so there is no affordance
  mismatch to fix. Click-to-jump remains a genuine feature (needs a
  jump-to-seq mechanism: chained undo/redo execs with busy + partial-failure +
  cancel), which belongs to the editor-ergonomics track, not a design-language
  pass. Adding it would introduce a loud new interaction the wave's scope
  explicitly defers. Coherence is better served by leaving the rows quiet.

### L-064 · console-changes · polish · low
- Element: Console toolbar — no level filter / search.
- Observed: only "Validate project" and "Clear"; no level/source filter, no
  text search. Compounds L-059/L-062 under a chatty run.
- Expected: at least a level filter / "errors only" toggle.
- Source: CONSOLE-CHANGES-9
- Disposition: fixed 252122a (All/Info/Warn/Errors chips in the Console
  toolbar — one active at a time, aria-pressed segmented group; pure
  `filterConsoleEntries` unit-tested in consoleFilterCopy.test.ts. A filter
  that hides everything shows a "No <level> entries" empty state with a
  "Show all" reset. Live-verified headless: Errors narrowed the list to
  level-error rows only, All restored it.)

### L-065 · console-changes · polish · low
- Element: Console entries — copy affordance.
- Observed: no per-entry or bulk copy; getting an error out means manual
  cross-span text selection.
- Expected: a per-row copy icon or "Copy all".
- Source: CONSOLE-CHANGES-10
- Disposition: fixed 252122a (a "Copy" toolbar button — the audit's "Copy
  all" branch — copies the VISIBLE (filtered) entries as plain text, one
  line per entry incl. timestamp/level/source and the script link location
  when present (pure `consoleEntriesText`, unit-tested); button flips to
  "Copied" for 1.2s, disabled when nothing is visible. Composes with the
  L-064 chips: filter to Errors, Copy, and the clipboard holds just the
  errors. Live-verified headless with clipboard permission granted: the
  clipboard held the formatted lines.)

### L-066 · console-changes · polish · low
- Element: duplicate console entries from React StrictMode double-mount (dev).
- Observed: `GamePreview`'s mount effect can run twice in dev, producing exact
  duplicate error lines for one failure; compounds L-062. Likely dev-only.
- Expected: guard the mount effect (or accept as dev-only), noted for
  awareness.
- Source: CONSOLE-CHANGES-11
- Disposition: by-design (T9-U8, taking the finding's own "accept as
  dev-only" branch) — StrictMode's double-mount is React's deliberate
  dev-only probe for effect-cleanup bugs; production builds never
  double-mount, so no user sees the duplicate line. Guarding the mount
  effect with a did-run ref is the exact anti-pattern StrictMode exists to
  flush out (it hides real cleanup bugs instead of fixing them), and the
  L-062 dedup already collapsed the worst compounding case. Accepted as
  dev-only noise.

## play mode / live

### L-067 · playmode-live · defect · med
- Element: switching the center tab away from "Game" while a run is in
  progress (`GamePanelHost` `onDidVisibilityChange` → `setPlaying(false)`).
- Observed: the moment the Game panel loses visibility it's a full **Stop**
  (resets `pendingRestart`, clears `runtimeErrors`, bumps `runNonce`), not the
  soft pause the code comment claims — all play-session state is lost, with
  ZERO feedback (Play button quietly flips off-screen). Because Scene/Game/Code
  share one tab stack by default, opening Code to edit a script kills the run
  before Cmd+S runs, making the "hot-reload during play" workflow unreachable
  without manually splitting the Code tab out.
- Expected: resolve the "says pause, does stop" mismatch; at minimum a visible
  signal when Play stops from a tab switch; ideally don't couple hot-reload to
  Game-tab visibility.
- Source: PLAYMODE-2, CONSOLE-CHANGES-7
- Disposition: fixed 2bed8fa (PAUSE semantics, not Stop: `GamePanelHost` now
  drives `setGameTabVisible` — hiding the Game tab sets `paused: true`
  (freezing the simulation via the existing debug-pause path and, per review
  I1, genuinely suspending audio: `PixiSceneView.pause()` →
  `WebAudioPlayer.suspend()` halts SFX on the audio clock via
  `AudioContext.suspend()` and pauses the streamed music element at its
  position; the render ticker and gamepad polling keep running by design)
  while keeping `playing: true`, so the run and all its state survive;
  showing the tab auto-resumes UNLESS the user had explicitly paused first
  (a new `pausedByTab` flag tracks pause ownership, cleared by any explicit
  setPaused/Play/Stop/restart). Because `playing` stays true, the
  hot-reload-on-save path (`if (get().playing)`) is now reachable from the
  default tab stack: Play → Code → edit → save → back to Game resumes with
  new code and preserved state, no manual Code-tab split. Toolbar transport is
  honest for free — the tab-pause flips the same `paused` the Pause/Resume
  button reads. Review I2: the Workspace surface-Game effect is keyed on
  runNonce as well as playing, so Restart clicked from another tab brings the
  restarted run forward instead of leaving it running invisibly. Store
  state-machine pinned by `playModeSession.test.ts` (pause-not-stop,
  auto-resume, explicit-pause preserved across hide/show, explicit-resume
  ownership, no-op when stopped, Play/Stop clear, restart-while-tab-paused,
  live-patch-while-tab-paused, repeated hide/show cycles); audio suspend
  semantics pinned in `pixi-audio.test.ts` (+ pause→suspend wiring).
  Chip feedback for the paused state added under L-070.)

### L-068 · playmode-live · friction · med
- Element: Game-preview frame pacing under load (ember-horde, 300 enemies).
- Observed: effective sim rate fell ~3x as entity count tripled (~53fps @106
  → ~18fps @306, holding at the cap) under SwiftShader — absolute numbers not
  representative, but the worse-than-linear relative degradation is a fair
  signal (candidate: per-frame entity sync in `pixi/index.ts`).
- Expected: hold near target fps at the documented cap, or degrade linearly.
  Worth a profiling pass.
- Source: PLAYMODE-4
- Disposition: deferred-M (T9-U8) — this is a runtime profiling task
  (candidate: per-frame entity sync in packages/runtime/src/pixi/index.ts),
  not an editor-UX item this sweep can honestly fix: the SwiftShader numbers
  the audit itself disclaims aren't a valid optimization target, so the work
  starts with a real-GPU profile to even confirm the shape of the curve, and
  any fix lands in the runtime hot path (engine change, anti-bloat gated).
  Belongs to a dedicated perf pass with before/after captures.

### L-069 · playmode-live · friction · med
- Element: input-mapping edits vs. a running preview.
- Observed: editing any input mapping mid-Play doesn't affect the running
  instance (`SceneRuntime` snapshots `InputState` once; the preview reads a
  freshly-fetched store, not the editor store) — a reasonable limitation, but
  the panel gives no hint that a Play restart is needed to feel the change.
- Expected: a note in the Input panel (or Play UI) when mappings changed since
  the run started.
- Source: INPUT-6
- Disposition: fixed d8ffe42 (the Input panel tracks "edited while playing":
  any applyEdit that lands while `playing` shows a status line under the
  header — "The running preview keeps the mappings it started with — restart
  Play to feel these changes." — cleared automatically when the run stops or
  a new run starts (keyed on playing + runNonce). The underlying snapshot
  behavior is unchanged and remains reasonable; the panel just stops being
  silent about it.)

### L-070 · playmode-live · friction · low
- Element: toolbar "Pause" (debug pause) — no in-canvas indicator.
- Observed: Pause freezes the frame counter deterministically but there's no
  on-canvas cue (no dim/overlay/border); sprites hold their last pose, so it
  can read as a hang/crash.
- Expected: a subtle "PAUSED" overlay/border tint while debug-paused.
- Source: PLAYMODE-3
- Disposition: fixed 18d04d6 (GamePreview renders a subtle warn-toned "Paused"
  chip (pause glyph + label) in the Game view top-right corner whenever
  `paused && playing`, so a frozen frame no longer reads as a hang. Covers
  both the toolbar debug pause and the new tab-hidden pause (L-067), since both
  drive the same `paused` flag. Design-token styled (`--warn`/`--warn-soft`,
  `--radius-sm`, `--text-xs`); positioned opposite the scene badge so they
  don't collide; `pointer-events: none`.)

## input

### L-071 · input · friction · low
- Element: gamepad-button binding (`GamepadButtonAdd`).
- Observed: the only way to bind a gamepad button is a static name dropdown;
  no "press a button on your controller" capture flow analogous to the
  keyboard one, and nothing explains why.
- Expected: likely intentional (needs a live device) — a "Press a gamepad
  button…" counterpart or an explanation of the named-mapping design.
- Source: INPUT-8
- Disposition: fixed d8ffe42, taking the finding's second branch (explain the
  design): the Add-gamepad-button select now carries a Tooltip — "Pick by
  standard-layout name — works without a controller connected" — naming WHY
  there's no capture flow: named standard-layout bindings work with no device
  plugged in, unlike keyboard capture which needs the physical key event. A
  press-to-capture counterpart (navigator.getGamepads polling) stays
  deliberately unbuilt: it needs live-device testing this sweep can't do and
  adds a second binding path for the same result (anti-bloat).

### L-072 · input · polish · low
- Element: `.inspector-row` grid reused by InputSettings for multi-line values.
- Observed: `.inspector-row` is `align-items: center`; the Keys/Gamepad/
  Negative/Positive rows stack a chip list + a capture button vertically, so
  the label floats centered against the two-line stack instead of aligning
  with its first line. (T10 row-grid target.)
- Expected: `align-items: start` (or a label top-margin) for multi-line-value
  rows.
- Source: INPUT-5
- Disposition: fixed 15b2169 (T10 row-grid unification). Added
  `.editor-row--top` to the shared row-grid system in primitives.css
  (`align-items: start` + a small label top-padding so it optically lines up
  with the control's first line) and applied it alongside `.inspector-row` on
  every row whose control is `.input-binding-col` (always a vertical stack,
  1 or 2 lines): ActionRow's Keys/Gamepad rows and AxisRow's Gamepad
  axis/Negative key/Positive key/Deadzone rows. Live-verified: the label now
  sits flush with the first chip/checkbox line instead of floating centered
  against the whole stack.

### L-073 · input · polish · low
- Element: error banner after a rejected numeric edit (deadzone/threshold).
- Observed: surfaces the raw Zod string verbatim
  ("...inputMappings.gamepadAxes.jump.threshold: Number must be less than or
  equal to 1.") — functionally correct (rollback + explanation work) but reads
  as a leaky internal error.
- Expected: friendlier copy ("Threshold must be between 0 and 1").
- Source: INPUT-7
- Disposition: fixed d8ffe42 (new pure `friendlyEditError`: a schema-path zod
  message — "…inputMappings.gamepadAxes.jump.threshold: Number must be less
  than or equal to 1." — is rewritten to lead with the failing field's own
  humanized name, "Threshold must be less than or equal to 1."; the internal
  dot-path never renders. Non-path messages pass through untouched. Wired
  into `updateSettingsErrorMessage` so every rejected optimistic edit gets
  it; unit-tested in inputSettingsEdit.test.ts.)

## game settings

### L-074 · gamesettings · defect · high
- Element: Loading→Image picker and Shipping→Icon picker
  (`spriteAssets()` = `type === 'sprite'` only).
- Observed: both dropdowns list only sprite assets; a valid `tile`-typed image
  (ember-horde's `ember-wall`) never appears, though the Inspector's equivalent
  asset pickers accept `sprite || tile`. There's no in-app way to re-tag an
  asset's type — a hard, silent capability gap vs. the rest of the editor.
- Expected: both pickers accept `sprite || tile`, matching Inspector parity.
- Source: GAMESETTINGS-2 (Wave-K: "tile-in-pickers")
- Disposition: fixed (T8-B7) — `spriteAssets()` now filters
  `a.type === 'sprite' || a.type === 'tile'`, matching Inspector's assetId
  pickers exactly; both the Loading→Image and Shipping→Icon pickers list
  tile-typed assets. Updated `gameSettingsEdit.test.ts`'s picker-options test
  (now asserts `['hero', 'ground', 'logo']` incl. the tile asset) plus a new
  exclusion test for non-image kinds. File: GameSettings.tsx.
  Review follow-up (B7-I2): the core side now matches the widened picker —
  `exportDesktop` accepts a sprite OR tile icon (exportCommands.ts; error
  message + BuildSettingsSchema doc updated), png2icons was verified to
  consume a real tile-fixture PNG end-to-end (core exportDesktop.test.ts
  imports it as a `tile` asset and asserts byte-identical iconPng;
  shipping icon.test.ts converts the same bytes to a real .icns), and
  `validateProject` gained MISSING_ICON_ASSET / ICON_ASSET_NOT_IMAGE
  warnings so Validate names a bad icon before an export is attempted
  (warning, not error, so exportDesktop's more specific messages stay
  reachable). Files: packages/core/src/commands/exportCommands.ts,
  packages/core/src/schema/project.ts, packages/core/src/validate.ts.

### L-075 · gamesettings · friction · med
- Element: `.panel-body` (Window/Loop/Loading/Shipping sections).
- Observed: at default dock height only Window + part of Loop show; Fixed
  timestep, all of Loading, and all of Shipping (incl. the Icon field — the
  whole reason to open the panel for a shippable build) are below the fold with
  no scroll-shadow/fade cue.
- Expected: a scroll affordance so the below-fold content is discoverable.
- Source: GAMESETTINGS-6
- Disposition: fixed (T8-B7) — added a `game-settings-body` class (on top of
  the shared, already-scrolling `.panel-body`) with a CSS-only scroll-shadow
  (two `background-attachment: local/scroll` gradient pairs) that fades in a
  dark edge at top/bottom whenever there's more content in that direction, no
  JS scroll listener. New file `styles/panels/gamesettings.css`, imported
  from styles.css. File: GameSettings.tsx.

### L-076 · gamesettings · friction · low
- Element: Loading→Image picker vs. Shipping→Icon picker thumbnails.
- Observed: the Icon picker passes `showThumbnail` and previews the sprite;
  the Loading Image picker doesn't, so selecting a loading image gives no
  visual confirmation.
- Expected: both equally-visual picks get a thumbnail (or neither).
- Source: GAMESETTINGS-5
- Disposition: fixed (T9-U4) — `SpriteAssetPicker` for the Loading→Image row
  now passes `showThumbnail`, same as the Shipping→Icon row. One-line change.
  Live-verified (headless, port 5335, swiftshader): selecting a Loading image
  renders its thumbnail next to the picker. File: GameSettings.tsx.

### L-077 · gamesettings · friction · low
- Element: any Game Settings field edited during Play.
- Observed: editing even a cosmetic field (Title, Background color, Spinner)
  raises the "Scene changed — Restart" badge like a structural edit — every
  `updateSettings` call is classified `structural` regardless of field. No
  live-patch for cosmetic settings.
- Expected: classify cosmetic settings fields as live-patchable (app-wide
  classification gap, most visible here).
- Source: GAMESETTINGS-7
- Disposition: fixed (T9-U4) — `livePatch.ts` had no case for `updateSettings`
  at all, so every settings edit fell through to the generic `fallback()` and
  raised the badge. Added `classifyUpdateSettings()`: a patch touching only
  `title` and/or `loading.*` buildSettings keys classifies `none` (the window
  title isn't drawn into the canvas, and the loading screen has already shown
  and been dismissed by the time Play is running, so neither can change what's
  on screen right now); any other buildSettings field (width/height/
  backgroundColor/targetFps/fixedTimestep/icon) still falls back to
  `structural` — conservative, only carves out fields proven cosmetic, never
  guesses one in. Scoped to the LOCAL edit path only (`classifyLocal`, which
  has the real params in hand); an external CLI/MCP-sourced `updateSettings`
  journal entry still has no `extractJournalDetail` case in core's
  session.ts recording which keys changed, so `classifyJournal` still falls
  back to `structural` for that path — extending the journal detail shape is
  a cross-package change, deferred rather than guessed at. Unit-tested
  (7 new cases in livePatch.test.ts: title-only, each loading.* field alone,
  each non-cosmetic field alone, a mixed cosmetic+non-cosmetic patch, and an
  empty/malformed patch). Live-verified (headless, port 5335, swiftshader,
  ember-horde): entered Play, edited Title — no restart badge
  (`badgeAfterTitleEdit: ""`); edited Width on the same running session —
  badge appeared (`badgeAfterWidthEdit: "Restart"`), confirming the
  classifier actually discriminates live, not just in unit tests. File:
  livePatch.ts.

### L-078 · gamesettings · polish · high
- Element: `.panel-header` of the Game Settings panel — renders "Game".
- Observed: the in-body header reads "GAME" while its own dockview tab and the
  View menu read "Game Settings" — and it collides exactly with a *different*
  panel's title (`PANEL_TITLES.game = 'Game'`, the live preview host), so a
  user skimming headers sees two unrelated panels both titled "Game".
- Expected: the in-panel header should read "Game Settings" to match its tab.
- Source: GAMESETTINGS-1 (Wave-K: "'Game' panel header")
- Disposition: fixed (T8-B7) — both `.panel-header` renders (the mounted
  panel and the `!info` "No project open" branch) now read "Game Settings",
  matching the dockview tab/View-menu title. `PANEL_TITLES.gameSettings` in
  Workspace.tsx was already `'Game Settings'` (no change needed there — only
  the component's own hardcoded header string was wrong). Also fixed the
  empty-state icon while in this branch (see L-079 below — same lines).
  File: GameSettings.tsx.

### L-079 · gamesettings · polish · low
- Element: `if (!info)` "No project open" branch (`GameSettings.tsx:193-207`).
- Observed: no UI path reaches a mounted Game Settings panel with `info` null
  ("Close project" unmounts the whole workspace to the launcher) — apparently
  unreachable defensive code that also inherits the L-078 header bug and uses a
  "run" `play` glyph for a "nothing open" message.
- Expected: confirm intent (harmless dead code) or fix the icon/header if a
  real path hits it.
- Source: GAMESETTINGS-8
- Disposition: fixed (T8-B7) — fixed the icon/header as a byproduct of
  L-078's header fix (same branch, same edit): header now reads
  "Game Settings"; the "run" `play` glyph swapped for `grid` (the settings
  glyph this editor already uses for the `updateSettings` command in
  Timeline.tsx's `commandIcon`) — no new icon added since ui.tsx is
  off-limits this wave. Left as still-unreachable defensive code (not worth
  deleting outside this wave's scope). File: GameSettings.tsx.
  FOLLOWUP CLOSED (T9-U4): re-verified unreachability directly —
  App.tsx only mounts `<Workspace>` (and GameSettings with it) once
  `projectPath` is truthy, and store.ts's `afterOpen`/`closeProject` always
  set `projectPath` and `info` together in the same `set()` call, so there is
  no render where this panel is mounted with `info` null. Deleted the
  `if (!info)` branch entirely rather than keeping it as dead code; `bs` now
  reads `info!.buildSettings` with a comment naming the invariant. No test
  referenced the removed branch (gameSettingsEdit.test.ts). File:
  GameSettings.tsx.

## animator

### L-080 · animator · defect · high
- Element: parameter-type `<select>` vs. an existing condition referencing that
  param (`setParamType`, `draftIssues`).
- Observed: changing a param's type (e.g. number→bool) rewrites only the
  param's default; dependent conditions keep their now-invalid op/value and
  re-render misleadingly (`spd = false`). `draftIssues()` doesn't check
  "op valid for the param's current type" (the server's `superRefine` does), so
  Save stays enabled and then fails with a raw agent-facing schema string
  (`data.transitions.2.conditions.0.op: bool param "spd" conditions only
  support eq/neq`). `setParamType`/`setConditionOp`/`setConditionValue` have
  zero test coverage despite the module claiming "pure, unit-tested".
- Expected: `setParamType` clears/reseeds dependent conditions, OR
  `draftIssues()` runs the same op-vs-current-type check the server does, so
  the problem is named before Save.
- Source: ANIMATOR-1 (Wave-K: "setParamType stale-op gate")
- Disposition: fixed (T8-B6) — `setParamType` now migrates every dependent
  condition's op/value to a type-appropriate default (mirrors `setConditionParam`);
  `draftIssues()` runs the server's op-vs-type check (bool → eq/neq only), so an
  invalid combo is named before Save and the Save button gates on it; save-error
  render maps zod paths to plain-language field locations via new pure
  `humanizeSaveError` (never a raw zod dump). Added the missing unit coverage for
  `setParamType`/`setConditionOp`/`setConditionValue`/`humanizeSaveError`
  (asmEdit.test.ts, 36 tests pass). Files: asmEdit.ts, AnimatorEditor.tsx,
  asmEdit.test.ts.

### L-081 · animator · defect · high
- Element: global `mod+s` while editing in the Animator.
- Observed: the Animator is the deliberate non-autosave exception (real gated
  Save + "Unsaved" pill), but there's no Animator override for `mod+s`, so a
  reflexive Cmd+S logs "Your changes are saved automatically — no need to
  save." while the Unsaved pill sits visibly on screen and the draft stays
  ungated.
- Expected: `mod+s` triggers the Animator's own `save()` when it's the active
  panel (same pattern the Code panel uses), or at least don't claim "no need to
  save" while Unsaved is showing.
- Source: ANIMATOR-4
- Disposition: fixed (T8-B6) — the `.animator` root now handles `mod+s` locally
  (`onKeyDownSave`): it triggers the Animator's own gated `save()` and
  `stopPropagation`s so the global "saved automatically" keybind (window-bubble)
  never sees it while the panel is focused. Files: AnimatorEditor.tsx.

### L-082 · animator · defect · high
- Element: Save flow vs. a concurrent external edit to the same `.asm.json`.
- Observed: with the machine open, an on-disk edit (`idle.speed = 9.9`) is
  correctly NOT pulled in (draft stays clean) — but one in-editor edit + Save
  writes the full draft computed from the *original* load, silently destroying
  the external `9.9` with no detection/warning/merge/log. The load-effect guard
  (`loadedIdRef === asset.id`) loads from disk once per open and never refreshes,
  though the `assets` array already carries the fresh parse. Ordinary
  human+agent concurrent-edit scenario.
- Expected: detect the on-disk doc changed since load (the fresh parse is
  already in `assets`) and offer reload/overwrite before Save, not silent
  last-write-wins.
- Source: ANIMATOR-8 (Wave-K: "Animator external-edit last-write-wins")
- Disposition: fixed (T8-B6, reworked after review) — save-time external-change
  detection mirroring CodePanel's L-054 backstop: `save()` RE-READS the
  .asm.json from disk (`fetch(fileUrl(project, asset.path))`) — NOT the store's
  `asset.stateMachine`, which only refreshes via the command journal and is
  stale for raw fs edits — normalizes the on-disk text through the same
  doc↔draft round-trip as `loadedDoc` (pure `shouldBlockAsmSave` in asmEdit.ts,
  unit-tested incl. the raw-fs-write case), and on drift shows the
  Reload/Overwrite conflict banner instead of writing. Reload adopts the exact
  doc Save compared against (captured at detection); Overwrite proceeds; a
  failed read never blocks the save. Live-verified end-to-end with a raw
  `python` write (no journal): Save → banner, file untouched; Reload → adopts
  disk; second raw write + Save → banner → Overwrite → deliberate write lands.
  Behavior: detection is at Save (not live) — an external edit still isn't
  pulled in mid-edit, but can no longer be destroyed without the user choosing.
  Files: asmEdit.ts, AnimatorEditor.tsx (shared `.code-conflict-banner`).

### L-083 · animator · friction · high
- Element: "Machine" `<select>` switched while the current draft is dirty.
- Observed: `onChange` is just `setAssetId`; the load effect then loads a fresh
  draft for the new asset and overwrites `draft` with NO dirty check or
  confirm — silently discarding unsaved params/states/transitions.
  `ConfirmDialog` already exists for exactly this class of action.
- Expected: confirm before switching (or honoring an `animatorTarget` change)
  when `dirty`.
- Source: ANIMATOR-2
- Disposition: fixed (T8-B6) — the Machine `<select>` now routes through
  `requestSwitch`: when the draft is `dirty` it parks the target and opens the
  existing `ConfirmDialog` ("Discard unsaved changes? / Discard & switch",
  danger); confirm applies the switch, cancel keeps editing (the controlled
  select snaps back). Clean drafts switch immediately as before. Files:
  AnimatorEditor.tsx.

### L-084 · animator · friction · high
- Element: state-machine (and animation) asset creation.
- Observed: no in-editor way to create a state-machine asset; the Assets panel
  creates only sprite/tile, and `createStateMachineAsset` is mentioned only in
  the Animator's own empty-state copy ("use the CLI's createStateMachineAsset
  command"). The one editor whose purpose is authoring state machines can't
  originate the asset it edits without leaving for a terminal/agent.
- Expected: a "+ State machine" affordance in the Assets panel (parallel to
  Sprite/Tile). (Relates to the broader create-affordance gap: L-049, L-057.)
- Source: ANIMATOR-3
- Disposition: fixed (T8-B6), scoped to the Animator's own surface to avoid
  colliding with B3's AssetsPanel create-dialog work — a "New state machine…"
  button in the empty state and a "+ New" toolbar button both open a name-prompt
  Modal that calls the existing `createStateMachineAsset` command (seeding one
  `idle` state on the first available animation asset, since the schema requires
  ≥1 state with a valid animation), surfaces command errors inline, and opens the
  new machine via `openAnimatorFor`. When no animation assets exist the create is
  disabled with an explanatory hint. FOLLOWUP (U3): the audit's literal ask — a
  parallel "+ State machine" button in the AssetsPanel toolbar next to
  Sprite/Tile — is still open; deferred here to not touch AssetsPanel.tsx while
  B3 is editing it. Files: AnimatorEditor.tsx.
  FOLLOWUP CLOSED a4fe855 (T9-U3): a "State machine" toolbar `Button` now sits
  next to Sprite/Tile in AssetsPanel.tsx, opening a local name-prompt `Modal`
  (AnimatorEditor's own dialog isn't exported, so this is a parallel copy of
  the same seed-an-idle-state payload/pattern) that calls
  `createStateMachineAsset` and then `openAnimatorFor` the new asset. Live-
  verified: creating "courier-motion-2" opened the Animator on the new
  machine and the asset card appeared in the grid.

### L-085 · animator · friction · high
- Element: Transitions list (order is load-bearing at runtime).
- Observed: runtime resolves overlapping transitions by array position
  (first-eligible-in-declaration-order wins), but the list has no card
  numbering, no per-source grouping, and NO reorder function (`addTransition`
  only appends; no `moveTransition`/drag). The only way to change priority is
  delete-and-re-add (always appends last). Reconstructing "which transitions
  leave idle, in what priority" means reading every card by eye.
- Expected: group/sort cards by source state and add reorder (drag or
  up/down) so priority is intentional and visible — direct-manipulation bar.
- Source: ANIMATOR-5
- Disposition: fixed (T9-U6) — the Transitions list is now grouped and
  manipulable (short of the long-term node-graph track):
  - **Grouping.** Cards render under collapsible "From <state>" headers via
    `groupTransitions()` (any-state group first as the machine-wide fallback,
    then states in declaration order, orphan sources last). Within a group,
    order == flat declaration order == the runtime tiebreak order for that
    source.
  - **Priority visibility.** Each card shows a badge with its ordinal WITHIN
    its source group (1-based) — the only order the runtime actually honors.
    `pickTransition` evaluates two strict tiers (the current state's own
    transitions first, then `any` transitions), each in relative declaration
    order; a global flat index would overstate what the order means across
    tiers (review caught the first cut doing exactly that), so none is shown.
    State-group tooltip: "Checked <n>th among <state>'s own transitions —
    first match wins"; any-group tooltip: "Fallback #<n> — checked after the
    state's own transitions" (the group header carries the same fallback note).
    A runtime-parity suite in asmEdit.test.ts executes the REAL
    `stepStateMachine` against mixed machines to pin the badge claim: a
    state-tier transition beats a flat-earlier any-transition, tier-internal
    order follows the group ordinal across non-contiguous flat slots, and a
    `moveTransitionInGroup` reorder flips the actual runtime outcome.
  - **Reorder.** Move-earlier/later `IconButton`s per card call the pure
    `moveTransitionInGroup(draft, flatIndex, targetGroupPos)`. Flat-array
    mapping rule (documented in asmEdit.ts): a group owns the fixed set of flat
    slots where `from===group`; a move permutes ONLY those slots (group items
    re-laid in the new order), so every other source keeps its exact flat
    position and only this group's runtime priority changes. Edge moves are
    referential no-ops (never falsely dirty). Keyboard-accessible; buttons
    disable at group top/bottom.
  - **At-a-glance summary.** Collapsed cards read as a sentence
    (`summarizeTransition`): "idle → walk · when moving = true", "· exit 0.5",
    "· always"; expand to the existing from/to + exit-time + conditions editor.
  - **State navigation.** Each State row shows an outgoing-count badge ("2 out")
    that expands + scrolls + flashes that source's group — cheap navigation, no
    graph canvas.
  - New pure helpers unit-tested in asmEdit.test.ts (25 cases: grouping order,
    non-adjacent flat collection, flat-array swap mapping incl. an any-group
    spread across non-contiguous slots, cross-group preservation, edge no-ops,
    summary sentences, runtime-parity vs the real stepper). TransitionsSection
    is keyed per machine so expand/collapse state (keyed by flat index / source
    name) resets on a Machine switch. Full editor suite green + workspace
    typecheck clean.
  - Live-verified (own port 5338, scratch sky-courier seeded with idle/walk/idle
    interleaved): reorder → Save → on-disk `transitions[]` swapped [0]↔[2] while
    walk stayed at [1] → runtime `pickTransition` now evaluates idle's exit-0.5
    edge before its moving==true edge. Grouping/badges/summaries/out-counts all
    confirmed in the live DOM (per-group badges re-verified on a mixed
    state+any machine after the review fix).
  - Files: apps/editor/src/asmEdit.ts (+ tests), components/AnimatorEditor.tsx,
    styles/panels/animator.css.

### L-086 · animator · polish · low
- Element: icon-only remove buttons + initial-state star toggle.
- Observed: all rely solely on native `title` (the `Icon` svg is
  `aria-hidden`), instead of the purpose-built `IconButton` that gives a
  discoverable label + tooltip + aria-label. (T7 title-sweep target;
  IconButton adoption is still sparse app-wide.)
- Expected: swap to `IconButton`.
- Source: ANIMATOR-7
- Disposition: fixed (verified T8-B6) — already resolved by the shared-`Button`
  migration the audit header flagged mid-session: AnimatorEditor's four
  `icon-btn danger` remove buttons and the `animator-initial` star are all
  `IconButton` now, each with a required `label` (doubles as aria-label +
  tooltip). No further change needed. File: AnimatorEditor.tsx.

### L-087 · animator · polish · low
- Element: state-row speed control vs. its delete button (`× [1] ×`).
- Observed: the "times" multiplier label `×` and the delete `Icon name="cross"`
  are the same glyph/size/color sitting adjacent at the row end — reads as one
  control group; easy to misclick.
- Expected: differentiate the multiplier label from the delete affordance.
- Source: ANIMATOR-9
- Disposition: fixed (T8-B6) — the speed "×" multiplier label is now smaller
  (`--text-xs`) and fainter (opacity 0.7, non-selectable) and marked
  `aria-hidden`, so it no longer reads as a peer of the delete "×" glyph at the
  row end. Files: AnimatorEditor.tsx, styles/panels/animator.css.

### L-088 · animator · polish · low
- Element: transition Exit-time input.
- Observed: the exit-time field clamps correctly (0..1) but its input idiom is
  inconsistent with the rest of the editor's field idioms.
- Expected: align the exitTime input to the standard field idiom.
- Source: Wave-K tail ("exitTime input idiom")
- Disposition: fixed 10747ef (the raw live-clamping `<input type=number>` is
  now the shared `NumberField` with min=0/max=1 — commit on blur/Enter,
  Escape reverts, out-of-range/non-numeric drafts revert with the L-108
  rejection cue instead of being silently clamped mid-keystroke; identical to
  every other numeric field in the editor).

## agent

### L-089 · agent · defect · high
- Element: launcher primary button ("Start agent"/"Open Terminal") in
  `.agent-toolbar`.
- Observed: the only `disabled` condition is `!projectPath` — no
  `disabled={running}` guard. With a shell running, switching the launcher
  select to Claude/Codex relabels the button to "Start agent", keeps it bright
  and clickable while Stop is also enabled and status still says "Running
  shell"; `startPty` unconditionally kills the existing pty before spawning.
  So a muscle-memory click silently kills the live session and spawns the real
  (paid) `claude`/`codex` CLI with no confirm — the exact cost risk the brief
  called out (both CLIs are on PATH here).
- Expected: disable (or confirm) the primary action and the launcher/mode
  selects whenever `agent.session.status === 'running'`.
- Source: AGENT-1
- Disposition: fixed (T8-B7) — new pure `startDisabledReason(running,
  projectPath)` gates the Start/Open-Terminal button (disable+reason,
  "Stop the current session first." takes precedence over the no-project
  reason); the launcher and mode `<select>`s are now also disabled while
  running (new `DisabledHint` wrapper — Tooltip + focusable span, mirroring
  Inspector.tsx's disabledReason pattern — surfaces the reason since a
  disabled native control doesn't reliably show its own hover tooltip).
  Review follow-up (B7-I1): the "Install Claude Code" button — which spawns
  a shell pty via the same path — now shares the identical guard, and a new
  epoch-matched `shouldRedetectAfterInstall` effect re-runs CLI detection
  automatically when the install session's pty exits, so the button resolves
  to "Start agent" without a manual Re-detect. Unit-tested in
  `agentPanelGuards.test.ts`. File: AgentPanel.tsx.

### L-090 · agent · defect · med
- Element: "Restore checkpoint" disabled state vs. the live Timeline feed.
- Observed: its disabled state is bound to `diff?.hasChanges`, and `diff` is
  only recomputed by an explicit `refreshDiff()`, never when a new journal
  entry lands. Running `hearth create entity …` from another shell shows the
  row in the Timeline within ~2s (correct) but leaves Restore disabled until
  "Review changes" is clicked. (Same diff-staleness family as L-060, different
  trigger/call site.)
- Expected: refresh `diff` whenever an external journal entry lands (the
  trigger that already updates the Timeline), or don't imply the two are in
  sync.
- Source: AGENT-2
- Disposition: fixed a5e733f (T8-B7; the store.ts hunk was swept into that
  commit by a concurrent fixer staging all of store.ts — not 7a02f09, which
  carries the rest of the B7 agent-panel work) — store.ts's WS `onmessage`
  handler now calls the existing `refreshDiffIfTracking()` (already used by
  undo/redo, L-060) right after mirroring external journal entries, so
  "Restore checkpoint" updates within the same tick the Timeline row appears
  — only when a baseline is actually tracked (checkpoint taken this session
  or a diff already on screen), same guard as the undo/redo call sites, so it
  doesn't spam a "no checkpoint" diffProject call on every external command
  when nothing is being tracked. Review follow-up (B7-M3): the call is now
  coalesced — while one diffProject is in flight, a burst of journal frames
  folds into ONE trailing catch-up instead of N concurrent whole-project
  diffs. New test `agentDiffRefresh.test.ts` drives the real store against a
  fake WS socket, incl. the burst case. File: store.ts.

### L-091 · agent · friction · med
- Element: permission-mode `<select>` (Read-only / Safe edit / Full / All).
- Observed: the picker is fully enabled with mode-specific hints for every
  launcher, but it's only consumed when launcher === `claude`; for
  codex/shell the mode is passed on the `pty-start` frame purely "so the server
  sees it" and `startPty` never reads it. For 2 of 3 launchers the dropdown is
  inert with no visual indication.
- Expected: disable/hide the mode picker for non-Claude launchers, or mark it
  informational-only there.
- Source: AGENT-3
- Disposition: fixed (T8-B7) — new pure `modePickerDisabledReason(launcher)`
  returns null for `claude`, a reason string for `codex`/`shell`; the mode
  `<select>` is disabled with that reason (via the same `DisabledHint`
  wrapper as AGENT-1) whenever it's inert OR a session is running. Kept
  fully enabled (with the existing visible-text hint, no redundant tooltip)
  for Claude. Unit-tested in `agentPanelGuards.test.ts`. File: AgentPanel.tsx.

### L-092 · agent · friction · med
- Element: "Manual setup" MCP code blocks (`mcpClaudeBlock`, `mcpJsonBlock`).
- Observed: both static templates only include `--project <path>`, never a
  `--mode` flag, though the Mode picker sits directly above and the automatic
  Prepare flow does write `--mode <tier>`. A user who picks "Full", then copies
  the manual command instead of clicking Start, gets an implicitly read-only
  config with no on-screen hint the tier didn't carry over.
- Expected: reflect the selected mode (`--mode <tier>`) in the manual blocks.
- Source: AGENT-4
- Disposition: fixed b6e4b78 (both manual blocks — the `claude mcp add`
  one-liner and the generic .mcp.json — now append `--mode <tokens>` from the
  live picker selection, expanded through a client-side mirror of
  agentSetup.ts's MODE_ARGS (a value import would drag the server module into
  the bundle; the type-only import stays). "Full" correctly expands to
  `safe-edit,code-edit,asset-edit`, matching what the automatic Prepare flow
  writes. The stale "This editor grants all modes" note under the table now
  says the blocks carry the picker's mode.)

### L-093 · agent · friction · low
- Element: Timeline empty state ("No activity yet").
- Observed: `journalWatcher` baselines to the journal's current `lastSeq()` on
  start and never backfills, so the feed is empty on every fresh open despite
  real on-disk history; "No activity yet" reads as "nothing has happened in
  this project", which isn't true.
- Expected: scope the copy ("No activity yet this session").
- Source: AGENT-5
- Disposition: fixed (T9-U4) — replaced the single misleading "No activity
  yet" with two honest states keyed off the store's existing `wsStatus`
  (the WS journal channel is what backs this feed at all): while
  `wsStatus !== 'connected'` it shows "Loading activity…"; once connected
  and still empty, "No agent activity in this project yet — activity from
  CLI/MCP commands appears here." (plus the existing longer hint below).
  This doesn't fix the underlying `journalWatcher` no-backfill gap itself
  (that needs a WS protocol change to ship history on connect — deferred,
  cross-package, out of scope for an editor-only fix) but the copy no longer
  claims something false. Live-verified (headless, port 5335, swiftshader):
  a fresh ember-horde open renders the new empty-state text exactly. File:
  agent/Timeline.tsx.

### L-094 · agent · friction · low
- Element: terminal scrollback cap (`SCROLLBACK_CAP_BYTES` = 200KB).
- Observed: `droppedBytes` is tracked precisely but never rendered; a session
  past 200KB silently loses its earliest lines with no cue.
- Expected: surface `droppedBytes` near the terminal when non-zero.
- Source: AGENT-6
- Disposition: fixed (T9-U4) — `planTerminalWrite` (useAgentSocket.ts) gains a
  `truncated` field: true exactly when a replay is a reset (fresh/reattached
  terminal mount) AND the buffer already had bytes evicted by the cap before
  that mount, i.e. the replay can't be the full session history. Terminal.tsx
  writes a dim one-line `[hearth] Older output trimmed` notice via
  `term.write()` right after `term.reset()` and before replaying `plan.text`,
  so it lands at the top of the replayed scrollback. Only fires on
  reset — once an instance is caught up, a later live trim can't retroactively
  hide anything it already rendered, so no repeat notice. Unit-tested (3 new
  cases in useAgentSocket.test.ts: no notice on a fresh untrimmed replay,
  notice on a (re)mount that inherits already-dropped bytes, no notice on a
  later live trim once already caught up). Live-verified the replay mechanics
  end-to-end (headless, port 5335, swiftshader): flooded the embedded shell
  past the 200KB cap, closed/reopened the Agent tab via the View menu, and
  confirmed the remounted terminal replays only the capped tail (not the full
  flood) — matching `truncated`'s reset+dropped-bytes precondition; could not
  visually confirm the notice glyph itself in headless xterm (its scrollback
  is virtualized into `.xterm-screen`, and scripting `scrollTop` on
  `.xterm-viewport` doesn't trigger xterm's own re-render of off-screen rows
  the way a real user scroll/wheel event does), so that specific rendering is
  covered by code review + the unit tests above rather than a pixel-level
  live check. Files: agent/useAgentSocket.ts, agent/Terminal.tsx.

### L-095 · agent · friction · low
- Element: "Checkpoint" button in the Agent Timeline.
- Observed: it calls `exec('snapshotProject')` with no following `log()`, so
  clicking Checkpoint from the Agent panel shows the ✓ badge but produces no
  Console feedback — unlike the identical action from the Toolbar/Diff panel.
- Expected: add the matching `log()` call (same action, same feedback).
- Source: AGENT-7
- Disposition: fixed (T9-U4) — the actual sibling with matching feedback is
  DiffPanel.tsx (the standalone Toolbar Checkpoint button no longer exists
  post-T5/T6 toolbar slimming; see L-098 below), which already routes through
  the shared `store.checkpoint()` action (log line + `refreshDiff()`).
  Timeline's own local `snapshot()` wrapper (a bare `exec('snapshotProject',
  {}, {quiet:true})`) is now removed in favor of calling `checkpoint()`
  directly — same action, same feedback, and a bonus: Timeline's Checkpoint
  now also refreshes the Changes panel baseline immediately, like DiffPanel's
  already does. `snapshotTaken` (the ✓ badge) is set centrally in `exec()`
  keyed on the command name, so the badge behavior is unaffected. File:
  agent/Timeline.tsx.

### L-096 · agent · friction · low
- Element: Timeline row labels for per-entity mutations.
- Observed: `entryToRow`'s label is `summary || command`; a
  `setComponentProperty` row renders as `setComponentProperty` with meta
  `Arena` (the scene) — not which entity or property changed. The surface meant
  to build trust in an unattended agent makes its most common mutation the
  least legible.
- Expected: include entity name (and ideally property path) in the label/meta.
- Source: AGENT-8
- Disposition: fixed (T9-U4) — new pure `humanizeLabel(entry)`: when the
  journal detail names an entity (`setComponentProperty`'s `{scene, entity,
  property}`, or `setProperties`' `{scene, entity, properties}`), the label
  becomes `"<command> <entity>.<property>"` (a single changed property) or
  `"<command> <entity> (N properties)"` (a batch), staying one line; anything
  else (no detail, or no entity in it — e.g. `renameEntity`/`setEntityTags`,
  which core's `extractJournalDetail` doesn't record a detail shape for at
  all today) falls back to the existing `summary || command`, unchanged.
  Defensive against a malformed detail bag (never throws). Unit-tested (5 new
  cases in timeline.test.ts). Live-verified (headless, port 5335,
  swiftshader): editing Player's Transform.position.x in the Inspector
  produced the Timeline row label `setComponentProperty
  ent_4j8c5wgb.Transform.position.x` — the entity renders as whatever ref the
  command actually carried (here an id, since the Inspector calls
  `setComponentProperty` by id) rather than a guaranteed display name; that's
  a `journal detail` limitation (documented in the research for this task),
  not something this fix papers over. File: agent/Timeline.tsx.

### L-097 · agent · polish · low
- Element: Agent panel default docked height (`.agent-body`).
- Observed: on first open the terminal/timeline are ~143px (~6 rows), forcing
  a manual sash drag; the terminal is a primary high-attention element and the
  default feels cramped enough to read as a bug.
- Expected: a taller default initial height for the bottom group / Agent panel.
- Source: AGENT-9
- Disposition: fixed (T9-U4) — the bottom dockview group (Assets/Console/
  Diff/Agent/Input/Game Settings/Live all share it — there's no per-panel
  default height in dockview, only the group's) bumped from
  `BOTTOM_HEIGHT = 260` to `340`. Live-verified (headless, port 5335,
  swiftshader, fresh layout): `.agent-body` measured 223px tall (up from the
  ~143px the audit measured at 260), a linear ~+80px matching the height
  bump exactly, since the fixed-height toolbar/hint rows above it don't grow.
  File: workspace/Workspace.tsx.

### L-098 · agent · polish · low
- Element: "Checkpoint" button tooltip — Agent Timeline vs. Toolbar.
- Observed: the Toolbar tooltip includes the shortcut ("…(⇧⌘S)"); the Agent
  Timeline's identical button omits it.
- Expected: both mention the shortcut, or neither.
- Source: AGENT-10
- Disposition: deferred-M (stale finding, needs an out-of-scope file) — the
  standalone Toolbar Checkpoint button this compared against no longer exists:
  T5/T6's toolbar-slimming rework (L-005/L-006, `3c1d9c5`) removed it. The
  only two Checkpoint tooltips left are DiffPanel.tsx ("Save a checkpoint you
  can review and restore") and Timeline.tsx (same text, see L-095) — neither
  mentions the shortcut today, so the original "one has it, one doesn't"
  finding no longer applies as stated (it's "neither does," which the audit's
  own "or neither" acceptance criterion already allows). Making both mention
  ⇧⌘S for extra clarity would require editing DiffPanel.tsx, which is outside
  this wave's file scope (Files: AgentPanel.tsx + agent/*, Launcher.tsx,
  GameSettings.tsx) and risks colliding with concurrent work on that panel;
  left open for whichever future pass next touches DiffPanel.tsx.

## export

### L-099 · export · defect · med
- Element: Modal `<dialog>` `onCancel`/Escape while a desktop export runs.
- Observed: during an active desktop export the segmented control and the
  "Cancel" button are correctly disabled, but Escape fires the native
  `cancel`→`onClose` with no `jobRunning` guard, closing the dialog anyway —
  mouse users are blocked from dismissing mid-export, keyboard users aren't.
  The job itself is unharmed (module-level store), but the interaction is
  inconsistent. Root cause is the shared `Modal` (`ui.tsx:299`), but only
  ExportDialog has a deliberate "disabled to block dismissal while busy"
  contract.
- Expected: `onCancel` also checks `jobRunning` (mirroring the Cancel button),
  or make clear Escape still works.
- Source: EXPORTDIALOG-1
- Disposition: fixed (T8-B7) — ExportDialog.tsx now passes its own
  `guardedClose` (not the raw `onClose` prop) into `Modal`'s `onClose`, which
  Modal wires to both the `<dialog>`'s `cancel` and `close` events; when a
  desktop job is running it calls `event.preventDefault()` on the native
  event instead of the real `onClose` — necessary because Escape's default
  action closes a `<dialog>` regardless of whether the app calls its own
  close callback, so skipping the callback alone isn't enough. Decision
  pulled to a pure, exported `blocksDialogCancel(jobRunning)`, unit-tested in
  new `exportDialogGuard.test.ts` (the DOM-facing preventDefault plumbing
  itself isn't testable — no jsdom/RTL in this repo). No Modal (ui.tsx)
  changes needed. File: ExportDialog.tsx.

## launcher

### L-100 · launcher · friction · med
- Element: `.launcher` layout — New-project vs. Open-a-project cards.
- Observed: with a full Recent list + 9 examples, the Open card is ~1310px vs.
  the New card's ~432px (3x); page content ~1566px vs. a 950px viewport, with
  no independent scroll region (`.launcher-list` has no `max-height`/`overflow`)
  — a returning user never sees "Examples" without scrolling, and the
  top-aligned cards look badly unbalanced.
- Expected: cap/scroll the Recent and/or Examples lists independently so the
  launcher reads as one balanced screen.
- Source: LAUNCHER-1
- Disposition: fixed (T9-U7) — `.launcher-list` gets `max-height: 220px;
  overflow-y: auto`, giving Recent and Examples each their own bounded scroll
  region instead of letting the page grow unbounded. Live-verified (headless,
  port 5335, swiftshader): both lists measured `max-height: 220px` /
  `overflow-y: auto`; the Examples list's bounding box sat at y≈607–827 in a
  950px-tall viewport (comfortably above the fold) and the two cards read as
  balanced instead of a 3x-taller Open card. File:
  styles/panels/launcher.css.

### L-101 · launcher · friction · med
- Element: Recent-projects storage (`~/.hearth/recent-projects.json`).
- Observed: a single global path shared by every editor instance, not scoped
  per window; the Recent list interleaves entries from concurrent sessions and,
  capped at 12, a burst in one window evicts another's genuinely-recent
  projects; `addRecent`'s read-modify-write has a plain TOCTOU race under
  simultaneous writes. Directly observed; compounds L-106's reliance on native
  tooltips to disambiguate same-named entries.
- Expected: a product decision — intentional per-machine MRU vs. per-instance
  scoping — and at minimum guard the concurrent read-modify-write.
- Source: LAUNCHER-4
- Disposition: by-design (product decision, T9-U7) — a single per-machine MRU
  file is the standard, expected shape for "recent projects" (every editor
  with this feature — VS Code, JetBrains IDEs, etc. — shares one list across
  windows by design; that's the point of "recent," not a per-window log).
  Cross-contamination between concurrent editor windows on the SAME machine
  is a real but narrow edge case (most sessions are one editor per machine at
  a time), and the current `addRecent` read-modify-write (see
  projectServer.ts) is already an acceptable last-write-wins for that case: a
  lost entry just means a project takes one more open to resurface in Recent,
  never data loss or corruption. No code change made — `projectServer.ts`
  (where `addRecent`/`readRecents` live) is outside this wave's file scope
  (Files: AgentPanel.tsx + agent/*, Launcher.tsx, GameSettings.tsx) and the
  existing behavior is judged fine as-is per the dispatch's own framing.

### L-102 · launcher · friction · low
- Element: "Create project" / "Open" buttons while `busy`.
- Observed: only `disabled` (opacity 0.45); labels stay static, no spinner —
  on a slow filesystem the user gets no feedback anything is happening.
- Expected: swap in "Creating…"/"Opening…" (or an inline spinner) while busy.
- Source: LAUNCHER-2
- Disposition: fixed (T8-B7) — replaced the plain `busy` boolean with a
  `busyAction: 'create' | 'open' | null` (derived `busy = busyAction !==
  null` keeps every existing disabled check unchanged); new pure
  `launcherButtonLabel(action, kind, idleLabel)` swaps "Create project" →
  "Creating…" / "Open" → "Opening…" only for the button matching the
  in-flight action. Review follow-up (B7-M4): both actions now run through
  `withBusyAction`, which resets `busyAction` in a `finally` — a thrown
  create/open can no longer strand the launcher on a stale "Creating…".
  Unit-tested in `launcher.test.ts`. File: Launcher.tsx.

### L-103 · launcher · polish · low
- Element: Recent/Examples rows — full path only via native `title`.
- Observed: paths are CSS-ellipsis-truncated; the full path is only in the
  slow, unstyled, touch-unavailable native title tooltip — the more so since
  duplicate project names are common and the path is often the only
  disambiguator.
- Expected: a styled tooltip / on-focus path reveal.
- Source: LAUNCHER-3
- Disposition: fixed b6e4b78 (Recent and Example rows are wrapped in the
  shared Tooltip primitive — full path as content, shown on hover AND
  keyboard focus (the primitive's focus-visible contract covers the "on-focus
  path reveal" ask); the slow native `title`s are removed. Tooltip clones the
  child, so no wrapper element disturbs the `.launcher-item` layout. Known
  minor gap: a `moved or deleted` row is a disabled button, which browsers
  don't fire hover events on — its visible text already states the situation.)

## electron

### L-104 · electron · defect · med
- Element: packaged app's static server MIME table
  (`apps/editor/electron/main.ts:27-36`).
- Observed: the hand-rolled `MIME` map has no `.wasm` entry, so wasmoon's
  `glue.wasm` is served as `application/octet-stream`;
  `WebAssembly.compileStreaming` rejects it and logs "Incorrect response MIME
  type. Expected 'application/wasm'. falling back to ArrayBuffer" on every Lua
  context spin-up in the packaged app (electron-specific; Vite serves correct
  MIME in dev). Graceful degradation — the game still runs — but console-error
  noise on every launch. One-line fix: add `'.wasm': 'application/wasm'`.
- Expected: `.wasm` → `application/wasm` so streaming compile takes the fast
  path.
- Source: ELECTRON-1
- Disposition: fixed b0fcb00 (ledger was stale — the entry landed earlier
  without a ledger update; verified T9-U8: electron/main.ts's MIME table
  carries `'.wasm': 'application/wasm'` with the streaming-compile comment).

### L-105 · electron · defect · low
- Element: Pixi asset loader via the shared `/api/file?project=…&path=…` route
  (identical in dev and packaged — NOT Electron's own static server).
- Observed: reaching gameplay assets logs `PixiJS Warning: [Assets] …
  wisp.svg could not be loaded as we don't know how to parse it` — almost
  certainly because `/api/file`'s URL has no real extension in its pathname
  (the ext is in the `path=` query param Pixi's format-sniffing doesn't
  inspect). A shared-route property, not Electron-specific.
- Expected: for the assets/sceneview owners to confirm and fix the loader
  format hint. Flagged here for cross-check.
- Source: ELECTRON-3
- Disposition: deferred-M (T9-U8) — the fix lives in packages/runtime's Pixi
  asset-loading path (passing an explicit loadParser/format hint per asset,
  since `/api/file?…&path=x.svg` hides the extension from Pixi's
  URL-sniffing), which is an engine-side loader change outside this editor
  sweep's scope and blast radius (every sprite/tile/font load routes through
  it — needs its own verification pass across asset types). Impact today is a
  console warning with graceful fallback, not a functional break.

### L-106 · electron · defect · low
- Element: CodeMirror `.cm-content` text input, packaged app (unconfirmed
  scope).
- Observed: literal per-keystroke synthetic typing dropped/garbled characters
  (`local probeEditSlow = 42` → `loclprobit=42`), while `insertText` (paste-like)
  was byte-perfect — strongly suggesting an interaction between CodeMirror's
  live autocomplete popup and rapid keydown simulation, NOT the Electron
  bundle (same wiring runs in dev). Could not confirm/rule out dev-mode repro.
- Expected: for the Code-panel owner to confirm against dev mode; if it
  reproduces there it's a narrow (synthetic-typing-speed) data-integrity bug.
- Source: ELECTRON-4 (unconfirmed)
- Disposition: deferred-M (T9-U8) — still unconfirmed and unreproducible by a
  human path: the auditor's own evidence points at rapid SYNTHETIC keydown
  simulation racing CodeMirror's autocomplete popup (paste-like `insertText`
  was byte-perfect through the same wiring, and this sweep's live checks
  typed into CodeMirror headlessly at playwright speed without a dropped
  character). No fix is targetable until someone reproduces it with real
  typing on a packaged build; parking it as an M-track manual-repro task
  rather than guessing at a patch.

### L-107 · electron · polish · low
- Element: same packaged MIME table — no `.woff` entry.
- Observed: `.woff2` is mapped, plain `.woff` isn't, though
  `@fontsource/ibm-plex-mono` ships both; harmless in practice (Chromium takes
  woff2, the `.woff` fallback is never fetched) but a latent completeness gap.
- Expected: add `'.woff'` in the same edit as L-104.
- Source: ELECTRON-2
- Disposition: fixed b0fcb00 (same stale-ledger situation as L-104; verified
  T9-U8: `'.woff': 'font/woff'` is present in the packaged app's MIME table).

## cross-cutting patterns

### L-108 · cross-cutting · defect · high
- Element: shared field-commit feedback — `NumberField` / `ColorField` /
  `TextField` (`ui.tsx`) and every panel that commits through them, plus
  add/rename actions that reject silently. **Systemic**: one shared mechanism
  fixes every sub-item below.
- Observed: three flavors of the same "silent rejection / no inline validation
  feedback" root cause (the field's `useEffect(() => setDraft(value), [value])`
  never re-fires when a rejected write leaves `value` unchanged, and there's no
  client-side validation or inline error surface):
  - **Commits a bad value silently** — `NumberField` empty/non-numeric draft
    commits `0` (`Number('')` passes `isFinite`), silently corrupting
    Position/Scale/Mass/etc. (INSPECTOR-1). Game Settings Title commits `""`;
    Background/Loading hex commits an arbitrary non-hex string verbatim while
    the swatch silently falls back to `#fff` (GAMESETTINGS-4).
  - **Shows a phantom value after a rejected commit** — `ColorField` invalid
    hex stays displayed until remount (INSPECTOR-2); PostEffects/SpriteEffects
    out-of-range numeric stays displayed, snaps back only on reselect
    (INSPSPEC-1); Input axis-name rejected rename keeps the typed text while
    the real key is unchanged, durably (INPUT-1, defect).
  - **Silent no-op with no inline signal** — duplicate action name
    (INPUT-2), duplicate axis name (INPUT-3), duplicate key capture (INPUT-4),
    create-sprite/tile name conflict (ASSETS-2), Save-as-prefab name conflict
    where the only feedback is a Console tab badge (HIER-7).
- Expected: a shared field-commit-feedback mechanism — client-side validation
  where the bound schema is known (clamp/reject empty/out-of-range/bad-hex),
  resync `draft` to the real value when a commit is rejected, and surface an
  inline error at the point of use (the `TileCharField`/`SliceDialog`/IntField
  patterns already do this correctly and are the template).
- Source: INSPECTOR-1, INSPECTOR-2, INSPSPEC-1, INPUT-1, INPUT-2, INPUT-3,
  INPUT-4, GAMESETTINGS-4, ASSETS-2, HIER-7
- Disposition: fixed 0000dd0 (shared field rejection contract in ui.tsx: client
  validation + revert + shake/`.invalid` cue) + per-consumer wiring. Sub-items:
  - INSPECTOR-1 (empty/garbage NumberField → 0): fixed 0000dd0 — empty/NaN
    reverts, never commits 0.
  - INSPECTOR-2 (ColorField invalid hex): fixed 0000dd0 — client hex validation
    (#rgb/#rrggbb/#rrggbbaa), revert + cue, swatch holds last valid.
  - INSPSPEC-1 (PostEffects/SpriteEffects out-of-range numeric): fixed d37187f —
    NumberField gains min/max; PostEffectsField wires schema ranges.
  - INPUT-1 (axis rename keeps rejected text): fixed 6e81559 — rename reverts +
    names the conflict inline.
  - INPUT-2 (duplicate action add silent): fixed 6e81559 — inline reason under
    the add row.
  - INPUT-3 (duplicate axis add/rename silent): fixed 6e81559.
  - INPUT-4 (duplicate key capture silent): fixed 6e81559 — brief "already
    bound here" notice.
  - GAMESETTINGS-4 (blank title / bad hex committed): fixed 383636b — blank
    title reverts; color fields inherit ColorField validation.
  - ASSETS-2 (create-asset CONFLICT silent): fixed 383636b — inline error in the
    create-sprite/create-tile dialogs.
  - HIER-7 (save-as-prefab conflict silent): fixed 383636b — input stays open
    and names the conflict.

### L-109 · cross-cutting · polish · med
- Element: accessible names / label associations across shared components and
  panels. **Systemic** (Wave-K "aria-labels" tail).
- Observed: missing accessible names in several surfaces —
  - AnimatorEditor's 7 non-"Machine" `<select>`s have no aria-label/labelledby/
    title (announced as bare "combobox") (ANIMATOR-6).
  - Game Settings field labels use `htmlFor` pointing at inputs that render no
    `id` (`ui.tsx` never accepts/renders `id`), so 6 of 7 rows aren't
    click-to-focus or SR-associated (GAMESETTINGS-3).
  - Export `Modal` title is a plain `div` with no `aria-labelledby`/`aria-label`
    on the `<dialog>` (EXPORTDIALOG-2).
  - Hierarchy `treeitem`s never expose `aria-expanded`/`aria-level`/
    `aria-posinset`/`aria-setsize` (HIER-12).
- Expected: add `id` support to `ui.tsx` fields (wire label `htmlFor`), a
  shared modal `aria-labelledby`, per-`select` aria-labels in the Animator, and
  the tree structural attributes.
- Source: ANIMATOR-6, GAMESETTINGS-3, EXPORTDIALOG-2, HIER-12 (Wave-K:
  "aria-labels")
- Disposition: fixed — all four sub-items closed:
  - ANIMATOR-6 (T8-B6): all 7 non-"Machine" `<select>`s in AnimatorEditor
    carry `aria-label`s (param type, state animation, transition from/to,
    condition param/operator/value); the toolbar "New" button too. File:
    AnimatorEditor.tsx.
  - HIER-12 (T9-U1, 6a7d9d1): tree rows expose `aria-level`/`aria-expanded`
    (closed alongside L-016's keyboard-nav work).
  - GAMESETTINGS-3 (T9-U8, 75de4be): ui.tsx's NumberField/TextField/
    ColorField (and GameSettings' local IntField + SpriteAssetPicker) accept
    an `id` rendered on the labellable control; every Game Settings row's
    `<label htmlFor>` now points at a real id (game-title/-width/-height/
    -bg/-fps/-timestep/-loading-bg/-loading-image/-icon), so click-to-focus
    and SR association work on all rows.
  - EXPORTDIALOG-2 (T9-U8, 75de4be): the shared Modal names its `<dialog>`
    via `aria-labelledby` pointing at the visible `.modal-title` (useId), so
    every modal in the app — Export included — announces its title.

### L-110 · cross-cutting · polish · low
- Element: `Icon` component SVG glyph fallback.
- Observed: the hand-authored 12×12 stroke `Icon` set needs a defined fallback
  when a glyph name is unknown/missing (rather than rendering nothing or a
  broken box).
- Expected: a deliberate SVG icon fallback for unknown names.
- Source: Wave-K tail ("SVG icon fallback")
- Disposition: by-design (verified T9-U8, already implemented) — `Icon`
  renders `ICON_PATHS[name] ?? ICON_PATHS.entity` (ui.tsx), so an unknown
  glyph name deliberately falls back to the neutral entity square rather
  than an empty SVG or broken box. Exactly what this entry asks for; nothing
  further to add without inventing a distinct "missing icon" glyph nobody
  should ever see.

---

## Summary

**Totals: 110 entries — 5 fixed, 105 open.**

By category: **defect 31** (high 16, med 13, low 2), **friction 52**
(high 6, med 25, low 21), **polish 27** (high 2, med 2, low 23).

### Counts by area × category × severity

| Area | Def H | Def M | Def L | Fri H | Fri M | Fri L | Pol H | Pol M | Pol L | Total |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| runtime/core | 2 | | | | | | | | | 2 |
| workspace shell | 1 | | | | | | | | | 1 |
| toolbar+menus | 2 | 1 | | | 1 | 2 | | | 1 | 7 |
| hierarchy | | 3 | | 1 | 3 | 3 | | | 3 | 13 |
| sceneview | 1 | 1 | | | 2 | 2 | | | 2 | 8 |
| inspector | | 1 | | 1 | 6 | 2 | 1 | 1 | | 12 |
| assets | | | | 1 | 2 | 3 | | | 3 | 9 |
| code | 2 | 1 | | | 3 | | | | | 6 |
| console-changes | 2 | 2 | | | 1 | | | | 3 | 8 |
| playmode-live | | 1 | | | 2 | 1 | | | | 4 |
| input | | | | | | 1 | | | 2 | 3 |
| gamesettings | 1 | | | | 1 | 2 | 1 | | 1 | 6 |
| animator | 3 | | | 3 | | | | | 3 | 9 |
| agent | 1 | 1 | | | 2 | 4 | | | 2 | 10 |
| export | | 1 | | | | | | | | 1 |
| launcher | | | | | 2 | 1 | | | 1 | 4 |
| electron | | 1 | 2 | | | | | | 1 | 4 |
| cross-cutting | 1 | | | | | | | 1 | 1 | 3 |
| **Total** | **16** | **13** | **2** | **6** | **25** | **21** | **2** | **2** | **23** | **110** |

Column totals: Def 31, Fri 52, Pol 27; grand total 110. Fixed items (L-004,
L-005, L-006, L-007, L-010 — all toolbar+menus) are counted in the toolbar row
with disposition `fixed`; the remaining 105 are `open`.

### Suggested batch grouping

Batches are cut by file-set contention so parallel T8/T9 dispatches never edit
the same file. Model per Jake's sizing rule (sonnet for mechanical, opus/fable
for cross-cutting / core-touching).

**T8 — defect burn-down**

- **B1 · runtime/core input** (opus; `packages/runtime/src/{pixi/index.ts,
  input.ts}`, `packages/core/src/commands/*`): L-001 (attachKeyboard
  preventDefault), L-002 (codeToActions axis gap), plus core-command guards
  L-011 (rename uniqueness), L-012 (createPrefab re-link), L-013 (no-op reparent
  parentId guard), L-032 (same-value override equality). One owner — the input
  subsystem and command layer are shared.
- **B2 · dockview/workspace** (opus; `Workspace.tsx`): L-003 alone (init race +
  all-panels-closed). High value, isolated file, blocks everything on open —
  land early.
- **B3 · shared field-commit feedback** (opus; `ui.tsx` + light per-consumer
  touch): L-108 systemic. Fixes INSPECTOR-1/2, INSPSPEC-1, INPUT-1/2/3/4,
  GAMESETTINGS-4, ASSETS-2, HIER-7 behind one mechanism. Serialize BEFORE the
  per-panel batches so they inherit the primitive.
- **B4 · SceneView** (opus; `SceneView.tsx` — high contention, serialize):
  L-053 (space-to-pan guard → `isTypingTarget`), L-024 (UI-anchor rendering),
  L-025 (playing-guard), plus the JAKE-STEER removals L-026/L-027 and L-031.
  All one file — do as one owner, not parallel.
- **B5 · code/console/diff** (sonnet; `CodePanel`/`ConsolePanel`/`DiffPanel`/
  `store.ts`): L-054 (external-edit backstop), L-055 (hover verify), L-056/L-057
  (Cmd+S routing, empty-state), L-058 (buffer reset), L-059 (auto-scroll),
  L-060 (refreshDiff call sites), L-061/L-062 (console error link/dedup),
  L-090 (Restore-checkpoint diff refresh — same diff-staleness family).
- **B6 · animator** (sonnet; `asmEdit.ts`/`AnimatorEditor.tsx`/`keybinds.ts`):
  L-080 (setParamType gate + tests), L-081 (mod+s claim), L-082 (external-edit
  guard).
- **B7 · per-panel small defects** (sonnet, parallel — disjoint files):
  gamesettings L-074 (picker filter); agent L-089 (running guard); export
  L-099 (Escape guard); electron L-104 + L-107 (`electron/main.ts` MIME).

**T9 — UX tightening** (all `apps/editor` only; batch by panel, no cross-file
contention with T8 once B1–B7 land)

- **U1 · Hierarchy interaction**: L-014 (drag-reparent), L-015 (delete-confirm
  contract), L-016 (tree keyboard nav), L-017 (multi-select), L-018 (search),
  L-019 (context menu), L-020 (play-mode hint).
- **U2 · Inspector ergonomics**: L-033 (Tilemap grid editor), L-034 (Script
  params/scriptPath), L-035/L-036 (prefab confirm + detach notice), L-037 (card
  collapse), L-038 (Transform copy), L-039 (sprite-mode memory), L-040/L-041
  (revert-component + slot width). Pairs with T10 row-grid.
- **U3 · Assets housekeeping**: L-044 (rename/delete/duplicate), L-045 (search),
  L-046 (double-click), L-047 (grid nav), L-048 (banner dismiss), L-049
  (+Sound). Add L-084 (+State machine) here — same Assets-panel create surface.
- **U4 · Agent trust**: L-091/L-092 (mode picker + manual --mode), L-093–L-098
  (copy/feedback/labels/height).
- **U5 · Play-mode**: L-067 (tab-switch stop signal), L-068 (perf profiling),
  L-069 (mid-play mapping hint), L-070 (pause indicator).
- **U6 · Animator direct-manipulation**: L-083 (dirty-switch confirm), L-085
  (transition reorder/grouping). (L-084 lands in U3.)
- **U7 · Launcher + Game Settings**: L-100/L-101/L-102 (launcher layout/recents/
  busy), L-075/L-076/L-077 (settings scroll/thumbnail/live-patch).
- **U8 · Standing items (T9 §1) + polish/a11y sweep (T7/T12)**: every panel
  empty state + uniform `ConfirmDialog`; L-108-adjacent copy (L-073 friendly
  errors); L-109 (aria/label associations, systemic), L-021/L-023 (hover-only
  parity), L-042/L-043 (PostEffects layout+labels), L-078 (panel header),
  L-050/L-051/L-052 (assets polish), L-110 (icon fallback), remaining `title`→
  Tooltip migrations (L-009, L-086, L-098).

### L-111 · parity · defect · med
- Element: Inspector "Enabled" toggle ↔ agent surface
- Observed: setEntityEnabled exists in the registry but has no CLI subcommand or MCP tool; agents cannot enable/disable entities.
- Expected: MCP set_entity_enabled + CLI `hearth set enabled` exposing the existing command.
- Source: PARITY.md
- Disposition: fixed 787655b (MCP `set_entity_enabled` tool + CLI `hearth set enabled <scene> <entity> <true|false>`, both dispatching the existing `setEntityEnabled` core command; no core changes)

### L-112 · parity · defect · med
- Element: Inspector Tags field ↔ agent surface
- Observed: setEntityTags unreachable post-create (only `create entity --tags`); no MCP tool, no CLI path.
- Expected: MCP set_entity_tags + CLI `hearth set tags` exposing the existing command.
- Source: PARITY.md
- Disposition: fixed 787655b (MCP `set_entity_tags` tool + CLI `hearth set tags <scene> <entity> <a,b,c>`, both dispatching the existing `setEntityTags` core command; no core changes)

### L-113 · investigate · defect · high
- Element: prefab instance field edit → override recording
- Observed: T7 live walkthrough: component-field edit (Position.x 7→123) committed but recorded NO override (no dot, no revert affordance). Possibly scene/entity-context (non-instance?) or a real recording regression.
- Expected: field edits on prefab instances record overrides with revert affordance (Wave I behavior).
- Source: T7 report
- Disposition: by-design (T9-U2 investigation). Not a regression — override recording works correctly. Root cause of T7's observation: **editing `Transform.position.x` on a prefab-instance ROOT records no override by design**, because the root's own position is per-instance placement, not an override (recordInstanceOverride's explicit root exclusion in prefabData.ts:260; asserted by the core test "never records a write to the ROOT Transform.position", prefabOverrides.test.ts — 19/19 green). T7 almost certainly edited Position.x on a single-entity instance root (ember-horde's "Elite Enemy" is exactly this shape) or on the legacy-detached "Enemy" instance (empty `ids: {}` → not a live member → records nothing for ANY field). Live-verified in ember-horde: editing Elite Enemy's SpriteRenderer.opacity (a non-position field on the root) DID record an override — the ember dot appeared and the banner went 3→4 overrides; editing the same root's Transform.position.x changed the value (680→999 in the scene file) but correctly recorded NO override. The B1 same-value equality guard (L-032) does not over-suppress: a changed value still records (valuesEqual(680,999)=false; core test "replaces on repeat write" is green). No code change; L-113 closed.

### L-114 · electron · defect · med
- Element: Electron native window-close (window title-bar close button, Cmd+Q,
  `app` before-quit) vs. the editor's unsaved-script guard.
- Observed: the in-app "Close project" menu routes through
  `requestCloseProject()`, which confirms discarding dirty Code-panel buffers
  before closing (L-058). A native window close or Cmd+Q bypasses that path
  entirely — the renderer is torn down with no `beforeunload`/close-intercept —
  so unsaved script edits (the one non-autosave surface) are silently lost with
  no confirm. The web build has the same gap via the tab close/refresh, but the
  packaged desktop app is where a window-close feels like a safe, routine action.
- Expected: intercept the native close (Electron `win.on('close')` +
  `app.on('before-quit')`, and a renderer `beforeunload`) to run the same
  unsaved-scripts confirm before the window is destroyed, including the Cmd+Q
  quit-all path.
- Source: B5 follow-up review (dispatch T8-B5)
- Disposition: deferred-M (needs a native close-intercept design spanning the
  Electron main process (`win.on('close')` / `app.on('before-quit')`, which must
  round-trip to the renderer to read `hasUnsavedScripts` and show the dialog
  before allowing the destroy) AND the Cmd+Q quit-all case — out of scope for a
  renderer-only console/store fix batch; belongs with an Electron-shell task)

### L-115 · console-changes · defect · low
- Element: cross-process undo-history race — a CLI/MCP agent running in a
  SEPARATE process concurrently with the editor, both mutating the same
  project's undo history.
- Observed: this batch serializes mutating dispatch at two IN-PROCESS layers —
  the editor store chains undo/redo (queueHistoryOp), and the editor server
  holds a per-project async mutex over mutating `/api/command` dispatch
  (projectServer.ts `withMutationLock`). Neither reaches a `hearth` CLI or MCP
  server running as its own OS process: those hold no share of the server mutex,
  so an external `hearth undo` interleaving with an editor undo can still race
  the on-disk history cursor / journal seq (the pre-existing dup-journal-seq
  tail item — getSession already has a self-healing reload for external edits,
  but no cross-process WRITE lock).
- Expected: a cross-process advisory lock (e.g. an OS file lock on
  `.hearth/history/index.json`) so any process serializes its history
  read-modify-write. Explicitly NOT attempted here — cross-process locking is a
  distinct mechanism from the in-process promise chains and warrants its own
  design.
- Source: B5 follow-up review (dispatch T8-B5); pre-existing
- Disposition: deferred-M (pre-existing; out of scope — in-process
  serialization landed this batch, cross-process locking is a separate task)

### L-116 · workspace · defect · high
- Element: dockview null-'clear' pageerror — RECURRENCE after 68c6def
- Observed: U4+U7 reviewer hit "Cannot read properties of null (reading 'clear')" once during live probes (post-B2-fix HEAD); B5 reviewer also saw one during rapid project switching. Intermittent, ~once per session of heavy probing.
- Expected: zero occurrences; B2's isDockAlive guards cover resetLayout/showPanel but some other path still reaches clear() on a null/disposed target.
- Source: U4+U7 review aside; B5 review incidental
- Disposition: hardened a752c69 — mechanism-targeted guard for the only verified null-clear path (Pixi Graphics teardown race); unreproducible in sandboxed browsers; if it recurs post-hardening, Wave M captures a foreground-GPU stack (window.onerror logger) per the investigation notes. Detail below.

  Investigation (L-116 investigator, systematic-debugging):
  1. Isolated which op on a *fully-disposed* dockview throws what, against a real dockview in jsdom (extends B2's workspaceDock.test.ts pattern): `api.clear()`, `addPanel`, `fromJSON`, and `panel.api.close()` all throw **"invalid location"** (NotFoundError-class) — NOT "reading 'clear'". `toJSON`/`setActive` no-op. So B2's isDockAlive guard (which detects the disposed state via element.isConnected) correctly suppresses the disposed-dock case, and the recurring "reading 'clear'" does NOT come from a fully-disposed dock.
  2. Audited every `.clear()` call site in dockview-core + dockview-react (the exact vite-prebundled bundle the app runs): every receiver is either a constructor-assigned non-null field (`this.gridview`, `this.component`, the `_doClear`→`gridview.clear()` chain) or optional-chained (`target?.clear()`, `dropTargetContainer?.model?.clear()`). None can be a literal `null` receiver. So dockview-core is NOT the thrower of a *null* `.clear()`.
  3. Found the ONLY code path in the whole codebase that provably yields exactly "Cannot read properties of null (reading 'clear')": **Pixi v8 `Graphics.clear()` after `Graphics.destroy()`** — destroy() sets `this._context = null`; clear() → `_callContextMethod('clear')` → `this.context.clear()` → null.clear(). Verified against the vendored pixi.js source. This fits the two idle-audit clues (gamesettings.md "fires a few seconds after open, idle, zero interaction"; inspector-core.md "looks Scene-view/canvas related, active particles/physics") far better than the dockview attribution (which was auditor *speculation* in agent.md — its "View menu wedges until reload" symptom matches the *pre-B2* L-003, already fixed).
  4. Could not reproduce/capture the live stack. Built a Playwright stress harness (own vite :5342, real headless Chromium + swiftshader, `page.on('pageerror', …)`, drives open→play→scene-switch→rapid-switch→close via the store) AND instrumented `Graphics.prototype.clear` to record a stack the instant it hits a null `_context`. Ran ~1000+ cycles across 5 regimes: **0 null-context clears out of 30k+ instrumented Graphics.clear calls**, 0 "reading clear" pageerrors. jsdom dockview lifecycle harness (StrictMode + rekey/unmount/toggle + 300ms debounced save): 400 cycles, 0 errors. So the *normal* render/scene-switch/teardown path never clears a destroyed graphics; the race only manifests under real-GPU + foreground-tab timing that this sandbox cannot provide (all real Chrome/headed surfaces here are backgrounded → rAF frozen; headless swiftshader renders but its synchronous teardown doesn't leave the post-destroy tick window a real GPU does).
  - Ruled out: dockview-core (non-null/guarded receivers; disposed→"invalid location", already guarded). Normal Pixi render loop (instrument-clean). WebGL context-loss nulling `gl` (Pixi v8's GlContextSystem keeps `gl` and flags `isContextLost()`, doesn't null it).
  - Noise seen during probing (NOT L-116): transient `ReferenceError: copied is not defined` / `smError is not defined` (ConsolePanel/AssetsPanel) with vite HMR `?t=` URLs — both vars ARE defined in source; these were HMR artifacts from *concurrent multi-agent edits* to the shared repo mid-run.
  - Recommended next step: capture the real stack from a foreground, real-GPU browser session (a reviewer reproducing with devtools "Pause on caught/uncaught exceptions", or a temporary editor-side `window.addEventListener('error')` that logs the full `e.error.stack` for this message). The stack will point at either a runtime `PixiSceneView` redraw helper (`redrawLine`/`redrawSlider`/`redrawToggle`/`updateParticles` in packages/runtime/src/pixi/index.ts, all of which call `g.clear()`) or the teardown ordering in `PixiSceneView.destroy()` / GamePreview unmount — a `g.destroyed`-guard or ticker-ordering fix there is then the root fix. No speculative guard shipped: the fix-validation gate (0 occurrences over 3x repro cycles) is unsatisfiable until the crash can be reproduced, so a blind guard could neither be validated nor safely claimed to resolve it.

---

## T9-U8 closing sweep — standing items (2026-07-14)

Beyond the per-entry dispositions above, the closing sweep landed the plan's
T9 standing items that weren't tracked as numbered entries:

- **Panel empty states (icon + one-line purpose + primary next action).**
  Gaps closed: Console ("Console is quiet" gains a Validate project action;
  a filtered-empty view gets its own state + "Show all"), Changes ("No
  checkpoint to compare against" gains a Checkpoint action), Live (icon +
  a Play action added to the not-playing state), Code ("No scripts" gains a
  New script action + honest copy — see L-057). Hierarchy/Inspector/Assets/
  Animator/Agent-Timeline/Input already met the bar from earlier batches.
- **Unread console badge while scrolled up** (B5 review follow-up): the store
  now mirrors the Console's at-bottom scroll state (`consoleAtBottom` /
  `setConsoleAtBottom`); errors count as unread when the tab is hidden OR
  visible-but-scrolled-up, and returning to the bottom clears the badge.
  Unit-tested against the real store (consoleUnread.test.ts). Commit 252122a.
- **One state-machine create dialog** (U3-vs-B6 duplication, T12 note):
  AnimatorEditor's and AssetsPanel's parallel "New state machine" modals are
  now a single shared `CreateStateMachineDialog` component (one seed payload,
  one inline-error presentation — the `.invalid` + `.field-error` field
  idiom). Commit 10747ef.

Flags for the T12 design pass: hover-reveal idiom unification (L-023, with
the tab-order contract), history click-to-jump candidacy (L-063), hierarchy
filter + multi-select design (L-017/L-018), Tilemap grid direct-manipulation
editor (L-033).

### L-117 · shipping · defect · high (SHIP-BLOCKING)
- Element: desktop export zip → fresh unzip → launch
- Observed: createZip (packages/shipping/src/zip.ts) encodes Unix mode bits only for symlinks; every executable in the zipped .app unzips as -rw-r--r-- (0 of 15 executables). `open -n` fails "Launchd job spawn failed". All desktop platforms affected (Windows likely unaffected).
- Expected: unzip → launch works. chmod +x restore confirmed full fix.
- Source: T13 export-reality D-1
- Disposition: fixed — `createZip` now encodes every entry's real Unix
  `st_mode` (from `lstat`) into the central-directory external attributes
  (upper 16 bits), and tags "version made by" UNIX for all entries, not just
  symlinks. `zipDirectory` captures each regular file's mode via `lstat`, so
  the `+x` on a packaged .app's Mach-O binaries and Helper apps survives the
  zip round-trip (symlinks keep S_IFLNK|0777 unchanged; a missing mode falls
  back to rw-r--r--). packages/shipping/src/zip.ts. Tests: zip.test.ts
  "preserves the executable bit through a real system-unzip round-trip"
  (execFileSync unzip → stat → assert exec/non-exec bits) + the extended
  byte-layout regression "encodes UNIX modes in the central directory for
  symlinks AND regular files"; desktop-integration.test.ts now unzips the
  real produced zip and asserts the main binary + a Helper.app binary are
  executable. Live proof (drift-cellar spec, darwin-arm64): packageDesktop →
  fresh `unzip` → main binary mode 755, `open -n` exit 0 with a full Electron
  process tree (4 PIDs), quit clean — the exact sequence that previously
  failed "Launchd job spawn failed".

### L-118 · export-ux · friction · med
- Element: export result panel + player boot errors (F-1..F-5)
- Observed: no next-step hosting/itch hint in result panel; folder build under file:// shows raw "Failed to fetch"; Gatekeeper guidance docs-only; generic com.electron.* bundle id; no size context on 254MB zip.
- Source: T13 export-reality F-1..F-5
- Disposition: fixed —
  - **F-4 (bundle id): fixed** — `packageDesktop` now passes
    `appBundleId: com.hearth.<slug>` to `@electron/packager` instead of
    letting it fall back to the generic `com.electron.<name>`, so two
    Hearth-exported games no longer collide under near-identical ids (and per-
    bundle-id OS state — notifications/TCC — is per-game). packages/shipping/
    src/package.ts. Test: package.test.ts "sets a project-derived bundle
    identifier instead of the com.electron default (F-4)". Live-verified in
    Info.plist: `CFBundleIdentifier` = `com.hearth.drift-cellar`.
  - **F-1 (result-panel next-step hint): fixed** — the finished web-export
    result gains a one-line quiet hint ("Upload the zip to itch.io or any
    static host — see the shipping guide", linking
    docs/shipping-to-itch.md's hosted URL) and the finished desktop result
    gains its own ("Unzip and share — players double-click the app.").
    Pure copy helpers (`webNextStepHint`, `desktopNextStepHint`,
    `SHIPPING_GUIDE_URL`) in apps/editor/src/components/exportJob.ts,
    rendered in ExportDialog.tsx's WebPane/DesktopPane under a new
    `.export-hint` class (quiet: `--ink-faint`, `--text-xs`, matching
    `.radio-detail`'s register). Tests: exportDialog.test.ts "next-step
    hints" block.
  - **F-2 (`file://` folder-build error copy): fixed** — the exported
    folder build's boot script now detects `location.protocol === 'file:'`
    before ever calling `fetch('project.bundle.json')` and shows "This
    build needs a web server — run one locally (e.g. npx serve) or use the
    single-file export for direct opening." instead of the raw "Failed to
    fetch". New pure `fileProtocolBootMessage(protocol)` in
    packages/core/src/commands/exportCommands.ts; its own source (via
    `.toString()`) is inlined verbatim into `renderIndexHtml`'s folder-build
    script so the shipped check and the unit test exercise the exact same
    function, not a hand-copied duplicate. Single-file builds don't inline
    it (they never fetch anything). Tests: export.test.ts
    "fileProtocolBootMessage" block + folder/single-file assertions. Live-
    verified: opening `export/web/index.html` via `file://` in real Chrome
    now shows the friendly message in `#hearth-status-text`.
  - **F-3 (in-app Gatekeeper guidance): fixed** — the finished desktop
    result's hint line appends a short Gatekeeper note — "First launch on
    macOS: right-click the app and choose Open (Gatekeeper)." — whenever at
    least one finished build in the job targets macOS (pure
    `desktopMacGatekeeperNote(platforms)`, exportJob.ts). Windows/Linux-only
    jobs get no macOS note. Live-verified in the export dialog after a real
    darwin-arm64 packageDesktop run.
  - **F-5 (zip-size context): fixed** — the finished desktop result now
    shows the produced zip's byte size next to its path (e.g. "243.1 MB"),
    quiet-styled (`.export-zip-size`, `--ink-faint`/`--text-xs`). The
    server stats each build's zip right before the export-done frame goes
    out (`attachZipSizes` in apps/editor/server/projectServer.ts, using
    `fs.stat` — a stat failure just leaves that build's size unset rather
    than turning a real export success into an error) and threads it
    through a new optional `DesktopBuildResult.zipBytes` field
    (packages/core/src/commands/types.ts) to the dialog's `PlatformRow`.
    Pure `formatBytes(bytes)` (exportJob.ts) renders the human size. Tests:
    desktopExportRoute.test.ts "stats the produced zip..." (writes a real
    file and asserts the stated byte count survives the export-done frame),
    exportDialog.test.ts "formatBytes" + zipBytes-through-the-reducer
    blocks. Live-verified: a real darwin-arm64 export of drift-cellar
    reported "243.1 MB" next to the zip path, matching `ls -la` on the
    actual produced file.
  - Files: apps/editor/src/components/ExportDialog.tsx,
    apps/editor/src/components/exportJob.ts,
    apps/editor/src/styles/panels/export.css,
    apps/editor/server/projectServer.ts,
    packages/core/src/commands/exportCommands.ts,
    packages/core/src/commands/types.ts, packages/core/src/index.ts.
