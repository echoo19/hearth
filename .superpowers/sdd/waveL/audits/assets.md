# Audit: assets  (example: sky-courier, port 5216)

Surface: `apps/editor/src/components/AssetsPanel.tsx` + `SliceDialog.tsx`.
Driven headless (playwright-core, system Chrome, 1500×950) against a scratch
copy at `/private/tmp/waveL-audit-assets`; empty state checked against a fresh
Blank-template project.

## Findings

### ASSETS-1 · friction · high
- Element: asset card (any) — rename/delete affordances
- Observed: There is no way to rename or delete an asset from the editor UI.
  No context menu on cards (right-click does nothing), no delete button in the
  details row, no Delete/Backspace keybind, no multi-select. The `removeAsset`
  command exists and has excellent delete-while-referenced protection (tested
  via API: blocked with "Asset "courier-sheet" is still referenced by: Courier
  (ent_…) in scene scn_…; courier-prefab (ent_…) in scene scn_…. Remove
  references first."), but that messaging is unreachable by a human — only
  agents can delete.
- Expected: Card context menu (or details-row buttons) with Rename / Delete /
  Duplicate; delete surfacing the referenced-by conflict in a dialog. A 1.0
  editor where mis-imported or stale assets can only be removed by hand-editing
  assets.json (or asking an agent) fails the basic housekeeping bar.

### ASSETS-2 · defect · med
- Element: "Create sprite" / "Create tile" modal — error feedback
- Observed: Repro: click "+ Sprite", enter an existing name (`courier-sheet`),
  click "Create sprite". The command fails with CONFLICT ("An asset named
  "courier-sheet" already exists…") but the dialog shows NO inline error —
  it silently stays open with all fields untouched. The only feedback is an
  error badge on the Console tab (screenshot 32-create-conflict). The user
  clicks Create, nothing visibly happens.
- Expected: Show the command's error message inline in the modal (the
  SliceDialog already does exactly this via its `confirmErrors` block — the
  pattern exists in the same surface).

### ASSETS-3 · defect · high (cross-surface: dockview/workspace)
- Element: Assets panel mount on project open
- Observed: On every fresh project open in my runs, the bottom dock showed
  "All panels are closed" although the Assets/Console/… tabs exist; clicking
  the Assets tab did not mount the panel. Only toggling Assets OFF then ON via
  the View menu forces a mount. This is the known dockview bug from the
  dispatch, but it reproduced 100% of the time here, so the panel under audit
  is unreachable without the workaround.
- Expected: Panels mount when their tab exists/is clicked. Filed here for
  visibility even though the fix belongs to the workspace surface.

### ASSETS-4 · friction · med
- Element: asset grid — search/filter/sort
- Observed: No search box, no type filter, no sorting. sky-courier already has
  19 assets in one flat grid in insertion order (sprites, animations, audio,
  font, state machine interleaved). Finding one asset means visually scanning
  every card.
- Expected: At minimum a search-by-name field in the toolbar; ideally a type
  filter (the `asset-type` label is already on every card). Real projects will
  have hundreds of assets.

### ASSETS-5 · friction · med
- Element: asset card — double-click
- Observed: Double-click runs the single-click toggle twice: the card selects
  then immediately deselects (verified on courier-motion: `selected = 0` after
  dblclick, no panel opened). It reads as a flicker/no-op, and the natural
  "open" expectation is unmet: dblclick on a stateMachine doesn't open the
  Animator (a dedicated "Edit state machine" button exists but only after
  selecting), dblclick on a sheet doesn't open Slice, dblclick on audio
  doesn't play.
- Expected: Double-click should perform the asset's primary action (open
  Animator / open Slice / play), or at least not undo the selection.

### ASSETS-6 · friction · low
- Element: asset grid — keyboard navigation
- Observed: Cards are Tab-focusable and Enter/Space toggles selection
  (verified), but arrow keys do nothing (ArrowRight left focus on the first
  card). Tabbing through 19+ cards one at a time is the only keyboard path.
