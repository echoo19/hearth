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
- Disposition: open

### L-009 · toolbar · polish · low
- Element: "View" toolbar button — missing `title`.
- Observed: every other primary toolbar control has a tooltip; View's is null.
- Expected: a short tooltip for consistency (may be moot after T6 folds View
  into the menu bar).
- Source: TOOLBAR-8
- Disposition: open

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
- Disposition: fixed 5a9e079 (renameEntity auto-suffixes a colliding rename, matching the create/instantiate uniqueness invariant)

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
- Disposition: open

### L-015 · hierarchy · friction · med
- Element: Delete/Backspace keybind vs. row trash button.
- Observed: keybind deletes instantly with no confirm (silently re-parenting
  children one level up); the trash button opens a ConfirmDialog that warns
  about exactly that. Two different deletion contracts.
- Expected: one deletion contract (both confirm, or neither).
- Source: HIER-3
- Disposition: open

### L-016 · hierarchy · friction · med
- Element: tree keyboard navigation.
- Observed: `role="tree"`/`treeitem` declared but no keyboard contract —
  Arrow nav, Left/Right collapse-expand, F2, Home/End all absent; every row is
  a tab stop plus 4 more for a selected row's actions (~19 tab stops for 15
  entities).
- Expected: roving tabindex, arrow nav, Left/Right expand-collapse, F2 rename.
- Source: HIER-5
- Disposition: open

### L-017 · hierarchy · friction · med
- Element: row selection — multi-select.
- Observed: no multi-select; Shift/Cmd-click just replace the single
  selection. Multiplies the cost of L-014/L-015.
- Expected: Shift/Cmd range- and toggle-select for bulk ops.
- Source: HIER-6
- Disposition: open

### L-018 · hierarchy · friction · low
- Element: panel search/filter.
- Observed: none; fine at 15 entities, unusable at scale.
- Expected: a filter box / Cmd+F scoping in the header.
- Source: HIER-9
- Disposition: open

### L-019 · hierarchy · friction · low
- Element: tree rows — context menu.
- Observed: right-click shows nothing; all row ops live in the hover cluster.
- Expected: right-click menu mirroring row actions.
- Source: HIER-10
- Disposition: open

### L-020 · hierarchy · friction · low
- Element: tree contents during play mode.
- Observed: during play the tree shows only the 15 design-time entities while
  130+ spawned enemies run on screen, with no hint that this is the edit-time
  document (Live panel holds runtime state).
- Expected: a subtle play-mode header hint.
- Source: HIER-15
- Disposition: open

### L-021 · hierarchy · polish · low
- Element: `.tree-name` native `title` tooltip.
- Observed: hovering an entity name shows the raw internal id (`ent_7ltyzbrz`).
- Expected: show the (truncated) name; ids belong in the Inspector header.
- Source: HIER-11
- Disposition: open

### L-022 · hierarchy · polish · low
- Element: Delete confirm dialog — initial focus.
- Observed: `autoFocus` on the confirm button loses a race to showModal's
  first-focusable (Cancel); Cancel-focused is arguably safer but is accidental.
- Expected: decide which button owns focus and wire it deterministically.
- Source: HIER-13
- Disposition: open

### L-023 · hierarchy · polish · low
- Element: `.tree-actions` hidden-until-hover idiom (`display:none`).
- Observed: `display:none` removes row actions from tab order for unselected
  rows; the Inspector's `.field-revert-btn` deliberately uses opacity to stay
  tab-reachable — the two panels disagree. (T7 hover-only parity target.)
- Expected: one idiom repo-wide.
- Source: HIER-14
- Disposition: open

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
- Disposition: open

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
- Disposition: open

### L-026 · sceneview · friction · med
- Element: SceneView persistent hint bar (`SceneView.tsx` ~line 1852).
- Observed: a persistent floating hint bar sits over the scene chrome.
- Expected: **[JAKE-STEER 2026-07-14, mandatory]** delete the hint bar; the
  `?` shortcut sheet keeps the reference. No floating scene-level chrome.
- Source: JAKE-STEER (plan T9 Step 1)
- Disposition: open

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
- Disposition: open

