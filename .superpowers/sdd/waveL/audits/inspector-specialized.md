# Audit: inspector-specialized (examples: glow-caves + ember-horde, port 5215)

Surface: `apps/editor/src/components/Inspector.tsx` specialized field editors
(`TileCharField`, `TileRowEditor`, `TileAssetsField`, `AutotileRuleFields`,
`FontFamilyField`, `AnchorGrid`, `UnsupportedField`, and the prefab-instance
banner/override machinery) plus `apps/editor/src/components/PostEffectsField.tsx`
(Camera.postEffects stack editor). Driven headlessly with playwright-core
(system Chrome channel, `--use-gl=angle --use-angle=swiftshader`, viewport
1500x950) against scratch copies of glow-caves
(`/private/tmp/waveL-audit-inspector-specialized-glow-caves`, used for
Tilemap/autotile/PostEffects/SpriteEffects/Animator/UnsupportedField) and
ember-horde (`/private/tmp/waveL-audit-inspector-specialized-ember-horde`,
used for prefab-instance overrides, AnchorGrid, FontFamilyField).

Hit the documented dockview "All panels are closed" bug on every fresh
project open; the View-menu toggle-off/toggle-on workaround in
AUDITOR-COMMON.md fixed it reliably every time. Also hit an unrelated
environment hiccup mid-session: `@fontsource-variable/bricolage-grotesque`
was transiently missing from the shared repo `node_modules`, breaking
`styles.css` for a few minutes (another auditor's `npm install` apparently
fixed it) — not a product defect, noted for completeness.

## Findings

### INSPSPEC-1 · defect · high
- Element: `PostEffectsField.tsx`'s `EffectFieldRow` → any numeric field on
  any of the 6 effect types (e.g. Camera → Bloom → strength, schema
  `min(0).max(3)`; SpriteEffects → Flash Strength, schema `min(0).max(1)`).
- Observed: Select Main Camera, add a Bloom effect, type `999` into
  `strength`, blur. The field keeps showing `999` with zero visual
  indication anything is wrong (no red border, no inline error, no toast).
  Deselect the entity and reselect it (forcing a fresh read of server
  state): the field silently snaps back to `1` (the real, unchanged value).
  Repro is identical for SpriteEffects.flashStrength with `5` (max `1`) →
  reverts to `0` on reselect, and for a negative value (`-5`, min `0`) on
  bloom.strength. The rejection **is** logged to the Console panel
  ("Edit component: Invalid value for SpriteEffects.flashStrength: ...Number
  must be less than or equal to 1"), but nothing surfaces inline in the
  Inspector, and the Console tab shows no unread-badge to hint at it.
  `NumberField` (`ui.tsx`) has no `min`/`max` HTML attributes and does zero
  client-side range validation, unlike `TileCharField`'s inline
  `validateTileChar`.
- Expected: Either clamp/validate against the known schema bounds
  client-side before committing, or at minimum resync the field to the real
  value and show an inline error the instant a commit is rejected — the same
  gap `inspector-core.md`'s INSPECTOR-2 already flagged for `ColorField`'s
  invalid-hex case (same root cause: `useEffect(() => setDraft(value),
  [value])` never re-fires when the prop value is unchanged by a rejected
  write). This is a shared-primitive bug, but it is especially reachable here
  because every post-effect and SpriteEffects field is schema-bounded and the
  UI gives no hint of the valid range (no slider, no min/max, no step).
  Screenshots: `p3-06-after-oob-edit-999.png`,
  `p3-07-after-reselect-check-persisted-value.png`,
  `p4-06-console-panel-after-oob-write.png`.

### INSPSPEC-2 · polish · med
- Element: `PostEffectsField.tsx`'s `EffectFieldRow` label
  (`<label className="field-label" title={field}>{field}</label>`).
- Observed: Every post-effect field renders its raw camelCase schema key as
  the visible label — `strength`, `threshold`, `curvature`,
  `scanlineIntensity`, `noise`, `brightness`, `tint` — all lowercase,
  unhumanized. Every other field in the same Inspector panel (Zoom, Is Main,
  Background Color, Ambient Light, and SpriteEffects' Outline Enabled/Outline
  Color/etc., confirmed working) runs through `humanizeFieldLabel` /
  matches its own local `humanize()` helper used for the effect *type* label
  above it. The effect *type* title ("Bloom", "CRT") is humanized; its own
  field rows are not. Screenshot: `p3-02-six-effects-added.png`,
  `zoom-posteffect-fields.png`.
- Expected: `EffectFieldRow` should route `field` through the same
  humanize-a-camelCase-key transform as everywhere else in the Inspector for
  visual consistency (e.g. "Scanline Intensity", not "scanlineIntensity").

### INSPSPEC-3 · polish · high
- Element: `PostEffectsField.tsx`'s `EffectFieldRow` number/color inputs
  inside `.effect-card-body .inspector-row`.
- Observed: The control column of every post-effect field row renders as a
  tiny ~36×36px square with the numeric value invisible (not clipped —
  simply not wide enough to show any digits before the box's edge), instead
  of the wide, legible input every other Inspector row gets (compare
  `Ambient Light` showing `0.15` in a full-width box on the very same panel,
  two rows above the Bloom card). Confirmed by cropping/zooming
  `p3-02-six-effects-added.png` → `zoom-posteffect-fields.png`: "strength"
  and "threshold" both show as blank dark squares. Reproduces for every
  effect type's numeric fields (CRT's curvature/scanlineIntensity/noise
  shown in `p3-10-vignette-card.png` have the same collapsed box).
- Expected: The number input should stretch to fill its grid column like
  every sibling `.inspector-row` elsewhere in the Inspector, so the value is
  actually readable without clicking in. As shipped, a user cannot tell
  what strength/threshold/etc. currently are without clicking into each box
  individually.

### INSPSPEC-4 · friction · high
- Element: Tilemap's "Grid" field (`Tilemap.grid`, a `string[]` of raw
  row-strings like `.RRRR.....`).