- Expected: Roving-tabindex grid navigation (arrows move focus, Home/End) —
  the standard pattern for a 2D grid of items.

### ASSETS-7 · friction · low
- Element: import error banner (`.export-errors` under the toolbar)
- Observed: After a failed/partial import the red banner (e.g.
  "unsupported.xyz: images (…) can be imported") persists indefinitely — no
  dismiss control. It only clears when the next import starts. It sat on
  screen through unrelated create-sprite/slice work in my session.
- Expected: A dismiss ✕ on the banner (or auto-expiry once acknowledged).

### ASSETS-8 · polish · low
- Element: import skip-reason copy
- Observed: The skip reason for an unsupported extension is a capability list:
  "unsupported.xyz: images (png, jpg, jpeg, svg, webp, gif), audio (wav, mp3,
  ogg), and fonts (ttf, otf, woff, woff2) can be imported". It never states
  the actual problem, and the full list is a wall of text repeated per file.
- Expected: Lead with the problem — `".xyz" files aren't supported` — with the
  supported list as secondary text (or in the Import button tooltip only,
  where it already lives).

### ASSETS-9 · friction · low
- Element: toolbar create affordances vs `createSound`
- Observed: Toolbar offers "+ Sprite" and "+ Tile" only. The engine has a
  `createSound` command (procedural audio; it's even special-cased in the
  Agent Timeline formatter), but there is no UI affordance to create a sound —
  users can only import audio files.
- Expected: Either a "+ Sound" affordance for parity with the agent
  capability, or an intentional decision documented; today the asymmetry is
  invisible to users.

### ASSETS-10 · polish · low
- Element: prefab / stateMachine card thumbnails
- Observed: Icon-only thumbs (prefab, stateMachine, unresolved animation)
  render a very faint `--ink-faint` icon on the checkerboard
  transparency background. The prefab card thumb reads as nearly empty
  (screenshots 33/34), and the checkerboard implies "transparent image" for
  something that isn't an image at all.
- Expected: Higher-contrast glyph on a flat tile background for non-image
  assets; reserve the checkerboard for actual image previews.

### ASSETS-11 · polish · low
- Element: audio asset details row
- Observed: Selecting an audio asset shows only name/path/id/Copy id/Assign.
  The play affordance exists solely as the small button on the card; the
  details area shows no preview control and no duration/format metadata.
  (Sheets get a FrameGrid, fonts get a live sample — audio gets nothing.)
- Expected: Details-row play/stop plus duration, matching the richness the
  other types get.

## Verified working

- Asset grid renders every type in the example correctly: sprite PNG + SVG
  image thumbs, animation cards resolve first-frame crops from the sheet's
  .anim.json (courier-walk/idle show the correct courier frame), stateMachine
  icon, audio play button, font live "Aa" sample, prefab icon; type label on
  every card.
- Frame-count badge on sliced sheets ("6 frames"); prefab entity-count badge
  ("1 entity"); singular/plural handled.
- Card selection: click toggles select/deselect, `aria-pressed` tracks it,
  Enter and Space both activate (isActivationKey path), Tab moves focus.
- Details row: bold name, mono path, faint mono id; "Copy id" writes the real
  id to the clipboard (verified: `ast_ftu7lwf6`) and logs a confirmation.
- "Slice…" appears only for sprite/tile; opens SliceDialog.
- SliceDialog end-to-end: live preview with checkerboard + pixelated upscale;
  grid overlay cells align exactly with frames at 16×16 on the 96×16 sheet;
  readout "6 frames (6 × 1)" updates live (8px width → "12 frames (12 × 1)");
  frame width 0 → inline field error "Frame width must be a whole number of at
  least 1px.", red input outline, Slice disabled; name-prefix placeholder is
  the slugified asset name (`test_sheet`); slicing a freshly imported 64×32
  PNG at default 32×32 produced exactly
  `[test_sheet_0 (0,0,32,32), test_sheet_1 (32,0,32,32)]` in assets.json on
  disk, card badge and details FrameGrid updated immediately; re-opening Slice
  prefills from the existing grid metadata (32 restored); Cancel and Escape
  both close; Enter submits the form.