### L-028 · sceneview · friction · low
- Element: toolbar "Debug" button while the Scene tab is active.
- Observed: toggling Debug has zero effect on the Scene view (pixel-identical);
  SceneView never reads `store.debugDraw` — the flag only affects the Game
  tab's overlay. Scene gizmos always render and can't be hidden.
- Expected: gray out/relabel Debug on the Scene tab, or wire it to the Scene
  gizmo layer so "Debug" means one thing across tabs.
- Source: SCENEVIEW-2
- Disposition: open

### L-029 · sceneview · friction · low
- Element: move/resize drag vs. the always-drawn 32px grid.
- Observed: nothing snaps to the grid; move rounds to integer px, resize to
  integer px / 0.01 scale, never to a grid multiple. Only the rotate handle
  has an optional 15° snap. The grid is purely decorative.
- Expected: a modifier-triggered (or default) snap-to-grid to match the
  expectation the drawn grid sets.
- Source: SCENEVIEW-3
- Disposition: open

### L-030 · sceneview · polish · low
- Element: polygon Collider / LineRenderer vertex live-drag.
- Observed: during a vertex drag only the orange draft overlay updates; the
  real underlying shape keeps the pre-drag geometry until commit, producing a
  brief double-image on thick strokes.
- Expected: a single consistent live shape during the drag.
- Source: SCENEVIEW-5
- Disposition: open

### L-031 · sceneview · polish · low
- Element: particle in-scene preview React list keys.
- Observed: the particle-circle preview uses array index as the React key.
- Expected: stable per-particle keys to avoid reconciliation churn.
- Source: Wave-K tail ("particle circle index keys")
- Disposition: open

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
- Disposition: open

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
- Disposition: open

### L-035 · inspector · friction · med
- Element: Prefab-instance banner — "Update prefab" button.
- Observed: `handleUpdatePrefab` calls `exec('updatePrefab')` immediately with
  NO confirm, while its two neighbors ("Sync instances"/"Revert all") both get
  blast-radius-aware ConfirmDialogs — yet Update prefab is the broadest-blast
  action (rewrites the shared prefab every other instance reads).
- Expected: the same confirm treatment, ideally naming how many other
  instances exist (`countPrefabInstances` is already available).
- Source: INSPSPEC-5
- Disposition: open

### L-036 · inspector · friction · med
- Element: prefab-instance detach on structural edit (`detachOnStructuralEdit`).
- Observed: adding/removing a component on an instance silently detaches it —
  banner + Hierarchy badge vanish with no dialog, toast, or tab-badge; the
  explanation lives only in a Console log line the user has no reason to be
  watching. One-way from the Inspector's view (no reattach).
- Expected: a transient inline notice in the Inspector when a detach happens.
- Source: INSPSPEC-6
- Disposition: open

### L-037 · inspector · friction · med
- Element: component cards — collapse/expand.
- Observed: no collapse affordance anywhere; a multi-component entity (~40
  field rows) forces scrolling past cards you aren't touching.
- Expected: per-card collapse (chevron by the remove button, state persisted
  at least per session).
- Source: INSPECTOR-4
- Disposition: open