- Observed: `Tilemap.grid` falls through Inspector.tsx's generic
  `isStringArray` branch (the same one used for `Collider.collidesWith`)
  because it's a non-empty `string[]` and there's no `Tilemap`/`grid`
  special case anywhere in the file. It renders as a plain row-per-string
  `StringListField`: each of the 8 grid rows is a free-text `<input
  placeholder="*">` with a generic "Remove item N" button, and an "**Add
  layer**" button at the bottom — copy borrowed wholesale from the
  string-list-of-tags use case it was built for. There is **no validation
  at all** on what you type into a row: unlike `TileCharField` (which
  rejects multi-char, reserved `.`/space, and duplicate chars via
  `validateTileChar`), a Grid row will happily accept any string of any
  length containing any characters — including chars that don't exist in
  `tileAssets` at all — with zero feedback. This sits directly beneath the
  carefully validated Tile Assets editor (char rows, autotile mode, advanced
  mapping) in the very same component card. Confirmed via
  `tilemap-card.html` (see the `>Grid<` label followed by
  `class="vec2-list-row"><input class="input" placeholder="*"
  value=".RRRR.....">`) and `p1-04-cave-rocks-selected.png` /
  `p1-05-tilemap-card.png`.
- Expected: This is exactly the kind of "raw text editing of structured
  level data" the codebase's own stated bar rejects elsewhere (see
  `UnsupportedField`'s comment: "no raw JSON for a typed field, ever," and
  Vec2ListField/TileAssetsField's existence specifically to avoid raw-JSON
  editing). A dedicated Grid editor — or at minimum row validation against
  the current `tileAssets` char set plus copy that says "row"/"Remove row N"
  instead of "layer"/"item N" — would match the bar the rest of the Tilemap
  card already meets. As shipped, this is the one place in the whole
  Tilemap card where a typo silently corrupts the level layout with no
  safety net.

### INSPSPEC-5 · friction · med
- Element: Prefab-instance banner — "Update prefab" button
  (`handleUpdatePrefab` in `Inspector.tsx`).
