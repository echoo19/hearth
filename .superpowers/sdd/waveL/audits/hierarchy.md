# Audit: hierarchy  (example: ember-horde, port 5212)

Surface: `apps/editor/src/components/Hierarchy.tsx` (entity tree, row actions,
create affordances, prefab badges, empty state, play-mode/undo sync).

## Findings

### HIER-1 · defect · high
- Element: Delete confirm dialog (ConfirmDialog / native `<dialog>`) — Escape key
- Observed: With ember-horde open, click the trash icon on any row → the
  "Delete “…”?" dialog opens. Press Escape: the dialog stays open (verified
  with event instrumentation: `keydown` reaches the dialog un-prevented but no
  `cancel` event ever fires; two presses, still open). The only ways out are
  clicking Cancel or the confirm button. A control test of a bare
  `<dialog>.showModal()` in the same headless Chrome closes on Escape, so this
  is app behavior, not an environment artifact.
- Root cause: the game preview attaches window-level key handlers that
  `preventDefault()` ANY key code mapped in the project's input map
  (`packages/runtime/src/pixi/index.ts` `attachKeyboard()`, lines ~542-559),
  and ember-horde maps `Escape` → `pause` (`hearth.json` `inputMappings`).
  Chromium processes the dialog close-request as the un-prevented default of
  that window keydown, so the runtime handler swallows it — even in edit mode
  with the Game tab unfocused, and even while a modal editor dialog is open.
  The editor's own keybind dispatcher explicitly passes Escape through when a
  dialog is open (`apps/editor/src/keybinds.ts` `dispatchDecision`), so the
  intent is clearly that the dialog owns Escape; the runtime layer defeats it.