### L-038 · inspector · friction · med
- Element: component remove confirm for `Transform`.
- Observed: removing Transform gets the same generic "Remove {Type}?" copy as
  any optional component, even though the command layer emits its own
  `REMOVED_TRANSFORM` warning ("the entity will not be positioned or
  rendered") that never reaches the dialog.
- Expected: a stronger, Transform-specific confirm mirroring what the command
  layer already knows.
- Source: INSPECTOR-3
- Disposition: open

### L-039 · inspector · friction · med
- Element: `TileRowEditor` sprite-mode row.
- Observed: switching a tile-char row's mode away and back (or re-picking)
  forgets the previously assigned sprite asset, forcing re-selection.
- Expected: remember the prior asset across mode switches.
- Source: Wave-K tail ("sprite-mode forgets prior asset")
- Disposition: open

### L-040 · inspector · friction · low
- Element: prefab-instance revert granularity.
- Observed: only per-field Revert and whole-instance "Revert all" exist; no
  "revert this component" in between, though a card is a natural unit (all 3
  Elite Enemy overrides live on SpriteRenderer, reverted one field at a time).
- Expected: a "Revert component" affordance in the component header.
- Source: INSPSPEC-7
- Disposition: open

### L-041 · inspector · friction · low
- Element: `.field-revert-slot` column width on instances with zero overrides.
- Observed: a non-instance entity correctly reclaims full control-column
  width, but an instance with zero overrides still reserves the ~62px
  revert-slot on every row for consistency; the width isn't reclaimed where it
  could be. (T10 row-grid target.)
- Expected: reclaim the revert-slot width when the entity isn't a prefab
  instance / has no revertable field on that row.
- Source: Wave-K tail ("field-revert-slot width reclaim"), INSPSPEC verified-list
- Disposition: open

### L-042 · inspector · polish · high
- Element: `PostEffectsField` `EffectFieldRow` number/color inputs.
- Observed: every post-effect numeric field renders as a ~36×36px square with
  the value not even wide enough to show a digit (compare the full-width
  `Ambient Light 0.15` two rows above). A user can't read strength/threshold/
  etc. without clicking into each box. Reproduces for every effect type.
- Expected: the input should stretch to fill its grid column like every other
  `.inspector-row`.
- Source: INSPSPEC-3
- Disposition: open

### L-043 · inspector · polish · med
- Element: `PostEffectsField` `EffectFieldRow` labels.
- Observed: raw camelCase schema keys shown verbatim (`strength`, `threshold`,
  `scanlineIntensity`, …) while every other Inspector field — including the
  effect *type* title above them — runs through `humanizeFieldLabel`.
- Expected: route `field` through the same humanize transform ("Scanline
  Intensity", not "scanlineIntensity").
- Source: INSPSPEC-2
- Disposition: open

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
- Disposition: open

### L-045 · assets · friction · med
- Element: asset grid — search / filter / sort.
- Observed: none; sky-courier's 19 assets sit in one flat insertion-order grid,
  found only by visual scan. Real projects will have hundreds.
- Expected: at least a name search; ideally a type filter (label already on
  every card).
- Source: ASSETS-4
- Disposition: open

### L-046 · assets · friction · med
- Element: asset card — double-click.
- Observed: double-click runs the single-click toggle twice (select then
  deselect) — reads as a flicker/no-op; the primary action (open Animator /
  open Slice / play audio) never fires.
- Expected: double-click performs the asset's primary action (or at least
  doesn't undo the selection).
- Source: ASSETS-5
- Disposition: open

### L-047 · assets · friction · low
- Element: asset grid — keyboard navigation.
- Observed: cards are Tab-focusable and Enter/Space toggle, but arrow keys do
  nothing; tabbing through 19+ cards is the only keyboard path.
- Expected: roving-tabindex grid nav (arrows move focus, Home/End).
- Source: ASSETS-6
- Disposition: open

### L-048 · assets · friction · low
- Element: import error banner (`.export-errors`).
- Observed: after a failed/partial import the red banner persists indefinitely
  (no dismiss); it only clears when the next import starts.
- Expected: a dismiss ✕ (or auto-expiry once acknowledged).
- Source: ASSETS-7
- Disposition: open

### L-049 · assets · friction · low
- Element: toolbar create affordances vs. `createSound`.
- Observed: toolbar offers "+ Sprite"/"+ Tile" only; the engine has a
  `createSound` command (procedural audio, even special-cased in the Agent
  Timeline) with no UI affordance — users can only import audio.
- Expected: a "+ Sound" affordance for parity, or a documented decision.
- Source: ASSETS-9
- Disposition: open

### L-050 · assets · polish · low
- Element: import skip-reason copy.
- Observed: the skip reason is a capability wall of text repeated per file; it
  never states the actual problem ("`.xyz` files aren't supported").
- Expected: lead with the problem, supported list secondary.
- Source: ASSETS-8
- Disposition: open

### L-051 · assets · polish · low
- Element: prefab / stateMachine / unresolved-animation card thumbnails.
- Observed: faint `--ink-faint` icon on the checkerboard transparency
  background — reads as nearly empty, and the checkerboard implies
  "transparent image" for something that isn't an image.
- Expected: higher-contrast glyph on a flat tile; reserve the checkerboard for
  real image previews.
- Source: ASSETS-10
- Disposition: open

### L-052 · assets · polish · low
- Element: audio asset details row.
- Observed: shows only name/path/id/Copy-id/Assign — no play control, no
  duration/format (sheets get a FrameGrid, fonts a live sample; audio nothing).
- Expected: details-row play/stop + duration/format.
- Source: ASSETS-11
- Disposition: open

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
- Disposition: open

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
- Disposition: open

### L-055 · code · defect · med
- Element: `ctx.` hover docs (`hoverDocs.ts` `hoverTooltip`).
- Observed: hovering a `ctx.scene.find`-style token never produced a
  `.cm-ctx-hover` tooltip across multiple synthesis methods, while `ctx.`
  autocomplete rendered fine in the same session. Flagged medium-confidence:
  headless hover-dwell is hard to trust; implementation reads soundly and has
  unit tests. Needs a real-browser sanity check before treating as confirmed.
- Expected: `ctx.` hover docs appear on dwell (verify manually).
- Source: CODE-5 (unconfirmed)
- Disposition: open

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
- Disposition: open

### L-057 · code · friction · med
- Element: Code panel empty state + lack of a "new script" affordance.
- Observed: the empty-state hint points at a "Script component in the
  Inspector" that does not exist, and there's no New-script button anywhere;
  the only `createScript` caller is a missing-file recovery path. A human with
  a blank project and no agent has no discoverable path to a first script.
- Expected: fix the false hint, or add a real "New script" action /
  Script-component path.
- Source: CODE-4
- Disposition: open

### L-058 · code · friction · med
- Element: open script buffers across a project switch.
- Observed: the Code panel carries the prior project's open file/buffer into a
  newly opened project instead of resetting.
- Expected: reset Code-panel buffers on project switch.
- Source: Wave-K tail ("Code panel carries prior file across project switch")
- Disposition: open

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
- Disposition: open

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
- Disposition: open

### L-061 · console-changes · defect · med
- Element: Console error entry for a script load failure at scene start/Play.
- Observed: the message contains the line (`shake-toggle.lua:14`) but the
  clickable link renders bare `scripts/shake-toggle.lua` with `link.line`
  null, opening the file at the top. The reload-path failure correctly
  extracts and links the line for the identical error shape — the extraction
  logic exists, it's just not applied on the initial-load path.
- Expected: apply the same line-extraction on the load-time path.
- Source: CONSOLE-CHANGES-3
- Disposition: open

### L-062 · console-changes · defect · med
- Element: Console entries for a hot-reload compile failure while playing.
- Observed: a single failure logs two near-identical lines (a `runtime`
  `recordRuntimeError` line and a `Hot-reload failed:` line) because
  `reloadScript` both returns `{ok:false}` (which `applyReload` logs) and
  internally calls `recordError` (which bridges to another log).
- Expected: one user-visible line per failure.
- Source: CONSOLE-CHANGES-4
- Disposition: open

### L-063 · console-changes · friction · med
- Element: undo/redo History-list rows (`.history-row`).
- Observed: each row is a plain `<div>` with no `onClick` — clicking does
  nothing, though the `seq` maps 1:1 to an undo/redo target, so click-to-jump
  reads as an expected affordance that isn't there (and no hover state).
- Expected: make rows clickable (jump the undo cursor), or make them not look
  interactive.
- Source: CONSOLE-CHANGES-8
- Disposition: open

### L-064 · console-changes · polish · low
- Element: Console toolbar — no level filter / search.
- Observed: only "Validate project" and "Clear"; no level/source filter, no
  text search. Compounds L-059/L-062 under a chatty run.
- Expected: at least a level filter / "errors only" toggle.
- Source: CONSOLE-CHANGES-9
- Disposition: open

### L-065 · console-changes · polish · low
- Element: Console entries — copy affordance.
- Observed: no per-entry or bulk copy; getting an error out means manual
  cross-span text selection.
- Expected: a per-row copy icon or "Copy all".
- Source: CONSOLE-CHANGES-10
- Disposition: open

### L-066 · console-changes · polish · low
- Element: duplicate console entries from React StrictMode double-mount (dev).
- Observed: `GamePreview`'s mount effect can run twice in dev, producing exact
  duplicate error lines for one failure; compounds L-062. Likely dev-only.
- Expected: guard the mount effect (or accept as dev-only), noted for
  awareness.
- Source: CONSOLE-CHANGES-11
- Disposition: open

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
- Disposition: open

### L-068 · playmode-live · friction · med
- Element: Game-preview frame pacing under load (ember-horde, 300 enemies).
- Observed: effective sim rate fell ~3x as entity count tripled (~53fps @106
  → ~18fps @306, holding at the cap) under SwiftShader — absolute numbers not
  representative, but the worse-than-linear relative degradation is a fair
  signal (candidate: per-frame entity sync in `pixi/index.ts`).
- Expected: hold near target fps at the documented cap, or degrade linearly.
  Worth a profiling pass.
- Source: PLAYMODE-4
- Disposition: open

### L-069 · playmode-live · friction · med
- Element: input-mapping edits vs. a running preview.
- Observed: editing any input mapping mid-Play doesn't affect the running
  instance (`SceneRuntime` snapshots `InputState` once; the preview reads a
  freshly-fetched store, not the editor store) — a reasonable limitation, but
  the panel gives no hint that a Play restart is needed to feel the change.
- Expected: a note in the Input panel (or Play UI) when mappings changed since
  the run started.
- Source: INPUT-6
- Disposition: open

### L-070 · playmode-live · friction · low
- Element: toolbar "Pause" (debug pause) — no in-canvas indicator.
- Observed: Pause freezes the frame counter deterministically but there's no
  on-canvas cue (no dim/overlay/border); sprites hold their last pose, so it
  can read as a hang/crash.
- Expected: a subtle "PAUSED" overlay/border tint while debug-paused.
- Source: PLAYMODE-3
- Disposition: open

## input

### L-071 · input · friction · low
- Element: gamepad-button binding (`GamepadButtonAdd`).
- Observed: the only way to bind a gamepad button is a static name dropdown;
  no "press a button on your controller" capture flow analogous to the
  keyboard one, and nothing explains why.
- Expected: likely intentional (needs a live device) — a "Press a gamepad
  button…" counterpart or an explanation of the named-mapping design.
- Source: INPUT-8
- Disposition: open

### L-072 · input · polish · low
- Element: `.inspector-row` grid reused by InputSettings for multi-line values.
- Observed: `.inspector-row` is `align-items: center`; the Keys/Gamepad/
  Negative/Positive rows stack a chip list + a capture button vertically, so
  the label floats centered against the two-line stack instead of aligning
  with its first line. (T10 row-grid target.)
- Expected: `align-items: start` (or a label top-margin) for multi-line-value
  rows.
- Source: INPUT-5
- Disposition: open

### L-073 · input · polish · low
- Element: error banner after a rejected numeric edit (deadzone/threshold).
- Observed: surfaces the raw Zod string verbatim
  ("...inputMappings.gamepadAxes.jump.threshold: Number must be less than or
  equal to 1.") — functionally correct (rollback + explanation work) but reads
  as a leaky internal error.
- Expected: friendlier copy ("Threshold must be between 0 and 1").
- Source: INPUT-7
- Disposition: open

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
- Disposition: open

### L-075 · gamesettings · friction · med
- Element: `.panel-body` (Window/Loop/Loading/Shipping sections).
- Observed: at default dock height only Window + part of Loop show; Fixed
  timestep, all of Loading, and all of Shipping (incl. the Icon field — the
  whole reason to open the panel for a shippable build) are below the fold with
  no scroll-shadow/fade cue.
- Expected: a scroll affordance so the below-fold content is discoverable.
- Source: GAMESETTINGS-6
- Disposition: open

### L-076 · gamesettings · friction · low
- Element: Loading→Image picker vs. Shipping→Icon picker thumbnails.
- Observed: the Icon picker passes `showThumbnail` and previews the sprite;
  the Loading Image picker doesn't, so selecting a loading image gives no
  visual confirmation.
- Expected: both equally-visual picks get a thumbnail (or neither).
- Source: GAMESETTINGS-5
- Disposition: open

### L-077 · gamesettings · friction · low
- Element: any Game Settings field edited during Play.
- Observed: editing even a cosmetic field (Title, Background color, Spinner)
  raises the "Scene changed — Restart" badge like a structural edit — every
  `updateSettings` call is classified `structural` regardless of field. No
  live-patch for cosmetic settings.
- Expected: classify cosmetic settings fields as live-patchable (app-wide
  classification gap, most visible here).
- Source: GAMESETTINGS-7
- Disposition: open

### L-078 · gamesettings · polish · high
- Element: `.panel-header` of the Game Settings panel — renders "Game".
- Observed: the in-body header reads "GAME" while its own dockview tab and the
  View menu read "Game Settings" — and it collides exactly with a *different*
  panel's title (`PANEL_TITLES.game = 'Game'`, the live preview host), so a
  user skimming headers sees two unrelated panels both titled "Game".
- Expected: the in-panel header should read "Game Settings" to match its tab.
- Source: GAMESETTINGS-1 (Wave-K: "'Game' panel header")
- Disposition: open

### L-079 · gamesettings · polish · low
- Element: `if (!info)` "No project open" branch (`GameSettings.tsx:193-207`).
- Observed: no UI path reaches a mounted Game Settings panel with `info` null
  ("Close project" unmounts the whole workspace to the launcher) — apparently
  unreachable defensive code that also inherits the L-078 header bug and uses a
  "run" `play` glyph for a "nothing open" message.
- Expected: confirm intent (harmless dead code) or fix the icon/header if a
  real path hits it.
- Source: GAMESETTINGS-8
- Disposition: open

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
- Disposition: open

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
- Disposition: open

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
- Disposition: open

### L-083 · animator · friction · high
- Element: "Machine" `<select>` switched while the current draft is dirty.
- Observed: `onChange` is just `setAssetId`; the load effect then loads a fresh
  draft for the new asset and overwrites `draft` with NO dirty check or
  confirm — silently discarding unsaved params/states/transitions.
  `ConfirmDialog` already exists for exactly this class of action.
- Expected: confirm before switching (or honoring an `animatorTarget` change)
  when `dirty`.
- Source: ANIMATOR-2
- Disposition: open

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
- Disposition: open

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
- Disposition: open

### L-086 · animator · polish · low
- Element: icon-only remove buttons + initial-state star toggle.
- Observed: all rely solely on native `title` (the `Icon` svg is
  `aria-hidden`), instead of the purpose-built `IconButton` that gives a
  discoverable label + tooltip + aria-label. (T7 title-sweep target;
  IconButton adoption is still sparse app-wide.)
- Expected: swap to `IconButton`.
- Source: ANIMATOR-7
- Disposition: open

### L-087 · animator · polish · low
- Element: state-row speed control vs. its delete button (`× [1] ×`).
- Observed: the "times" multiplier label `×` and the delete `Icon name="cross"`
  are the same glyph/size/color sitting adjacent at the row end — reads as one
  control group; easy to misclick.
- Expected: differentiate the multiplier label from the delete affordance.
- Source: ANIMATOR-9
- Disposition: open

### L-088 · animator · polish · low
- Element: transition Exit-time input.
- Observed: the exit-time field clamps correctly (0..1) but its input idiom is
  inconsistent with the rest of the editor's field idioms.
- Expected: align the exitTime input to the standard field idiom.
- Source: Wave-K tail ("exitTime input idiom")
- Disposition: open

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
- Disposition: open

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
- Disposition: open

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
- Disposition: open

### L-092 · agent · friction · med
- Element: "Manual setup" MCP code blocks (`mcpClaudeBlock`, `mcpJsonBlock`).
- Observed: both static templates only include `--project <path>`, never a
  `--mode` flag, though the Mode picker sits directly above and the automatic
  Prepare flow does write `--mode <tier>`. A user who picks "Full", then copies
  the manual command instead of clicking Start, gets an implicitly read-only
  config with no on-screen hint the tier didn't carry over.
- Expected: reflect the selected mode (`--mode <tier>`) in the manual blocks.
- Source: AGENT-4
- Disposition: open

### L-093 · agent · friction · low
- Element: Timeline empty state ("No activity yet").
- Observed: `journalWatcher` baselines to the journal's current `lastSeq()` on
  start and never backfills, so the feed is empty on every fresh open despite
  real on-disk history; "No activity yet" reads as "nothing has happened in
  this project", which isn't true.
- Expected: scope the copy ("No activity yet this session").
- Source: AGENT-5
- Disposition: open

### L-094 · agent · friction · low
- Element: terminal scrollback cap (`SCROLLBACK_CAP_BYTES` = 200KB).
- Observed: `droppedBytes` is tracked precisely but never rendered; a session
  past 200KB silently loses its earliest lines with no cue.
- Expected: surface `droppedBytes` near the terminal when non-zero.
- Source: AGENT-6
- Disposition: open

### L-095 · agent · friction · low
- Element: "Checkpoint" button in the Agent Timeline.
- Observed: it calls `exec('snapshotProject')` with no following `log()`, so
  clicking Checkpoint from the Agent panel shows the ✓ badge but produces no
  Console feedback — unlike the identical action from the Toolbar/Diff panel.
- Expected: add the matching `log()` call (same action, same feedback).
- Source: AGENT-7
- Disposition: open

### L-096 · agent · friction · low
- Element: Timeline row labels for per-entity mutations.
- Observed: `entryToRow`'s label is `summary || command`; a
  `setComponentProperty` row renders as `setComponentProperty` with meta
  `Arena` (the scene) — not which entity or property changed. The surface meant
  to build trust in an unattended agent makes its most common mutation the
  least legible.
- Expected: include entity name (and ideally property path) in the label/meta.
- Source: AGENT-8
- Disposition: open

### L-097 · agent · polish · low
- Element: Agent panel default docked height (`.agent-body`).
- Observed: on first open the terminal/timeline are ~143px (~6 rows), forcing
  a manual sash drag; the terminal is a primary high-attention element and the
  default feels cramped enough to read as a bug.
- Expected: a taller default initial height for the bottom group / Agent panel.
- Source: AGENT-9
- Disposition: open

### L-098 · agent · polish · low
- Element: "Checkpoint" button tooltip — Agent Timeline vs. Toolbar.
- Observed: the Toolbar tooltip includes the shortcut ("…(⇧⌘S)"); the Agent
  Timeline's identical button omits it.
- Expected: both mention the shortcut, or neither.
- Source: AGENT-10
- Disposition: open

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
- Disposition: open

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
- Disposition: open

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
- Disposition: open

### L-102 · launcher · friction · low
- Element: "Create project" / "Open" buttons while `busy`.
- Observed: only `disabled` (opacity 0.45); labels stay static, no spinner —
  on a slow filesystem the user gets no feedback anything is happening.
- Expected: swap in "Creating…"/"Opening…" (or an inline spinner) while busy.
- Source: LAUNCHER-2
- Disposition: open

### L-103 · launcher · polish · low
- Element: Recent/Examples rows — full path only via native `title`.
- Observed: paths are CSS-ellipsis-truncated; the full path is only in the
  slow, unstyled, touch-unavailable native title tooltip — the more so since
  duplicate project names are common and the path is often the only
  disambiguator.
- Expected: a styled tooltip / on-focus path reveal.
- Source: LAUNCHER-3
- Disposition: open

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
- Disposition: open

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
- Disposition: open

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
- Disposition: open

### L-107 · electron · polish · low
- Element: same packaged MIME table — no `.woff` entry.
- Observed: `.woff2` is mapped, plain `.woff` isn't, though
  `@fontsource/ibm-plex-mono` ships both; harmless in practice (Chromium takes
  woff2, the `.woff` fallback is never fetched) but a latent completeness gap.
- Expected: add `'.woff'` in the same edit as L-104.
- Source: ELECTRON-2
- Disposition: open

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
- Disposition: open

### L-110 · cross-cutting · polish · low
- Element: `Icon` component SVG glyph fallback.
- Observed: the hand-authored 12×12 stroke `Icon` set needs a defined fallback
  when a glyph name is unknown/missing (rather than rendering nothing or a
  broken box).
- Expected: a deliberate SVG icon fallback for unknown names.
- Source: Wave-K tail ("SVG icon fallback")
- Disposition: open

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
- Disposition: open