- Observed: Clicking "Update prefab" calls `exec('updatePrefab', ...)`
  immediately with **no confirmation dialog** — verified by reading the
  handler (no `setState`-then-`ConfirmDialog` indirection, unlike its two
  neighbors) and by inspecting the rendered DOM (its `onClick` goes straight
  to the async handler). This is the single broadest-blast-radius action in
  the whole banner: it pushes *this* instance's current field values back
  onto the shared prefab asset, which is by definition read by every other
  instance of that prefab across every scene in the project. Yet the two
  neighboring buttons in the same banner — "Sync instances" and "Revert
  all" — both get a `ConfirmDialog` with specific, blast-radius-aware copy
  (`syncConfirmBody`/`revertAllConfirmBody`, both verified correct, see
  INSPSPEC-verified list) before they do anything.
- Expected: "Update prefab" is at least as consequential as "Sync
  instances" (it's the mutation that a subsequent sync would later reconcile
  everyone else *to*) and arguably more surprising, since it's one click,
  no dialog, and immediately rewrites the shared prefab definition. It
  should get the same confirm treatment, ideally naming how many other
  instances exist (the same `countPrefabInstances` preflight "Sync
  instances" already uses is sitting right there in `prefabActions.ts`).

### INSPSPEC-6 · friction · med
- Element: Prefab-instance detach (automatic side effect of adding/removing
  a component on an instance member — core's `detachOnStructuralEdit`, not a
  manual Inspector control).
- Observed: On ember-horde's "Elite Enemy" (a prefab instance with 2
  remaining overrides after a partial revert), adding a `SpriteEffects`
  component via the "Add component…" dropdown silently detaches the
  instance: the "Instance of Enemy" banner (with its Revert all/Update
  prefab/Sync instances row) disappears from the Inspector entirely, and the
  small prefab badge icon next to "Elite Enemy" in the Hierarchy tree
  disappears too — with **no dialog, no toast, and no tab-badge** on the
  Console panel. The explanation *is* logged ("addComponent: A structural
  edit detached this prefab instance (root ent_morik0z9); it no longer syncs
  with its prefab.") but only inside the Console panel's log list, which
  most users won't have open while working in the Inspector. Screenshots:
  `p2b-03-before-structural-edit.png`, `p2b-04-after-adding-component-to-
  instance.png` (banner and badge both already gone here, before Console was
  ever opened), `p2b-05-console-after-structural-edit.png` (the only place
  the explanation exists).
- Expected: Losing prefab sync is a meaningful, easy-to-trigger, one-way (from
  the Inspector's perspective — no "reattach" affordance exists) structural
  change. It deserves at least a transient inline notice in the Inspector
  itself (e.g. a toast, or the banner briefly replacing itself with "This
  instance was just detached because you added a component" before
  vanishing) rather than relying entirely on a Console-panel log line the
  user has no particular reason to be looking at.

### INSPSPEC-7 · friction · low
- Element: Prefab-instance revert granularity (per-field `Revert` button in
  `.field-revert-slot`, vs. the banner's "Revert all").
- Observed: Reading `Inspector.tsx`, there are exactly two revert
  granularities: `handleRevertField` (one field at a time, via each row's own
  Revert button) and `handleRevertAll` (the whole instance, via the banner).
  There is no "revert this whole component" action in between, even though a
  component card is a natural unit (it already has its own header with a
  Remove-component button). On ember-horde's Elite Enemy, all 3 original
  overrides live on `SpriteRenderer` (Color/Width/Height) — reverting "just
  this component" requires clicking each field's Revert button
  individually.
- Expected: Not necessarily a defect (per-field is the more precise tool),
  but for a component with several overridden fields a single
  "Revert component" affordance in the component header (next to Remove)
  would save repeated clicks and match the field/component/entity
  granularity a reasonable user would expect from the existing
  field/entity bookends.

### INSPSPEC-8 · friction · low
- Element: `UnsupportedField` — `Script.params` (e.g. glow-caves' Player
  entity, `{"speed":160}`; Torch, `{}`).
- Observed: `Script.params` is the only field in either example project that
  actually falls back to `UnsupportedField`. It's read-only by design (per
  the component's own comment), showing `JSON.stringify(value)` plus "No
  typed control for this field yet — shown read-only. Edit it through your
  agent or the hearth CLI." This is a reasonable fallback for a field that's
  inherently schema-less (each Script defines its own param shape), but it
  means a simple numeric tweak like the Player's movement `speed` cannot be
  changed from the Inspector at all — the one component-authoring surface
  in the whole app that's most likely to need frequent small numeric tuning
  during playtesting has zero Inspector affordance.
- Expected: Given this is likely to be the single most common thing a
  non-agent user wants to tweak (a script's numeric knobs), even a generic
  best-effort editor (e.g., a key/value row editor for object-typed params
  with per-value type inference: number → NumberField, string → TextField,
  boolean → checkbox) would close a real gap, rather than leaving it as the
  one place in the whole Inspector where "read the raw JSON, then go use
  the CLI" is the answer.

## Verified working

- **PostEffectsField add/remove/reorder/cap**: all 6 effect types (Bloom,
  CRT, Vignette, Chromatic Aberration, Pixelate, Color Grade) add via the
  "Add effect…" dropdown with correctly humanized type titles; stack caps at
  8 (`POST_EFFECTS_MAX`) with the dropdown disabling itself and showing
  "Stack full (max 8)"; ↑/↓ reorder correctly moves cards and correctly
  disables at both ends (first card's ↑ disabled, last card's ↓ disabled);
  ✕ remove works per-card down to the "No post effects" empty state.
- **PostEffectsField Vignette color field**: renders the shared color-swatch
  + hex-text pair identically to any other color field.
- **TileCharField validation**: multi-character input ("AB") is rejected
  with "Must be exactly one character."; reserved chars (`.`) rejected with
  `"." is reserved for empty cells.`; renaming to a char already used by
  another row rejected with `"<char>" is already mapped in another row.`;
  Escape reverts the draft to the last-committed value in all three cases;
  a valid unique rename commits correctly (two composed commands — write
  new char, clear old char — confirmed via the resulting tileAssets state).
- **TileRowEditor add/remove**: "Add tile char" appends a new sprite-mode
  row defaulting to the first available image asset; the remove (✕) button
  clears a row's char via `setTileAutotile{clear:true}` regardless of its
  mode.
- **TileRowEditor sprite↔autotile mode switch**: switching a row from
  Sprite to Autotile via its mode `<select>` correctly writes
  `{sheet, template:'blob47'}` and swaps in the sheet-picker UI; the mode
  select correctly disables when no sliced sheet assets exist
  (`canUseAutotile` gate), with an explanatory title tooltip.
- **AutotileRuleFields**: the Template select is a locked single-option
  "Blob47 (47-shape)" dropdown with an explanatory tooltip (matches the
  code comment — there's only one template today); "Advanced mapping"
  `<details>` expands to show all 47 blob shapes, each shape's `<select>`
  correctly lists `(default: blob_N)` plus every sliced frame name from the
  assigned sheet, and picking a frame commits a per-shape mapping override.
- **FontFamilyField**: with no project font assets (glow-caves, ember-horde
  both), the dropdown correctly omits the "Project fonts" `<optgroup>` and
  shows just Generic (monospace/sans-serif/serif/cursive/fantasy) + "Custom…";
  selecting "Custom…" correctly reveals a plain TextField for an arbitrary
  value.
- **AnchorGrid**: 9 cells with correct `aria-label`s
  (top-left/top/top-right/left/center/right/bottom-left/bottom/bottom-right),
  `role="radiogroup"`/`aria-label="Anchor"` on the container, exactly one
  `aria-checked="true"` at a time; clicking a new cell updates selection;
  clicking the already-selected cell is a correctly-guarded no-op (`value
  !== anchor` check) with no console error or state corruption.
- **SpriteEffects component editor**: all 8 fields (Outline
  Enabled/Color/Width, Flash Color/Strength/Duration, Dissolve
  Amount/Seed) render with correctly humanized labels (contrast with
  PostEffectsField's INSPSPEC-2); no field falls back to `UnsupportedField`;
  the Outline Enabled checkbox toggles correctly.
- **Animator, Inspector side**: `SpriteAnimator.assetId` (Torch, glow-caves)
  shows a plain select correctly pre-selected to its assigned animation
  asset, with no Edit button (correct — only `AnimationStateMachine` gets
  one). `AnimationStateMachine.assetId`, once added to an entity, shows an
  asset-pick select (correctly listing only `(none)` when no stateMachine
  assets exist in the project) plus an Edit button that is correctly
  disabled with title "Assign a state machine to edit it" when no asset is
  assigned.
- **Prefab-instance override indicators**: a non-instance entity (ember-horde's
  "Backdrop") renders zero `.field-revert-slot` columns (control column
  recovers full width, per the code's stated intent); an instance with zero
  overrides ("Enemy") renders a revert-slot on every row for width
  consistency but zero actual Revert buttons, and correctly omits "Revert
  all" from the banner entirely; an instance with overrides ("Elite Enemy",
  3 overrides on SpriteRenderer.color/width/height) shows exactly 3
  ember-dot-marked rows and exactly 3 Revert buttons with correct
  per-field titles (`Revert "Color" to the prefab's value`, etc.).
- **Per-field revert**: clicking the Color row's Revert button on Elite
  Enemy correctly drops the override count banner from "3 overrides" to
  "2 overrides" and removes just that row's dot, leaving Width/Height still
  marked overridden.
- **Sync instances confirm dialog**: opens after an async instance-count
  preflight, shows "Sync all instances?" / exact copy from `syncConfirmBody`
  ("Syncs 2 instances with this prefab. Overrides you've made on each
  instance are kept; any that no longer apply to the updated prefab are
  dropped. Names and positions are kept.") with the correct live instance
  count (2: Enemy + Elite Enemy); Cancel dismisses without mutating anything.
- **Revert all confirm dialog**: shows "Revert all overrides?" / exact copy
  from `revertAllConfirmBody` ("Reverts 2 overrides across this prefab
  instance, restoring the prefab's own values.") with the correct live
  remaining-override count; Cancel dismisses without mutating anything.
- **Prefab detach mechanics** (distinct from the notification gap in
  INSPSPEC-6): the detach itself works correctly — banner and Hierarchy
  badge both disappear immediately and consistently after the structural
  edit, matching the underlying data model.
- **UnsupportedField hunt**: walked every entity in glow-caves (13 entities:
  Main Camera, Cave Floor, Wall Top/Bottom/Left/Right, Cave Wall Left/Right,
  Cave Rocks, Player, Torch, Stalactite, Drip) — the fallback appears only
  for `Script.params` on Player and Torch (see INSPSPEC-8); every other
  field across every component type gets a real typed control.

## Not covered

- Did not click through an actual "Sync instances" or "Update prefab"
  confirm-to-completion (only opened dialogs and cancelled) to avoid
  mutating the shared prefab asset state mid-audit in a way that would
  invalidate later steps in the same scratch project; the copy/gating were
  verified via the dialog text and code reading instead.
- Neither example project ships a `stateMachine`-type or `font`-type asset,
  so `AnimationStateMachine`'s asset-picker and `FontFamilyField`'s "Project
  fonts" optgroup were only exercised in their empty states, not with a real
  asset selected. (`sky-courier` has both asset types, per a quick
  `assets.json` grep, if a follow-up pass wants full coverage — out of scope
  since the dispatch pins this audit to glow-caves + ember-horde.)
- Did not exercise the `AnimatorEditor.tsx` panel itself (opened via the
  Inspector's Edit button) — out of scope per the dispatch, which scopes
  this surface to "the Inspector side: asset pick + Edit button + param
  display," not the editor panel it opens.
- A `[pageerror] Cannot read properties of null (reading '2')` (glow-caves)
  / a differently-worded null pageerror appeared intermittently during
  panel-visibility churn (dockview toggle-refresh, entity reselection).
  This matches what `inspector-core.md` already flagged as a probable
  Scene-view/canvas issue unrelated to Inspector field behavior (their repro
  used ember-horde's particle-heavy arena; mine reproduced on glow-caves,
  which also has active `ParticleEmitter`s on Torch/Drip) — noting again
  here for corroboration but leaving it to the sceneview surface.
- Did not fuzz every one of the 6 PostEffect types' every field for
  out-of-range values individually (bloom.strength/SpriteEffects.flashStrength
  were used as the representative repro for INSPSPEC-1) — the shared-root-cause
  analysis (client has no min/max, server rejects silently, draft doesn't
  resync) means the same result is expected for every other bounded numeric
  field in the same file (crt.curvature, vignette.intensity,
  chromaticAberration.offset, pixelate.size, colorGrade.brightness/contrast/
  saturation), but each was not individually reproduced.
