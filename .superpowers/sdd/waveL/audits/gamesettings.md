# Audit: gamesettings  (example: ember-horde, port 5223)

## Findings

### GAMESETTINGS-1 · polish · high
- Element: `.panel-header` of the Game Settings panel (`GameSettings.tsx:196-198` empty state, `:219-221` populated state) — renders `<span>Game</span>`.
- Observed: The panel's own in-body header reads "GAME" (small caps via CSS), both when a project is open and in the (unreachable, see GAMESETTINGS-8) empty state. Meanwhile the dockview tab strip directly above it, and the View menu, both correctly read "Game Settings" (`Workspace.tsx:48`, `PANEL_TITLES.gameSettings`).
- Expected: The in-panel header should say "Game Settings" to match its own tab. As shipped it instead exactly collides with the text of a *different*, unrelated panel — `PANEL_TITLES.game = 'Game'`, the live game-preview/canvas host shown automatically on Play (`Workspace.tsx:40`) — so a user skimming panel headers sees two panels both titled "Game" for two different purposes.

### GAMESETTINGS-2 · defect · high
- Element: Loading → Image picker (`select[aria-label="Loading image"]`) and Shipping → Icon picker (`select[aria-label="App icon"]`), both built from `spriteAssets()` (`GameSettings.tsx:60-62`: `assets.filter((a) => a.type === 'sprite')`).
- Observed: In the ember-horde project (assets: `ember-knight` sprite, `ember-wisp` sprite, `ember-wall` **tile**, `Enemy` prefab), both dropdowns list only `(none)`, `ember-knight`, `ember-wisp`. The `ember-wall` tile asset — a perfectly valid image — never appears as an option in either picker.
  Repro: open ember-horde → Game Settings → Shipping → Icon dropdown → inspect `<option>` list → `ember-wall` is absent.
- Expected: Inspector's equivalent asset pickers accept both kinds — `Inspector.tsx:422` (Tilemap tile picker: `a.type === 'sprite' || a.type === 'tile'`) and `Inspector.tsx:994-997` (generic `assetId`/SpriteRenderer picker: same `'sprite' || 'tile'` filter). A tile-typed image is exactly as valid a loading-screen image or app icon as a sprite-typed one, and there is no in-app workaround to re-tag an asset's type — this is a hard, silent capability gap versus the rest of the editor's asset pickers.

### GAMESETTINGS-3 · polish · low
- Element: All scalar fields except the Spinner checkbox — Title (`htmlFor="game-title"`, `GameSettings.tsx:227`), Width/Height/Target FPS/Fixed timestep (`GameSettings.tsx:236,240,252,258`, plain `<label className="field-label">` with **no** `htmlFor` at all), Background/Loading Background (same, no `htmlFor`).
- Observed: `TextField`/`NumberField`/`ColorField` in `apps/editor/src/components/ui.tsx` never accept or render an `id` prop (confirmed via DOM inspection: the Title `<input>` has `id=""`). So `htmlFor="game-title"` on the Title label points at nothing, and clicking the "Title" label text does not focus the input. Width/Height/etc. labels don't even attempt an association. Only the raw `<input id="game-loading-spinner">` checkbox (`GameSettings.tsx:288-293`) is correctly wired to its label.
- Expected: Every field label should be click-to-focus and screen-reader-associated with its control, consistent with the one row (Spinner) that does this correctly. This is a shared-component gap (`ui.tsx`), not unique to this panel, but this panel is where it's most visible since 6 of 7 rows are affected.

### GAMESETTINGS-4 · friction · medium
- Element: Title (`TextField`) and both color fields' hex text input (`ColorField`'s `input.mono`).
- Observed: Title commits an **empty string** with no rejection (repro: select-all the Title input, clear it, press Enter → committed value is `""`, no inline error). Background/Loading-Background hex text commits an **arbitrary non-hex string** verbatim (repro: type `not-a-color`, press Enter → `buildSettings.backgroundColor` becomes the literal string `"not-a-color"`, no error) — while the color swatch preview silently falls back to `#ffffff` for the same invalid draft (`ui.tsx:74`), so the swatch and the actually-committed value visibly diverge with zero feedback.
- Expected: Width/Height/Target FPS/Fixed timestep in the very same panel have solid client-side guards (revert + inline "Must be a whole number ≥ 1" hint) for exactly this class of bad input. Title and the color fields should hold to the same bar — blanking a game's window title, or corrupting its background color into a non-CSS-color string, should not be silently accepted.

### GAMESETTINGS-5 · friction · low
- Element: Loading → Image picker vs. Shipping → Icon picker (`SpriteAssetPicker`, `showThumbnail` prop).
- Observed: The Icon picker passes `showThumbnail` (`GameSettings.tsx:305`) and shows a live preview of the selected sprite; the Loading Image picker does not (`GameSettings.tsx:276-282`, no `showThumbnail`), so selecting a loading-screen image gives no visual confirmation at all — only the asset's name in the closed `<select>`.
- Expected: Both fields are equally visual picks (one governs the loading-screen backdrop image, one the desktop icon) and should both get a thumbnail, or neither should.

### GAMESETTINGS-6 · friction · medium
- Element: `.panel-body` (`GameSettings.tsx:222`) containing all four `.diff-section` blocks (Window, Loop, Loading, Shipping).
- Observed: At the default dockview bottom-panel height, only Window and part of Loop ("Target FPS") are visible before the fold; "Fixed timestep", the entire "Loading" section, and the entire "Shipping" section (including the Icon field — the whole reason to open this panel for a shippable build) require scrolling, with no visible scroll-shadow/fade or other affordance in the initial view hinting more content exists below.
- Expected: A user resizing the panel to a typical height could easily miss the Icon field and the rest of Loop/Loading entirely without realizing there's more below.

