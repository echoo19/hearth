# Audit: toolbar (example: ember-horde, port 5211)

## Findings

### TOOLBAR-1 · defect · high
- Element: Scene-actions "⋯" popover and View menu popover — click-outside-to-close
- Observed: Both popovers use the same pattern (a `document`-level `pointerdown` listener that closes the popover if the click target isn't inside its root). Clicking outside the popover correctly closes it when the click lands on the toolbar itself, the Hierarchy panel, or the bottom Console panel — but when the click lands **on the Scene canvas** (the single largest surface in the whole app), the popover does not close. Reproduced twice for each menu:
  - Scene-actions menu: click at canvas center → menu still open (count 1). Click on wordmark/Hierarchy/Console → menu closes (count 0).
  - View menu: click at canvas center → menu still open (count 1). Click on Hierarchy → menu closes (count 0).
  Root cause is very likely that `SceneView`'s own pointerdown handling calls `stopPropagation()` (needed for its pan/select/drag logic), which prevents the event from ever reaching the `document`-level listener that both popovers rely on.
- Expected: Clicking anywhere outside the popover, including the canvas, should dismiss it. Today a user who opens View or Scene-actions and then clicks the canvas (the most natural place to click next) finds the menu still open and their canvas click swallowed/misinterpreted.

### TOOLBAR-2 · defect · high
- Element: Keyboard Shortcuts sheet (`?` / Shift+/) and, more broadly, any native browser Escape-driven default action while this project is open
- Observed: Pressing Escape while the shortcut sheet `<dialog>` is open does **not** close it (reproduced twice, via direct DOM count and screenshot — the dialog and its focused "Close" button remain visible). This directly contradicts the component's own doc comment: "Closed by Esc (dialog cancel), clicking the backdrop, or pressing `?` again while open." All three of those *other* paths do work: second `?` press closes it, backdrop click closes it, the "Close" button closes it — only Escape fails.
- Root cause (traced via instrumented `addEventListener` wrapping): `PixiSceneView.attachKeyboard()` in `packages/runtime/src/pixi/index.ts` (~line 542) installs a `window`-level `keydown` listener that calls `e.preventDefault()` whenever `this.runtime.input.isMappedCode(e.code)` is true — i.e. whenever the pressed key is one of the *current project's own configured input-action keys*. The ember-horde example maps `Escape` to its `pause` action and `Enter` to `ui-confirm` (see `hearth.json`'s `inputMappings.actions`). Because `attachKeyboard()` is invoked unconditionally on mount (`if (opts.attachKeyboard !== false) view.attachKeyboard()`) and the Game preview appears to stay mounted regardless of Play/Stop state or which dockview tab is active, this listener fires and calls `preventDefault()` on Escape **globally**, even while the editor (not the game) has focus and nothing is playing. Per the HTML spec, a `preventDefault()`-ed Escape keydown suppresses the native `<dialog>` close-watcher, which is exactly the observed symptom.
- Expected: Escape should close the shortcut sheet. More generally, the runtime's key capture should not intercept keys while the game isn't actually running/focused — see TOOLBAR-3, which shares this exact root cause with a second, more severe symptom.