- Expected: Escape closes the confirm dialog (standard modal dismissal). The
  runtime key handler should not preventDefault while an editor `<dialog>` is
  open (or at all when not playing / when the game canvas isn't focused). Note
  the breadth: every mapped code (arrows, Enter, WASD…) gets window-level
  preventDefault at all times in any project.

### HIER-2 · friction · high
- Element: tree rows — drag-to-reparent / sibling reorder
- Observed: Rows are not draggable (`draggable` attr absent; a real mouse drag
  from "Hint" onto "Player" is a no-op — depth stays 0, no drop indicator, no
  error). There is no way to reparent or reorder from the Hierarchy at all.
  The only reparent path in the whole editor is the Inspector's "Parent"
  dropdown (one entity at a time, buried below Name/Enabled/Tags).
- Expected: Drag-to-reparent is table stakes for a scene hierarchy (Unity,
  Godot, Unreal all have it). The engine already supports everything needed —
  `moveEntity` takes a `parent` param with a cycle guard and a documented
  prefab-instance detach policy (`packages/core/src/commands/entityCommands.ts`
  lines 246-299) — so this is purely a missing UI affordance. Because the
  feature is absent, none of the prefab-instance reparent edge cases
  (reparent inside/outside an instance, no-op reparent) are exercisable from
  this surface; they ride on the same engine command the Inspector uses.

### HIER-3 · friction · med
- Element: Delete/Backspace keybind vs. row trash button
- Observed: Selecting a row and pressing Delete (or Backspace) deletes the
  entity instantly — no confirm dialog (row count 16→15 immediately). The
  trash button on the same row opens a ConfirmDialog whose whole purpose is to
  warn that children get re-parented one level up.
  (`keybinds.ts` line 129 → `store.deleteSelection()` → bare `deleteEntity`.)
- Expected: One deletion contract. Either both paths confirm, or neither does
  (undo makes no-confirm defensible — but then the dialog on the mouse path is
  pure friction, and the keyboard path silently restructures children that the
  dialog explicitly warns about).

### HIER-4 · defect · med
- Element: rename flow (inline input)
- Observed: Renaming "Hint" to "Player" is accepted — the scene ends up with
  two rows named "Player" (screenshot h-04). `renameEntity` has no uniqueness
  check (`entityCommands.ts` lines 124-141), while every create path in this
  panel (`New entity`, empty-state button, duplicate) carefully generates
  unique names via `uniqueName()`.
- Expected: Consistent invariant. Engine commands accept entities "by id or
  name", so duplicate names make name-based references ambiguous. Either
  reject/auto-suffix duplicate renames, or stop pretending uniqueness matters
  in the create paths.

### HIER-5 · friction · med
- Element: tree keyboard navigation
- Observed: `role="tree"`/`role="treeitem"` is declared, but none of the ARIA
  tree keyboard contract exists: ArrowUp/Down do not move focus or selection,
  ArrowLeft/Right do not collapse/expand, F2 does not rename, Home/End do
  nothing. Every row is `tabIndex={0}` and a selected row exposes 4 more
  tab stops (its action buttons), so tabbing through a 15-entity scene takes
  ~19 stops; a real scene would be worse. Enter/Space do select (works).
- Expected: Roving tabindex with arrow-key navigation (one tab stop for the
  whole tree), ArrowLeft/Right for collapse/expand, F2 rename. As-is the
  keyboard story is "Tab forever".

### HIER-6 · friction · med
- Element: row selection — multi-select
- Observed: No multi-select. Meta+click and Shift+click simply replace the
  selection (verified: after Player selected, Shift+click Hint → only Hint
  selected). Store `selection` is a single id.
- Expected: Shift/Cmd range- and toggle-select for bulk delete/duplicate/
  (eventually) reparent. Every peer editor has it; its absence multiplies the
  cost of HIER-2 and HIER-3.

### HIER-7 · friction · med
- Element: "Save as prefab" inline input — failure feedback
- Observed: Saving "Hint" as a prefab named "Enemy" (slug collides with the
  existing `assets/prefabs/enemy.prefab.json`) fails with CONFLICT. At the
  point of interaction nothing happens: the inline input closes, no badge
  appears, no toast, no inline error. The only signal is a small red "1"
  badge on the Console tab at the bottom of the screen (screenshot h-14) —
  which can be on a hidden/unfocused tab.
- Expected: Failed action feedback at the point of use — keep the input open
  with an inline error ("A prefab named Enemy already exists"), or a toast.
  A silent close reads as success.

### HIER-8 · defect · med
- Element: "Save as prefab" button on rows that are already prefab instances
- Observed: The button renders identically on instance rows (Enemy / Elite
  Enemy). Code-verified consequence: `createPrefab` unconditionally overwrites
  `root.prefab = { asset: <new>, ids: {}, overrides: [] }`
  (`packages/core/src/commands/prefabCommands.ts` line ~223), so saving an
  existing instance as a prefab silently re-links it to the NEW asset and
  discards its membership/overrides against the original prefab — with no
  warning that this breaks the live link shown by the row's badge.
- Expected: Either differentiate the affordance on instance rows (e.g. "Save
  as new prefab — this detaches the instance") or confirm before re-linking.

### HIER-9 · friction · low
- Element: panel — search/filter
- Observed: None. Fine at ember-horde's 15 entities; a real scene with dozens
  to hundreds of entities has no way to find anything except scrolling.
- Expected: A filter box (or at least Cmd+F scoping) in the panel header.

### HIER-10 · friction · low
- Element: tree rows — context menu
- Observed: Right-click on a row shows nothing custom (0 popovers). All row
  operations live only in the hover icon cluster.
- Expected: Right-click menu mirroring the row actions (+ future reparent /
  "select children" verbs). It's deep muscle memory from every peer tool; the
  hover icons partly compensate, so low.

### HIER-11 · polish · low
- Element: `.tree-name` native `title` tooltip
- Observed: Hovering any entity name shows the raw internal id
  (`ent_7ltyzbrz`) as a native tooltip (`title={entity.id}` in Hierarchy.tsx
  line 163).
- Expected: Ids are an agent/CLI concern; for a hover tooltip the full
  (possibly truncated) name is more useful, with the id available in the
  Inspector header (where it already appears).

### HIER-12 · polish · low
- Element: tree ARIA semantics
- Observed: `treeitem` rows never expose `aria-expanded`, `aria-level`,
  `aria-posinset`/`aria-setsize`; nesting is conveyed purely by CSS indent.
  (Caret buttons do have proper Expand/Collapse labels.)
- Expected: The structural attributes, so assistive tech can report depth and
  expanded state. Pairs with HIER-5.

### HIER-13 · polish · low
- Element: Delete confirm dialog — initial focus
- Observed: The code puts `autoFocus` on the confirm button (`ui.tsx` line
  335), but focus actually lands on "Cancel": Modal renders children while the
  dialog is still closed, then calls `showModal()` in an effect, so React's
  autoFocus fires on an unfocusable element and the browser's showModal focus
  (first focusable = Cancel) wins.
- Expected: The accidental outcome (Cancel focused) is arguably the safer
  default for a destructive dialog — but it should be intentional, not a race.
  Decide which button owns focus and wire it so it actually happens.

### HIER-14 · polish · low
- Element: `.tree-actions` hidden-until-hover idiom
- Observed: Row actions hide with `display: none` (styles.css 870-877), which
  removes them from the tab order entirely for unselected rows. The Inspector's
  equivalent (`.field-revert-btn`, styles.css ~1137) deliberately uses opacity
  "so it stays tab-reachable rather than display:none" — the two panels
  disagree on the idiom.
- Expected: One idiom. (Tree actions are reachable after selecting the row, so
  this is consistency, not a blocker.)

### HIER-15 · friction · low
- Element: tree contents during play mode
- Observed: During play the Hierarchy keeps showing only the 15 design-time
  entities while the game visibly runs 130+ spawned enemies (screenshot h-09).
  Nothing in the panel says "this is the edit-time document, see the Live
  panel for runtime state".
- Expected: Fine as a design decision (doc-vs-runtime split, Live panel
  exists), but a first-time user watching a horde on screen and 15 rows in the
  "Hierarchy" gets no hint why. A subtle play-mode header hint would close the
  gap.

## Verified working

- Open project via launcher path + "Open" (after the known dockview
  "All panels are closed" toggle-repair — pre-existing cross-surface bug, not
  counted against this surface).
- Panel header shows "Hierarchy · <scene name>" and updates on scene switch
  ("Hierarchy · EmptyTest").
- Tree renders all 16 entities with correct nesting (Pause Menu's 4 children
  at depth 1, indent guides aligned under carets).
- Entity-type glyphs differentiate camera / sprite / script-only / text rows
  (Main Camera, Backdrop/Player/Enemy, Director/Screen Shake, HUD/labels).
- Caret expand/collapse: collapse hides the subtree (16→12 rows), re-expand
  restores; chevron rotates via `.open`; caret has proper aria-label
  (Expand/Collapse); leaf rows render a spacer so names align.
- Collapse state survives selection changes and undo/redo (stayed collapsed
  through select + undo + redo).
- Click-to-select highlights row, syncs Inspector; `aria-selected` tracks.
- Enter and Space on a focused row select it (isActivationKey path).
- Double-click opens inline rename prefilled with the current name; Enter
  commits (row + scene update); Escape cancels; blur commits; empty-string
  rename is a no-op (name kept).
- Pencil (Rename) hover action opens the same inline rename.
- Duplicate on a parent row clones the whole subtree ("Pause Menu copy" with
  all 4 children, fresh ids), selects the copy, and undo removes the whole
  copy in ONE step.
- Duplicate on a prefab instance (Enemy) produces "Enemy copy" that keeps the
  prefab badge.
- Save as prefab (happy path): inline input prefilled with entity name,
  placeholder "Prefab name"; Enter creates the asset and the row immediately
  gains a prefab badge titled "Instance of HintPrefab"; undo reverts the badge.
- Prefab badges render on Enemy / Elite Enemy with title "Instance of Enemy"
  (asset name resolved, not raw id); badge turns accent-colored when selected.
- Delete via trash: ConfirmDialog with correct title ("Delete “Pause Menu”?"),
  honest body copy (children re-parent one level up; undo hint), Cancel keeps
  the entity, confirm deletes and children really do move to scene root; undo
  restores the entity WITH its children re-nested — all one step.
- Delete/Backspace keybind deletes the current selection (see HIER-3 for the
  missing confirm).
- Header "+" (New entity): creates root entity, selects it, unique names
  ("Entity", "Entity 2"); disabled state wired to missing scene; two undos
  remove both.
- Empty-scene state: icon + "This scene is empty." + "Add an entity" button;
  button creates and selects an entity; undo returns to the empty state.
  Header "+" stays enabled in an empty scene.
- Play mode: tree stays stable and in sync (15 rows before/during/after);
  selection works during play; rename during play commits and correctly
  raises the "Scene changed — Restart" toolbar banner; undo during play works;
  tree identical after Stop.
- Undo/redo sync exercised across rename (undo + redo), duplicate, delete
  (children re-nesting), create, and empty-state create — tree always
  re-rendered correctly.
- Long names truncate with ellipsis inside the row; hover actions still fit.
- Disabled-entity styling path exists (`.disabled-entity` dims name+icon) —
  code-verified; no disabled entity in this scene (toggle lives in Inspector).
- Row hover reveals the 4 actions; selected rows keep them visible; danger
  styling on the trash button.

## Not covered

- "No scene selected." empty-state variant — requires a project state with no
  scene selected, not reachable in this example.
- Drag-to-reparent prefab-instance edge cases (inside/outside instance, no-op
  reparent) — the feature does not exist in this surface (HIER-2); the engine
  policy lives in `moveEntity` and is only reachable via the Inspector's
  Parent dropdown (Inspector surface).
- Multi-select behaviors — no multi-select exists (HIER-6).
- Search/filter and context menu — absent (HIER-9/10).
- Deep-nesting / hundreds-of-entities scalability and scroll performance —
  example scene is 16 entities.
- `disabled-entity` visual verified in code/CSS only; enabling/disabling is an
  Inspector control.
- Escape-close of the confirm dialog in a project that does NOT map Escape —
  inferred fine from the control test + code, but not exercised end-to-end
  (would need a second example project).