### GAMESETTINGS-7 · friction · low
- Element: Any field in this panel, exercised while the game is in Play mode.
- Observed: Repro — click Play, then edit Title (a purely cosmetic field with no gameplay-loop implication) in Game Settings. The toolbar's Play button is instantly replaced by an orange "Scene changed — Restart" badge, exactly as it is for structural scene edits. There is no live-patch/preview and no distinction between cosmetic fields (Title, Background colors, Spinner) and structural ones (Width/Height/targetFps/fixedTimestep) — every `updateSettings` call is classified as `structural` (`livePatch.ts` fallback path) regardless of field.
- Expected: This is an app-wide classification gap rather than something unique to this component, but it's most visible here because most of this panel's fields (title, background colors, spinner) are cosmetic and could plausibly live-patch without a restart.

### GAMESETTINGS-8 · polish · low (dead code / unreachable state)
- Element: The `if (!info) { ... "No project open" ... }` branch (`GameSettings.tsx:193-207`).
- Observed: The only way to reach a no-project state in the running app is "Close project" in the toolbar, which unmounts the entire editor workspace back to the launcher screen — it does not leave any panel (including Game Settings) open with empty content. I could not find any UI path that leaves the Game Settings tab mounted with `info` null.
- Expected: Either this is genuinely unreachable defensive code (harmless, but worth confirming intent), or there's a load-failure/transitional path that does hit it which I didn't find — if the latter, note it also inherits the GAMESETTINGS-1 header bug and uses a `play` icon (a "run" glyph) for a "nothing is open" message, which reads as a mismatched icon choice if it's ever actually seen.

## Verified working
- Title (`TextField`): commits on blur and on Enter (Enter calls `.blur()`); Escape reverts the draft to the last committed value without forcing blur (matches `ui.tsx` behavior).
- Width/Height/Target FPS/Fixed timestep (`IntField`): reject `0`, `-5`, `3.5`, and empty string — each reverts the draft to the last committed value and shows "Must be a whole number ≥ 1"; accept the boundary value `1`; accept large valid integers (`1920`) and commit them.
- Target FPS / Fixed timestep: no upper bound enforced (by design per schema — `z.number().int().positive()`, no max) — `999999999` is accepted and committed without error (confirms no clamp, consistent with server schema).
- Background / Loading Background (`ColorField`): the native color-swatch input commits immediately on every picker change (no blur step); the paired hex text input commits on blur/Enter and reverts on Escape.
- Loading Image picker and App Icon picker: both correctly exclude non-image asset kinds — the `Enemy` prefab asset never appears as an option in either dropdown (only the sprite-exclusion of tiles is a bug, per GAMESETTINGS-2).
- Spinner checkbox: toggles correctly on click, and (uniquely in this panel) its label is properly click-associated via matching `id`/`htmlFor`.
- Icon thumbnail: correctly renders the selected sprite's image (`fileUrl(projectPath, asset.path)`) when a sprite is chosen, and correctly reverts to the generic image-placeholder icon when cleared back to "(none)".
- Global Undo (`Cmd+Z`) / Redo (`Cmd+Shift+Z`) correctly reverts and reapplies both a scalar-field edit (Width: 800→4321→undo→800→redo→4321) and a picker-field edit (Icon: none→ember-knight→undo→none→redo→ember-knight).
- Toolbar Undo/Redo buttons (mouse-click) work identically to the keyboard shortcuts for the same edits.
- `Ctrl+Z` (non-Mac chord) correctly does *not* trigger undo — confirmed this is expected macOS-only `Cmd+Z` binding, not a defect (verified by testing `Meta+Z` immediately after, which worked).
- "Scene changed — Restart" toolbar badge correctly appears the instant any Game Settings field is edited while Play is active, and clicking it/Stop clears back to normal (shared app-wide mechanism, confirmed to fire consistently for this panel's `updateSettings` calls).
- Panel row layout (`.inspector-row`: label column + control column, spacing, control height) visually matches Inspector's own component-row styling — no misalignment observed between the two panels side by side.
- `exec(..., { quiet: true })` used by every field in this panel suppresses only the one-line Console success log; it does not suppress the state refresh, the live-patch/restart-badge classification, or error logging on failure (confirmed via code read, `store.ts:1053-1101`).
- New-project / fresh-example defaults match schema defaults where unset (width 800, height 600, backgroundColor `#1a1a2e`, targetFps 60, fixedTimestep 60) — confirmed against ember-horde's on-disk `hearth.json` and `packages/core/src/schema/project.ts`.

## Not covered
- The `<option value={MISSING_ASSET} disabled>(missing asset)</option>` sentinel path (`GameSettings.tsx:168-171`) for a deleted-but-still-referenced icon/loading-image asset — did not delete a referenced asset mid-session to force this live; behavior inferred from code only.
- Focus-visible outline styling across all controls when navigating by keyboard/Tab — did not verify focus-ring rendering, only click-driven interaction.
- In-panel surfacing of a genuine server-side command failure (as opposed to the client-side guards this panel's `IntField` already has) — could not force a real server-side `updateSettings` rejection through the UI alone; per code (`store.ts`) failures always log to the Console tab regardless of `quiet`, but there is no in-panel error banner to visually confirm.
- The empty "No project open" state (see GAMESETTINGS-8) — could not reach it via any normal navigation path; "Close project" always returns fully to the launcher rather than leaving this panel mounted with no project.
- One intermittent, non-reproducible page error — `Cannot read properties of null (reading 'clear')` — was observed firing a few seconds after opening the project with **zero** interaction with Game Settings (confirmed by an idle-only repro), so it is unrelated to this surface and out of scope here; flagging for awareness only in case another auditor's surface owns the code path.