### TOOLBAR-3 · defect · high
- Element: Every toolbar button (Play, Pause, Step, Undo, Redo, Debug, View, Checkpoint, Review, Export, Close project, etc.) — keyboard (Enter/Space) activation
- Observed: Focusing any toolbar button (verified concretely on "Debug" and "View") and pressing Enter or Space does **not** activate it — no click fires, `aria-pressed`/`aria-expanded` never change. Confirmed this is not a Playwright/test artifact: an isolated blank page with a plain `<button>` correctly fires its click handler on the identical `page.keyboard.press('Enter')` call. Instrumenting every `keydown` listener in the live app shows the keydown event arrives at the focused button with `defaultPrevented: false`, and by the time listeners finish it is `true` — traced to the same `PixiSceneView.attachKeyboard` described in TOOLBAR-2 (`ember-horde`'s `inputMappings.actions.ui-confirm` maps `Enter`). A `preventDefault()`-ed Enter/Space keydown suppresses the browser's native "activate the focused button" default action, so no click ever fires.
- Expected: Toolbar buttons should be keyboard-activatable via Enter/Space per standard `<button>` semantics, regardless of what keys the currently-open project happens to bind for gameplay, and regardless of whether the game is actually playing. Because this depends on the open project's own input mappings (virtually every real game maps Enter/Escape/Arrows/WASD/Space — exactly the keys editors and browsers rely on for their own UI), this is a near-universal, high-impact keyboard-accessibility break, not an edge case specific to this example project. It also plausibly collides with the editor's own Selection nudge shortcuts (Arrow keys) and Scene pan (Space) whenever a project maps those same codes, though only Escape/Enter were directly verified in this audit (toolbar surface).

### TOOLBAR-4 · defect · med
- Element: `.restart-badge-slot` ("Scene changed — Restart" badge) and its effect on toolbar layout
- Observed: When the badge appears mid-play (after a structural change), the whole toolbar reflows: the project name truncates further (e.g. "Ember Horde" → "Emb…") and "Every change saves automatically" wraps from one line to two/three lines, visibly overflowing the 46px toolbar bar (see screenshot comparison: before vs. after the badge appears). The `Toolbar.tsx` doc comment claims "the slot holds width:0 when idle so the toolbar doesn't reflow" — the CSS does not actually reserve that width, so the claim doesn't match behavior.
- Expected: The restart badge appearing should not cause other toolbar text to truncate further or wrap/overflow. Either reserve space for the badge's max width, or let other elements shrink gracefully without visual overflow.

### TOOLBAR-5 · defect · high
- Element: Toolbar responsive behavior at narrow viewport widths
- Observed: Tested at 1280px, 1024px, and 900px width. The toolbar has **no responsive handling whatsoever** — `overflow-x: visible`, `flex-wrap: nowrap`, and no width-based media query targets `.toolbar` anywhere in `styles.css`. Measured `scrollWidth`/`clientWidth` stay fixed at 1323px regardless of the 1280/1024/900px viewport, meaning the toolbar's natural content width already exceeds all three tested widths.
  - At 1280px: "Close project" text is clipped at the right edge; "Every change saves automatically" wraps to 3 lines, overflowing the toolbar's height.
  - At 1024px: Checkpoint/Review/Export/Close project are all pushed off-screen; no horizontal scrollbar appears anywhere to reach them.
  - At 900px: everything from the WS status dot rightward (Checkpoint, Review, Export, save-note, Close project) is completely inaccessible — there is no pointer or keyboard path to reach "Close project" at this width.
  Also worth noting: because `.toolbar-group`/flex children default to `flex-shrink: 1` (no explicit `flex-shrink: 0`), fixed-width elements like `.project-name` compress well below their own 220px `max-width` as the window narrows, compounding the truncation.
- Expected: At minimum, a horizontal scroll affordance on the toolbar so no control becomes permanently unreachable; ideally a defined narrow-width collapse (e.g. an overflow menu) so "Close project" and Export/Checkpoint/Review remain reachable down to common laptop widths (1280/1024).

### TOOLBAR-6 · friction · med
- Element: Undo / Redo — keyboard shortcut vs. toolbar button, console feedback
- Observed: Clicking the toolbar's Undo/Redo buttons logs a clear, specific message: `Undo: reverted "createEntity" (#44).` / `Redo: reapplied "createEntity" (#44).` The *identical* action triggered via the ⌘Z / ⇧⌘Z / ⌘Y keyboard shortcuts instead logs a generic, differently-capitalized summary: `undo: modified script, modified script, modified script, …` (verified via the Console panel content after a keyboard-triggered undo). This is because `keybinds.ts`'s bindings call `store.exec('undo'|'redo')` directly, bypassing the `quiet: true` + custom `log()` call that `Toolbar.tsx`'s own `undo()`/`redo()` wrapper functions add.
- Expected: The same user action (undo/redo) should produce the same quality of feedback regardless of whether it was triggered by clicking the button or pressing the shortcut.

### TOOLBAR-7 · friction · low
- Element: View menu / Scene-actions menu keyboard navigation
- Observed: Once either popover is open via click, pressing ArrowDown/ArrowUp does nothing — focus stays on the trigger button rather than moving into the menu items (verified: `aria-expanded` stays consistent, `document.activeElement` unchanged after 3× ArrowDown). Tab does move focus into the menu items, but that's just DOM order, not a designed roving-tabindex pattern. The buttons carry `role="menu"`/`role="menuitemcheckbox"`/`role="menuitem"`, which per ARIA authoring practices implies arrow-key navigation between items; that affordance is absent.
- Expected: Either drop the ARIA menu roles in favor of a plain listbox/button-group semantic that matches the actual (click-only, no roving-tabindex) interaction model, or implement Up/Down navigation to match the role's implied contract.

### TOOLBAR-8 · polish · low
- Element: "View" toolbar button
- Observed: Every other primary toolbar control has a `title` tooltip (Play/Stop, Pause/Resume, Step, Undo, Redo, Debug, Checkpoint, Review, Export, "+ Scene", the "⋯" Scene-actions button). "View" is the sole exception — `title` is `null`.
- Expected: A short tooltip like "View" menu items / layout options, for consistency with the rest of the toolbar's native-tooltip convention.

### TOOLBAR-9 · friction · low
- Element: View menu checkbox state vs. actual panel body on first project load
- Observed: On first opening a project, the View menu shows every panel checked (✓ Hierarchy, ✓ Inspector, ✓ Assets, ✓ Console, ✓ Changes, ✓ Agent, ✓ Input, ✓ Game Settings) while the Hierarchy, Inspector, Assets, Console, etc. panel bodies all simultaneously render "All panels are closed / Reopen them from the View menu in the toolbar." This is the known dockview stale-mount bug called out in the audit brief; toggling the affected panel off then on via the View menu forces a fresh mount and fixes it (verified — Hierarchy showed its entity tree correctly afterward). Filing it here because it's the View menu's own checkbox state visibly disagreeing with reality, undermining it as an at-a-glance status indicator on every fresh project open.
- Expected: The View menu's checked state should always match whether the panel is actually rendering content, or the underlying dockview mount issue should be fixed so this divergence can't happen.

## Verified working
- Wordmark ("Hearth" + flame icon) renders as static branding, not interactive — no defect.
- Project name shows full name at 1500px width with a native title tooltip carrying the project description; truncates via ellipsis if too long.
- Scene picker `<select>` lists all scenes, marks the initial one "(initial)", switches the active scene correctly on change.
- "+ Scene" button opens the New Scene modal; name field autofocuses, Enter submits, Cancel closes, Create is disabled until a name is entered; new scene is created and auto-selected.
- Scene-actions "⋯" button: disabled when no scene resolvable; opens a popover with Duplicate…/Rename…/Set as initial/Delete…, each with `role="menuitem"`.
  - Duplicate…: prefills a unique "<name> copy" name (uniqueName logic verified against existing scene names), "Also copy playtests" checkbox present, Cancel/Duplicate scene work, new scene created and selected.
  - Rename…: prefills current name, saves correctly, scene picker reflects new name immediately.
  - Set as initial: correctly disabled (with no visual affordance issue) when the current scene is already initial; correctly enabled and functional otherwise — moves the "(initial)" suffix to the new scene.
  - Delete…: correctly disabled with tooltip "Cannot delete the only scene in a project" when only one scene exists; enabled with 2+ scenes, confirms via modal, deletes and updates the picker.
  - Escape closes the popover and returns focus to the "⋯" trigger button (verified via `document.activeElement`).
- Play/Stop: click toggles correctly; switches the active tab to Game on Play; button restyles (orange primary → red "Stop"); Pause becomes enabled and Step stays disabled until paused; keyboard ⌘Enter toggles Play/Stop identically to the click.
- Pause/Resume: disabled while stopped; enabled while playing; click and ⇧⌘Enter both toggle Pause/Resume correctly (verified only fires while playing — the "playing" guard works).
- Step: disabled unless both playing and paused; visually correct disabled state at every combination tested.
- Restart badge: appears only when a structural change (verified via adding an entity through Hierarchy's "New entity" button) lands while playing; does not appear for the same action while stopped; clicking it restarts the run and clears the badge; Stop-then-Play never shows a stale badge. Functional logic is fully correct — see TOOLBAR-4 for the layout side-effect.
- Undo/Redo buttons: disabled state correctly tracks `useHistoryList`'s cursor (`undoTarget`/`redoTarget`); clicking performs the action and logs a friendly, specific message; ⌘Z/⇧⌘Z/⌘Y all functionally undo/redo correctly (verified via Redo-button disabled-state transitions) — see TOOLBAR-6 for the console-message inconsistency.
- Debug toggle: click and `aria-pressed` correctly flips false↔true; visual state (orange when active) matches.
- View menu: opens/closes via click; every panel listed with correct checkmark reflecting dockview's actual panel set; toggling a panel does not auto-close the menu (lets you batch-toggle several panels, confirmed intentional since only "Reset layout" and "Keyboard shortcuts" explicitly close it); "Reset layout" restores the default panel arrangement and closes the menu; "Keyboard shortcuts" item opens the shortcut sheet and shows the `?` accelerator hint.
- WS status dot: shows the connected green state (`ws-dot-connected`, appropriate `aria-label`/`title` "Connected to project server") while the dev server is reachable.
- Checkpoint: click saves a checkpoint and logs "Checkpoint saved. The Changes panel now compares against this checkpoint."; ⇧⌘S does the same.
- Review: click opens the Changes panel and shows the correct history list plus a "Restore checkpoint" control (correctly disabled immediately after taking a fresh checkpoint).
- Export: opens a dialog with Web/Desktop tabs, Web-build-folder vs. Single-HTML-file format radios, an editable output directory field, a "Zip for itch.io" checkbox, and Cancel/Export actions — all present and visually consistent with the rest of the app's modal styling.
- Close project: click returns cleanly to the project launcher (no confirmation prompt, consistent with "every change saves automatically"); the just-closed project appears at the top of the launcher's Recent list.
- Shortcut sheet (`?` / Shift+/): opens via keyboard; content is generated straight from `KEYBINDS`, and every group/label/combo shown matches the source table (General/Scene/Selection, verified all rows via DOM dump). Pressing `?` again toggles it closed; clicking the backdrop closes it; the in-dialog "Close" button closes it; reopening via the View menu's "Keyboard shortcuts" item works. (Escape is broken — see TOOLBAR-2.)
- Spot-checked binds, all functioning as documented in the sheet: ⌘Enter (Play/Stop), ⇧⌘Enter (Pause/Resume, gated on playing), ⌘Z (Undo), ⇧⌘Z (Redo), ⌘Y (Redo alternate), ⇧⌘S (Checkpoint), Shift+/ (shortcut sheet toggle) — 7 of the requested ~8 verified via real state transitions (button disabled-state and toolbar text changes), plus the Enter/Space button-activation behavior investigated in depth as an 8th (see TOOLBAR-3).
- Full scene lifecycle end-to-end with 2 scenes present: create → switch via picker → set-as-initial → rename → duplicate → delete, each step confirmed against the scene picker's option list.

## Not covered
- Screen-reader/AT testing beyond ARIA role/attribute inspection (no VoiceOver/NVDA pass performed).
- Actually completing a full Export run (build folder generation) — only verified the dialog opens with correct controls; didn't click through to a real export or check its "Desktop" tab's contents.
- Non-Mac (Windows/Linux) `comboDisplay` rendering (Ctrl+ instead of ⌘) — audited on macOS/Chrome only, code path for `isMac === false` was read but not exercised in-browser.
- Gamepad-mapped shortcuts and the Input Settings panel's key-capture UI (out of toolbar surface; only used to trace the TOOLBAR-2/3 root cause).
- Full ripple effect of the `attachKeyboard` bug beyond Escape/Enter (e.g. whether Arrow-key nudge or Space-pan in the Scene view also gets shadowed for projects that map those codes) — flagged as a plausible related risk in TOOLBAR-3 but not directly exercised, since Selection/Scene shortcuts are outside this surface.
- Visual regression across browsers other than Chrome/Chromium.
