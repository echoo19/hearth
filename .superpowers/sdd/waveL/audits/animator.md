# Audit: animator (example: sky-courier, port 5224)

Surface: `apps/editor/src/components/AnimatorEditor.tsx` + its pure edit-logic
module `apps/editor/src/asmEdit.ts`. Driven headless (playwright-core, system
Chrome, 1500×950) against a scratch copy at `/private/tmp/waveL-audit-animator`,
editing `assets/statemachines/courier_motion.asm.json` (`courier-motion`: 1
bool param `moving`, 2 states `idle`/`walk`, 2 transitions), opened both via
the Assets card's "Edit state machine" button and via the Inspector's
`AnimationStateMachine` row.

Environment note: this machine ran ~17 concurrent wave-L auditors for most of
the session (visible via other auditors' scratch projects in the launcher's
Recent list and other drivers' processes), which made every interaction slow
and occasionally flaky (CPU load average 10–23, near-zero free memory at
points), and — independently confirmed via the vite dev-server log — the
`apps/editor/src` tree was being actively hot-patched by another process
partway through this session (a broad wave of HMR updates touching ~25 files
including `AnimatorEditor.tsx` itself, migrating several buttons to a shared
`Button` primitive; my own dev server was found dead with
`ERR_CONNECTION_REFUSED` at one point and had to be restarted). I re-diffed
`AnimatorEditor.tsx`/`asmEdit.ts` against the current on-disk source before
writing this report: the only change was a cosmetic `Button` component
migration for the Save/Add/Condition buttons — every finding below was
re-verified against the code as it stands now, and the external-edit test
(ANIMATOR-8) was re-run to a clean, uncontaminated completion after the
restart.

## Findings

### ANIMATOR-1 · defect · high
- Element: Parameter type `<select>` (Parameters row) interacting with an
  existing Condition row that references that parameter
- Observed: Repro — add a `number` param (`spd`); add a transition; add a
  condition on `spd`; set its operator to `>` and value to `5`. Now change
  `spd`'s type from `number` to `bool`. The condition row silently re-renders
  as `spd = false` (a *misleading* display — the underlying draft still holds
  `op: 'gt', value: 5`, and the "false" is just `c.value === true` evaluating
  false against the stale number `5`; the "=" is the browser's fallback
  selection when `<select value="gt">` has no matching `<option>`, since
  `opsForParamType('bool')` only offers eq/neq). No warning appears anywhere:
  `draftIssues()` reports zero issues, the "Unsaved" Save button stays
  enabled, `title="Save this state machine"`. Clicking Save fails with a raw
  server-side message dumped verbatim into the UI: `Invalid parameters for
  updateStateMachineAsset: data.transitions.2.conditions.0.op: bool param
  "spd" conditions only support eq/neq`.
- Root cause: `setParamType` (`asmEdit.ts:176`) rewrites only the param's own
  `default`; it never revisits transitions/conditions that reference that
  param. `draftIssues()` (`asmEdit.ts:343`) only checks "op is defined" /
  "value is defined" — never "op is valid for the referenced param's *current*
  type" — even though the exact same cross-check exists server-side in
  `StateMachineDataSchema`'s `superRefine` (`packages/core/src/schema/
  project.ts:273`: `paramType === 'bool' && condition.op !== 'eq' && op !==
  'neq'`). The client gate and the server schema have drifted apart.
  Corroborating evidence: `setParamType`, `setConditionOp`, and
  `setConditionValue` have **zero** test coverage in
  `apps/editor/tests/asmEdit.test.ts`, despite the module's own header
  claiming to be "pure, unit-tested" — the one other stale-value case the
  suite does cover (a trigger condition retaining op/value) passes only
  because `draftToDoc` strips it at serialize time, which doesn't happen for
  the bool/number mismatch case.
- Expected: Either `setParamType` clears/reseeds every dependent condition's
  op+value when the type changes (mirroring what `setConditionParam` already
  does when you repoint a condition at a different param), or `draftIssues()`
  performs the same op-vs-current-type check the server does, so an invalid
  combination is caught and named *before* Save — not after, via an
  agent-facing schema string a human end-user has no way to map back to "the
  3rd transition's 1st condition."

### ANIMATOR-2 · friction · high
- Element: "Machine" `<select>` (top toolbar), switched while the current
  machine's draft is dirty
- Observed (code-verified — sky-courier ships only one `stateMachine` asset,
  so a second option wasn't available to switch to live): the select's
  `onChange` is `setAssetId(e.target.value)` only. The load effect
  (`AnimatorEditor.tsx:106`) keys off `loadedIdRef.current === asset.id`; the
  moment `assetId` changes, `loadedIdRef` no longer matches, so it happily
  loads a fresh draft for the new asset and overwrites `draft` in React state
  — with **no dirty check, no confirmation dialog, nothing** standing between
  the user and silently discarding whatever unsaved params/states/transitions
  edits they'd made on the previous machine. The codebase already has a
  `ConfirmDialog` primitive built for exactly this class of destructive
  action (used elsewhere in this same file's sibling, `AssetsPanel.tsx`, for
  "Sync instances?" / "Revert all overrides?"), so this isn't a missing
  primitive, just an unguarded path.
- Expected: If `dirty` is true, confirm before switching (or before honoring
  an `animatorTarget` change to a different asset), the same way prefab
  sync/revert already protects against silent data loss.

### ANIMATOR-3 · friction · high
- Element: Assets panel toolbar (`+ Sprite`, `+ Tile`, `Import…`) and the
  Animator's own empty state
- Observed: There is no in-editor way to create a state-machine (or
  animation) asset. The Assets panel's create affordances only cover sprite
  and tile (`createSpriteAsset`/`createTileAsset`, wired to `+ Sprite`/`+
  Tile`); `createStateMachineAsset` exists as a command but the only place it
  is mentioned in the entire `apps/editor/src` tree is the Animator's own
  empty-state copy: *"Ask an agent to create one, or use the CLI's
  createStateMachineAsset command — then edit its params, states, and
  transitions here."* For the one editor whose entire purpose is authoring
  state machines, a human user cannot originate the asset it edits without
  leaving the editor for a terminal or an agent.
- Expected: A "+ State machine" affordance in the Assets panel (parallel to
  Sprite/Tile), so the Animator's empty state can be resolved with one click
  from the same product surface that has it, instead of pointing outward at
  the CLI every time.

### ANIMATOR-4 · defect · high
- Element: global `mod+s` keybind while editing in the Animator
- Observed: Every other panel in this editor autosaves continuously ("Every
  change saves automatically" is literally printed in the toolbar), and the
  global `mod+s` binding (`keybinds.ts:66-77`) reflects that: `when: 'always'`,
  `run: (s) => s.log('info', 'editor', 'Your changes are saved automatically —
  no need to save.')`. The Animator is the deliberate exception — its own file
  header says "a Save commits ONE `updateStateMachineAsset` (a single undo
  entry)" and it ships a real gated Save button + "Unsaved" pill specifically
  *because* it doesn't autosave. But there is no Animator-specific override
  for `mod+s`, so a user who edits params/states/transitions and reflexively
  hits Cmd+S/Ctrl+S gets a console message flatly telling them their changes
  are already saved, while the actual Animator draft sits untouched, still
  gated behind the visible Save button.
- Expected: `mod+s` should trigger the Animator's own `save()` when it has
  focus/is the active panel (same pattern the Code panel already uses to
  claim `mod+s` for its own real save — the keybind's own comment references
  that precedent), or at minimum the log message should not claim "no need to
  save" while an Unsaved pill is visibly on screen.

### ANIMATOR-5 · friction / design (direct-manipulation) · high
- Element: Transitions list as a whole
- Observed: `packages/runtime/src/stateMachine.ts:11-14` documents the actual
  runtime semantics: *"explicit `from: current` transitions are considered
  before `from: 'any'`, first eligible in declaration order wins."* Order is
  load-bearing — two transitions that both fire from `idle` with overlapping
  conditions resolve by array position. Live repro: after adding a param,
  transition, and condition in my session, the Transitions list held (in
  order) `idle→walk`, `walk→idle`, `idle→idle` — an "idle" source state
  appearing in position 1 and 3 with an unrelated card in between. There is
  no card numbering, no per-source grouping/collapsing, and — confirmed via
  `asmEdit.ts` — no reorder function at all (`addTransition` only appends;
  there's no `moveTransition`/drag handle anywhere in the component). The
  only way to change priority is delete-and-re-add, which always re-appends
  at the end, so you can never move a transition earlier than "last."
  Reconstructing "which transitions leave idle, and in what priority" means
  reading every card's left-hand dropdown by eye, in a machine with more than
  a handful of transitions this stops being tractable as a flat list.
- Expected: At minimum, group/sort cards by source state with a visible
  section per state (turning "declaration order" into "visible order"), and
  add reorder (drag handle or move-up/down) so priority is an intentional,
  visible act instead of an accident of insertion history. This is the core
  gap between "list stands in for a graph" and an actual graph/node view
  (which would make outgoing edges from a selected state immediately
  obvious) — worth flagging explicitly against the direct-manipulation bar
  even short of a full graph editor.

### ANIMATOR-6 · polish · low-med
- Element: every `<select>` in the file except the top "Machine" picker
- Observed: 8 `<select>` elements exist in `AnimatorEditor.tsx`; only the
  "Machine" picker has a real accessible name (a `<label className=
  "field-label" htmlFor="animator-asset">`). The other 7 — param type,
  state→animation, transition `from`, transition `to`, condition `param`,
  condition `op`, condition bool `value` — have no `aria-label`, no
  `aria-labelledby`, and not even a `title` fallback. A screen reader
  announces each as a bare, indistinguishable "combobox." This is worse than
  the icon-only buttons in the same file, which at least fall back to
  `title`.
- Expected: `aria-label` on each (e.g. `aria-label="Transition source
  state"`, `"Condition operator"`) — cheap, and this is exactly the "known
  gap" the audit dispatch called out.

### ANIMATOR-7 · polish · low
- Element: icon-only remove buttons (param/state/transition/condition rows)
  and the initial-state star toggle
- Observed: All rely solely on the native `title` attribute for a
  hover/focus label (`<button className="icon-btn danger" title="Remove …">`
  wrapping an `aria-hidden` `Icon` svg — confirmed the `Icon` component always
  sets `aria-hidden="true"`, so `title` is the *only* accessible-name source).
  The codebase already ships a purpose-built `IconButton` (`components/ui/
  Button.tsx`) whose own doc comment states the exact problem: *"an icon-only
  control needs a discoverable label whether or not it's hovered, so `label`
  is required and doubles as both the `aria-label` and the tooltip content."*
  AnimatorEditor doesn't use it. (Caveat: adoption of `IconButton` is rare
  app-wide — only one other file, `SearchAcross.tsx`, uses it as of this
  session — so this reads more as an unfinished migration than an
  Animator-specific regression; noting it here since it's squarely in this
  audit's brief.)
- Expected: Swap the four `icon-btn danger` remove buttons and the
  `animator-initial` star button over to `IconButton`, picking up a real
  tooltip + `aria-label` for free.

### ANIMATOR-8 · defect · high
- Element: the whole "Save" flow vs. a concurrent external edit to the same
  `.asm.json` file
- Observed: Live repro, per the dispatch's instruction to edit the file on
  disk while the Animator stays open. With `courier-motion` open (idle speed
  = 1, nothing dirty), I edited the on-disk `courier_motion.asm.json`
  directly, setting `idle.speed = 9.9`, and waited 4s. The still-open
  Animator kept showing speed `1` (confirmed via the input's value) and
  correctly did *not* mark itself dirty from the external change — so far
  so good, no data was silently pulled in mid-edit. I then made one small
  in-editor edit (toggled the `moving` param's default), which correctly
  showed "Unsaved." Clicking Save: the dirty pill cleared as expected, but
  the on-disk result was `idle.speed: 1` — the external `9.9` was gone,
  overwritten by the editor's stale in-memory draft. The only thing that
  actually landed was my one deliberate edit (`moving.default: true`); the
  external speed change was silently destroyed with zero detection, warning,
  merge, or even a log line.
- Root cause: the load effect's guard (`AnimatorEditor.tsx:112`, `if
  (loadedIdRef.current === asset.id) return;`) means the draft is loaded
  from disk exactly once per "open" (per `animatorTarget` nonce) and never
  refreshed for the rest of that session, even though the underlying
  `assets` array *does* pick up the file-watcher's re-parsed doc in the
  background (that's precisely what the guard exists to ignore, per its own
  comment: "Guards the load effect from clobbering in-progress edits when an
  unrelated refresh ... hands us a new `assets` array"). That guard is
  correct for the common case (protecting your own edits from an unrelated
  background refresh) but has no fallback for the case where the file
  genuinely changed on disk out from under you — `save()` always writes
  `savePayload(asset.id, draft)`, i.e. the full draft computed from the
  *original* load, blowing away every field the external process touched
  that this session's draft doesn't know about.
- Expected: At minimum, detect that the on-disk doc has changed since load
  (the `assets` array already carries the fresh parse) and surface a
  "this file changed on disk — reload / overwrite anyway?" choice before
  Save proceeds, rather than a silent last-write-wins. This matters
  concretely for Hearth's stated model of humans and agents editing the same
  project concurrently — an agent-driven CLI edit to a state machine while a
  human happens to have it open in the Animator is a completely ordinary
  scenario, not an edge case.

### ANIMATOR-9 · polish · low
- Element: state row's speed control vs. its own remove button
- Observed: Each state row ends in `× [1] ×` — the first "×" is a static
  label (`animator-speed-label`, meaning "times") glued to the speed
  NumberField, the second "×" is the row's delete `Icon name="cross"`
  button. Same glyph, same size class, same faint ink color, sitting right
  next to each other at the end of a dense row (see any States-section
  screenshot). It reads as one control group at a glance; a user reaching to
  delete a row could plausibly misclick the wrong one, or vice versa.
- Expected: Differentiate the multiplier label from the delete affordance —
  a lower-contrast/smaller glyph for "×" (times), or moving the delete
  button further right with a visible separator, would be enough.

## Verified working

- Both documented entry points open the Animator: the Assets card's "Edit
  state machine" button (exercised live end-to-end: selects the card, opens
  a new "Animator" dockview tab pre-loaded with `courier-motion`'s full
  params/states/transitions) and the Inspector's `AnimationStateMachine.
  assetId` row's "Edit" button (`Inspector.tsx:959-966`) — both dispatch the
  identical `openAnimatorFor(assetId)` store action (`store.ts:788`), which
  the Animator picks up via `animatorTarget`'s `nonce` (forces a fresh reload
  even for the same asset). The Inspector-side asset-pick + Edit button
  mechanics were independently confirmed working in `inspector-specialized.md`
  (correctly disabled with "Assign a state machine to edit it" when nothing
  is assigned); I additionally confirmed live that Hierarchy → select
  "Courier" → Inspector shows the `AnimationStateMachine` component with a
  real `courier-motion` selection and an enabled Edit button, though the
  final click-through to the Animator tab wasn't captured in a stable
  screenshot due to session flakiness (see Not covered).
- Parameters: "+ Add" appends a uniquely-named `bool` param (verified row
  count going 1→2); rename commits via the shared `TextField` (blur/Enter);
  the type `<select>` correctly switches the default control per type — a
  checkbox for `bool`, a `NumberField` for `number`, a static "fires once"
  note for `trigger` (no stray default control shown); delete removes the
  row.
- States: "+ Add" appends a uniquely-named state and (per `asmEdit.ts`'s
  `addState`) auto-promotes it to `initial` when it's the first state; the
  star toggle sets a state as initial (`aria-pressed` tracked, disabled for
  an unnamed row); the animation `<select>` lists only `animation`-typed
  assets, correctly excluding sprites/audio/etc.; the ×-speed `NumberField`
  edits playback speed; delete removes the row and (per `removeState`)
  cascades to drop any transition referencing it.
- Transitions: "+ Add" is disabled with an explanatory title ("Add a state
  first") when there are no states yet, and appends a transition defaulting
  both `from`/`to` to the first state; the `from` select correctly includes
  an "Any" option the `to` select doesn't; Exit-time checkbox reveals a
  clamped number input — verified live: typing `1.5` (above the schema's
  max of 1) clamps to `1` on blur, per `Math.min(1, Math.max(0, v))`;
  Condition rows: "+ Condition" seeds a fresh condition typed from the first
  param; the operator select correctly narrows to `opsForParamType` for the
  referenced param (bool → eq/neq only, number → all six, trigger → hidden
  entirely in favor of a static "on trigger" note); the value control
  switches between a true/false select (bool) and a NumberField (number).
- Validation-issue surfacing: deleting every state produced a clean,
  specific, correctly-gated message: "⚠ Finish these before saving / Add at
  least one state. / Choose an initial state." with Save disabled
  (`title="Resolve the highlighted issues before saving"`) — legible, and
  each line maps to a concrete fix.
- Save-flow mechanics: the "Unsaved" pill and Save's enabled state are both
  bound to a real content diff (`JSON.stringify(draftToDoc(draft)) !==
  loadedDoc`), not a naive "something changed" flag, and are recomputed
  after a successful save (`setLoadedDoc(...)` in `save()`), so re-saving an
  unmodified draft correctly stays disabled with `title="No unsaved
  changes"`; an external on-disk edit alone (with no in-editor change)
  correctly does *not* falsely flip the dirty pill (verified live — see
  ANIMATOR-8 for the accompanying defect in the same flow).
- Row grid alignment vs. the Inspector: `animator.css`'s own comment states
  the intent ("reuses `.component-header`/`.component-body`/`.select`/
  `.input`/`.btn` so a params/states/transitions section reads as the same
  kind of surface as the Inspector's component cards") and the CSS grid
  templates for param/state rows hold that alignment consistently across
  every row in a section (confirmed visually across every screenshot: no
  ragged columns, consistent row height).
- Empty state (zero state-machine assets in the project): centered icon +
  "No state machines yet" + explanatory hint copy — consistent with this
  app's other empty states in tone, even though the content of that hint is
  itself the subject of ANIMATOR-3.

## Not covered

- Live click-through confirmation of the Inspector's Edit button opening the
  Animator tab (got as far as Hierarchy/Inspector panels open, Courier
  entity selected, `AnimationStateMachine` row visible with Edit enabled —
  the final click + resulting tab wasn't captured in a stable screenshot).
  This machine ran a well-documented dockview "all panels closed" bug
  throughout the session (also hit and filed by the assets-panel auditor as
  ASSETS-3, cross-surface) compounded by a concurrent bulk edit to
  `apps/editor/src` (see header note) that forced repeated HMR remounts of
  the whole app shell mid-session; I'm confident in this path via the
  identical-dispatch code proof above and the independent
  `inspector-specialized.md` corroboration, but didn't get a clean
  screenshot of the tab actually opening via this specific route.
- Interplay with Play mode: `apps/editor/src/livePatch.ts:106-111` shows a
  real mechanism exists — an `updateStateMachineAsset` save during Play
  triggers an `{kind: 'asm-reload', assetId}` live patch that hot-swaps the
  running ASM for bound entities instead of forcing a full restart — but I
  did not exercise a live Play session end-to-end (start Play, edit params
  in the open Animator, Save, observe the sprite's behavior change without a
  restart) given time/resource constraints in this heavily shared
  environment. Left for `playmode.md`'s auditor to corroborate if not
  already covered.
- A full keyboard-only (no mouse) pass through a transition card's Tab
  order. Confirmed via code that `TextField`/`NumberField` implement
  standard Enter-commits / Escape-reverts semantics
  (`components/ui.tsx:18-69`) and that every actionable element is a real
  `<button>`/`<select>`/`<input>` (so Tab/Enter/Space work by default), but
  did not drive a manual all-keyboard walkthrough of a multi-row transition
  card live.
- Right-click / context menu on any row: none exists anywhere in this
  editor (consistent with the rest of the app — e.g. the Assets panel has
  none either per `assets.md`), confirmed by the absence of any
  `onContextMenu` handler in the file; not worth a dedicated repro given
  it's a repo-wide pattern, not an Animator-specific gap.
- ANIMATOR-2's "switch Machine mid-edit" scenario is code-verified only:
  `sky-courier` ships exactly one `stateMachine` asset, so there was no
  second option in the dropdown to switch to during a live session without
  hand-authoring a second `.asm.json` + `assets.json` entry, which I judged
  out of scope for a read-and-observe audit pass.