- Import via "Import…" button: hidden file input with correct accept list;
  multi-file; unsupported extension skipped with role=alert banner + console
  warn + one-line summary toast ("Imported N, skipped M (…)" with grouped
  reasons); 25 MB limit enforced client-side ("big-file.png: larger than the
  25 MB import limit"); WAV import works; name-collision on re-import is
  auto-resolved (test-sheet-2, test-sheet-3, jump-sound-2); error banner from
  a previous import clears when a new import starts; grid refreshes with new
  cards after import.
- Drag-and-drop import onto the panel: single PNG and multi-file mixed drop
  (PNG + .xyz) both handled through the same one-call path — supported file
  imported, unsupported one produced the same banner; no stuck drop overlay
  after drop (drag-depth bookkeeping correct).
- Audio preview: play toggles to stop icon + `playing` class; clicking again
  stops; starting a second asset's preview stops the first (rooftop-loop →
  jump-sound verified both directions); short samples reset their button state
  when playback ends (0.28 s jump_sound).
- Font preview: card shows live "Aa" in Press Start 2P once the FontFace
  loads; details show "Aa Bb 0123 — Hearth" sample in-family.
- "Assign to …": label tracks selected entity ("Assign to “Courier”"),
  disabled with instructive tooltip when incompatible ("Select an entity with
  an AudioSource to assign" for audio / SpriteRenderer for sprites) or when
  nothing selected ("Assign to selection"); clicking with Courier selected and
  the parcel sprite chosen set `SpriteRenderer.assetId = ast_ggsvl0wl`
  (verified via inspectEntity).
- Prefab details: "Add to scene" (tooltip "Instantiate into "Rooftops" at the
  viewport center") instantiated the prefab at the viewport center and
  selected the new entity (Inspector opened on it); "Sync instances" ran its
  instance-count preflight and raised the danger ConfirmDialog with accurate
  copy ("Syncs 2 instances with this prefab. Overrides you've made on each
  instance are kept; …"); Cancel dismissed without executing.
- stateMachine details: "Edit state machine" opened the Animator panel with
  courier-motion loaded (params/states/transitions visible).
- Create sprite dialog: all fields present (name w/ autofocus + placeholder,
  shape select with 11 shapes, color swatch+hex pair, W/H number pair),
  Create disabled until a name is entered, success closes the dialog and the
  new card appears; procedural SVG written to assets/sprites/.
- Create tile dialog: same pattern (name/color/size), created tile card
  appears.
- Empty state (fresh Blank project): centered icon + "No assets yet" + hint
  copy covering both the create-procedural and import/drop paths.
- Delete-while-referenced protection (command level): removeAsset on
  courier-sheet correctly blocked with a message listing every referencing
  entity and scene.
- Toolbar Import button shows "Importing…" busy state and is disabled during
  an import; tooltip enumerates supported formats and mentions drag-drop.

## Not covered

- Real folder drop (webkitGetAsEntry traversal): synthetic DataTransfer in
  headless Chrome returns null entries, so the directory-walk path
  (`dropEntries.ts`) couldn't be exercised end-to-end; it has unit tests and
  the flat-file fallback was exercised.
- The drop-target overlay's visual appearance mid-drag (synthetic drag events
  fire enter→drop too fast to screenshot; overlay dismissal verified).
- Slicing a >512-frame sheet (MAX_OVERLAY_CELLS readout-only mode) — would
  need a large atlas; logic code-reviewed only.
- Slicing an SVG sprite (Slice… is offered for `parcel.svg`; server-side
  behavior for non-raster sheets untested).
- Corrupt/undecodable audio file error path (onerror logging) — code-reviewed
  only.
- Import while a command is in flight / concurrent drops.
- `data`/`other` asset types' fallback card icon (example contains none).
- Note: mid-audit the dev server threw a transient `[postcss] ENOENT
  @fontsource-variable/bricolage-grotesque` overlay — a concurrent
  node_modules mutation in the shared repo, not an Assets-panel issue; it
  self-resolved when the package finished installing.
