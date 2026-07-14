# Audit: inspector-core  (example: ember-horde, port 5214)

Surface: `apps/editor/src/components/Inspector.tsx` (generic parts — entity
header, add/remove component, generic field editors, Script editor). Driven
headlessly with playwright-core (system Chrome channel) against a scratch
copy of ember-horde at `/private/tmp/waveL-audit-inspector-core`.

## Findings

### INSPECTOR-1 · defect · high
- Element: `NumberField` (`apps/editor/src/components/ui.tsx`) — any numeric
  field, e.g. Transform → Position X.
- Observed: Select all text in a number input and delete it (or type
  non-numeric characters, which the browser's `type="number"` filtering
  reduces to an empty string), then blur. The field commits **`0`**, silently
  overwriting the previous value. Repro: select Player, click Position X,
  Cmd/Ctrl+A, Delete, Tab away → field shows `0` and the entity actually
  moves. Root cause: `commit()` does `Number(draft)`; `Number('')` is `0`,
  which passes the `Number.isFinite` guard, so the "invalid input reverts"
  path never triggers for the empty-string case.
- Expected: An empty or non-numeric draft should revert to the field's last
  committed value (matching the code's own comment "commit on blur/Enter...
  invalid input Escape-revert" intent), not silently commit `0`. This can
  silently corrupt Position, Scale, Rotation, Mass, Width/Height, etc. with a
  single accidental select-all+Delete.

### INSPECTOR-2 · defect · high
- Element: `ColorField` (`apps/editor/src/components/ui.tsx`) — the hex text
  input beside the native color swatch, e.g. SpriteRenderer → Color.
- Observed: Typing an invalid hex string (e.g. `notacolor`) into the text
  sub-input and blurring leaves the input showing `notacolor` indefinitely.
  The commit is rejected server-side (core's `hexColor` zod regex — see
  `packages/core/src/schema/components.ts:20`) via a `quiet: true` exec call,
  so there is no console/toast feedback and the local `draft` state is never
  resynced, because the `useEffect(() => setDraft(value), [value])` only
  re-fires when the upstream value prop actually changes — it doesn't when a
  write is rejected. The row keeps displaying the invalid text as if it were
  live until the entity is deselected and reselected (forcing a remount),
  at which point it silently snaps back to the real value (`#ffffff` in the
  repro) with no visible indication anything was rejected.
- Expected: Either validate the hex format client-side and reject/mark it
  invalid inline (as `TileCharField` does, with a `.field-error` message), or
  at minimum resync `draft` when a commit is rejected so the field doesn't
  show a phantom value the entity was never actually set to.

### INSPECTOR-3 · friction · med
- Element: Component card remove button (the `×` `icon-btn danger` in every
  `.component-header`, incl. Transform).
- Observed: Every component, including `Transform`, gets the same generic
  "Remove {Type}?" confirm dialog ("The {Type} component and its settings are
  removed from '{entity}'."). Removing Transform is allowed by the backend
  (`packages/core/src/commands/componentCommands.ts:87` even emits its own
  `ctx.warn('REMOVED_TRANSFORM', 'Removing Transform: the entity will not be
  positioned or rendered.')`), but that warning never reaches this
  confirmation — the dialog body is identical to removing e.g. AudioSource.
- Expected: A structurally special component (there is exactly one: every
  entity has a Transform) should carry a stronger warning in its own confirm
  copy — "this entity will no longer be positioned or rendered" — mirroring
  what the command layer already knows, instead of the same boilerplate used
  for optional components.

### INSPECTOR-4 · friction · med
- Element: Component cards (`.component-card` in `Inspector.tsx`).
- Observed: There is no collapse/expand affordance anywhere on a component
  card — confirmed by reading `styles.css` (no `.component-card` collapsed
  state) and `Inspector.tsx` (component bodies always render in full). The
  only collapsible element in the whole file is the per-row "Advanced
  mapping" `<details>` inside `AutotileRuleFields`. An entity with several
  components (Player in ember-horde: Transform, SpriteRenderer, Collider,
  PhysicsBody, ParticleEmitter, Script — ~40 field rows) has no way to fold
  a card the user isn't currently working on; scanning/scrolling is the only
  option every time.
- Expected: Per-card collapse (chevron next to the remove button, state
  persisted at least per session) so a long entity doesn't force a full
  scroll past components the user isn't touching.

### INSPECTOR-5 · friction · med
- Element: `Script` component fields — `Script Path` and `Params`.
- Observed: `Script Path` (`scriptPath: string`) falls through to a plain
  `TextField` — a raw text box for a project-relative path with no picker,
  no autocomplete against `scripts/*.lua`/`.js`, and no "open in Code" jump
  to the file. `Params` (`params: Record<string, unknown>`) matches no typed
  branch and renders via `UnsupportedField`: a read-only
  `JSON.stringify(value)` dump plus the note "No typed control for this
  field yet — shown read-only. Edit it through your agent or the hearth
  CLI." Confirmed live: Player's Script shows
  `{"speed":170,"maxHp":100,"contactDamage":8,"hitCooldown":0.4}` completely
  uneditable from the Inspector; the dev console logs
  `Inspector: "Script.params" has no typed control and is showing
  read-only. Add a branch for it instead of falling back to raw JSON.`
  every time a Script-bearing entity is selected.
- Expected: This is the single biggest gap in "every field gets a real
  control" for a project that ships Lua scripts driving gameplay via
  `ctx.params` — script parameters (speed, HP, cooldowns, etc., i.e. exactly
  the tunable numbers a non-engineer would want to tweak from the Inspector)
  are currently only reachable by hand-editing JSON outside the editor. At
  minimum `scriptPath` deserves a dropdown/picker over existing scripts, and
  `params` needs a key/value editor (string/number/boolean rows) instead of
  a permanent read-only escape hatch.

### INSPECTOR-6 · polish · low
- Element: Known dockview "All panels are closed" bug (mentioned in
  AUDITOR-COMMON as a known issue, reproduced here for the record).
- Observed: A fresh load or reload of an already-open project reliably shows
  "All panels are closed / Reopen them from the View menu in the toolbar."
  in Hierarchy, Inspector, and the bottom dock, even though the tabs
  (Hierarchy, Scene, Inspector, Assets, etc.) are visibly present and
  checked in the View menu. Toggling each panel off/on via View fixes it.
- Expected: Documented as a known issue outside this surface's fix scope,
  but noting it here since it directly blocks first contact with the
  Inspector on every fresh page load — a first-run user with no knowledge
  of the workaround would see the Inspector as permanently broken.

## Verified working

- Entity header: Name (`TextField`) commits on blur/Enter, reverts on
  Escape, restores correctly.
- Entity header: Enabled checkbox toggles and reflects state immediately.
- Entity header: Tags field present (comma-separated `TextField`, parsed to
  a tag array on commit).
- Entity header: Parent dropdown lists every other entity in the scene by
  name plus "(scene root)".
- Add-component flow: dropdown lists exactly the component types not
  already on the entity (verified full list of 13 remaining types for
  Player: Camera, Text, AudioSource, Tilemap, Light2D, LineRenderer,
  SpriteAnimator, AnimationStateMachine, SpriteEffects, UIElement, UILayout,
  UISlider, UIToggle); selecting one adds it immediately with defaults, and
  it disappears from the add list once added ("All component types added"
  when exhausted).
- Remove-component flow: `×` opens a confirm dialog ("Remove {Type}? The
  {Type} component and its settings are removed from '{entity}'."); Cancel
  leaves the component intact; confirming removes it.
- `NumberField`: commit-on-blur works, commit-on-Enter works, Escape
  reverts to the last committed value, non-empty invalid text reverting
  behaves per the empty-string caveat in INSPECTOR-1. No drag-to-scrub
  gesture exists (confirmed: plain `<input type="number">`, mousedown+drag
  across the field does not change its value) — not a defect, just an
  absent affordance.
- `TextField`: commit-on-blur, commit-on-Enter, Escape-revert all correct
  (Name field, tested both directions).
- `ColorField`: swatch (native `<input type=color>`) commits immediately on
  pick; text sub-input's commit-on-blur/Enter/Escape-revert path works for
  *valid* hex input — only breaks on invalid input (INSPECTOR-2).
- `Vec2Field` (Position, Scale): paired X/Y NumberFields, both commit
  independently.
- `Vec2ListField` (Collider polygon Points, tested after switching Collider
  Shape to `polygon`): "Add point" appends a `{0,0}` row; per-row remove
  works; editing a point's X/Y commits correctly; the floor (`min=3` for
  Collider) correctly disables every remove button once at 3 points, with a
  title of "Needs at least 3 points" on the disabled buttons.
- `StringListField` (Collider Collides With): "Add layer" appends an empty
  row; typing a value and committing works; per-row remove works and
  updates the list immediately.
- Enum dropdowns: Collider Shape (box/circle/polygon), PhysicsBody Body Type
  (dynamic/static/kinematic) — both switch cleanly and re-render
  shape-dependent fields (Points row appears/disappears with Shape).
- Checkbox fields: Enabled, Is Trigger, Flip X/Y, Emitting all toggle and
  reflect state immediately.
- Asset picker fields: SpriteRenderer `Asset Id` lists sprite+tile assets
  with a `(type)` suffix per option and a `(none: draw primitive)` empty
  option; switching assets commits immediately.
  AnimationStateMachine `assetId` renders the asset dropdown plus an "Edit"
  button that is correctly disabled (with an explanatory title) until an
  asset is assigned.
- `Text.fontFamily` (`FontFamilyField`): dropdown lists generic CSS families
  plus a "Custom…" option; selecting Custom reveals a free-text field (no
  project font assets existed in this project, so the "Project fonts"
  optgroup was correctly omitted rather than shown empty).
- `UIElement.anchor` (`AnchorGrid`): renders as a 3×3 radio-group grid
  (`role="radiogroup"`, 9 `role="radio"` cells); clicking a cell selects it;
  clicking the already-selected cell is a correct no-op.
- Multi-entity selection: none exists. Shift-click and Cmd-click on
  different Hierarchy rows both simply move the single selection to the
  last-clicked entity (confirmed via `store.ts`'s `selection: string | null`
  — there is no selection set anywhere in the app). The Inspector always
  shows exactly one entity; there is no batch-edit surface to audit.
- Field-level undo granularity: editing Position X then Position Y (two
  separate commits on the same Vec2 row) produces two independent undo
  steps — one Undo reverts only Y, a second Undo reverts X — confirming
  "one edit = one undo step" holds even within a single visual row/field.
  Redo restores both correctly in order.
- Keyboard-only operation: focusing the Name field and tabbing through
  Enabled → Tags → Parent → (Transform's remove button) → Position X →
  Position Y all reachable via Tab in the expected visual order; editing
  via keyboard alone (type + Enter) commits correctly without ever touching
  the mouse.
- Script component: `Script Path` renders and is editable as a plain
  TextField (commit/revert behavior identical to any other TextField); the
  component icon, header, and remove button behave like every other
  component card.

## Not covered

- `PostEffectsField` (Camera.postEffects stack editor) and `TileAssetsField`
  (Tilemap.tileAssets row editor) were not exercised — these are dedicated
  specialized field editors with their own files
  (`PostEffectsField.tsx`, logic in `tileAutotileRows.ts`) and more plausibly
  belong to a dedicated camera-effects/tilemap surface than "generic
  inspector parts"; flagging so another wave pass can claim them if not
  already covered.
- Prefab override affordances (the ember "overridden" dot, per-field
  Revert, "Revert all"/"Update prefab"/"Sync instances" banner) were not
  exercised — the scratch scene's entities aren't prefab instances, and this
  is squarely prefab-workflow behavior rather than a generic field editor;
  left for a prefabs-focused surface.
- Did not test the exact interaction of Undo/Redo with the add-component /
  remove-component / delete-entity structural operations (only tested undo
  granularity on a plain field edit) — worth a follow-up if a structural-ops
  surface doesn't already cover it.
- A `[pageerror] Cannot read properties of null (reading 'clear')` appeared
  intermittently in the browser console during these runs. It did not
  correlate with any visible Inspector misbehavior in this session and looks
  Scene-view/canvas related (ember-horde's arena has active
  particles/physics), so it's noted but left to the sceneview surface rather
  than chased down here.
