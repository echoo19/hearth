# Audit: console-changes (example: ember-horde, port 5218)

Surface: `apps/editor/src/components/ConsolePanel.tsx` + `DiffPanel.tsx` + `useHistoryList.ts`.

Environment note (not a console-changes finding, but blocked all testing until fixed):
the shared dev server failed to start with a Vite/PostCSS overlay —
`@fontsource-variable/bricolage-grotesque` is declared in
`apps/editor/package.json` but was never installed (only its sibling
`@fontsource-variable/archivo` was present in `node_modules`). Ran
`npm install @fontsource-variable/bricolage-grotesque@^5.2.10 --workspace=apps/editor`
to fix it — this is shared infra, so the fix benefits every other auditor too.

## Findings

### CONSOLE-CHANGES-1 · defect · high
- Element: Console auto-scroll (`ConsolePanel.tsx`'s `useEffect(() => { el.scrollTop = el.scrollHeight }, [entries.length])`)
- Observed: The effect is keyed on `entries.length`. `consoleEntries` is capped
  at `MAX_CONSOLE = 500` (store.ts: `consoleEntries: [...state.consoleEntries.slice(-MAX_CONSOLE + 1), makeEntry(...)]`),
  so once 500 entries have ever accumulated, `entries.length` is pinned at 500
  forever after — new entries still arrive and old ones are evicted, but the
  *length* never changes again, so the effect never re-fires. Repro: play the
  300-enemy horde with a script logging every frame (I added
  `ctx.log(ctx.entity.name .. " chasing")` to `enemy-chase.lua`'s `onUpdate`,
  throttled to every 30 frames) for ~10s. Result: `console-line` count hit
  exactly 500, and `scrollTop` was `542` out of a `scrollHeight` of `10707`
  (`clientHeight` 197) — nowhere near the bottom, frozen mid-list even though
  the runtime kept emitting entries underneath. A manual `scrollTop = 0` after
  that point held indefinitely (no snap-back), confirming the effect had gone
  fully dormant, not merely respectful of user scroll.
- Expected: Auto-scroll should track new content regardless of whether the
  list has been truncated. Keying the effect on the last entry's `id` (or a
  monotonic append counter) instead of `entries.length` would fix both this
  and finding 2 below in one change.

### CONSOLE-CHANGES-2 · friction · med
- Element: Console auto-scroll (same effect as #1), low-volume case
- Observed: Before the 500-cap is hit, the effect fires on *every* new entry
  with no user-scroll-position check: I scrolled to `scrollTop = 0` and then
  triggered one more log line (clicking "Validate project"); the panel
  immediately snapped back to the bottom (`scrollTop` went from `0` to `228`,
  the exact max). There is no scroll-lock — the view only "stays put" if the
  user is already at the bottom.
- Expected: Auto-scroll should only fire when the user was already at (or
  near) the bottom before the new entry arrived — the standard scroll-lock
  pattern (e.g. terminal/chat UIs). Right now, scrolling up mid-session to
  reread an earlier error is fought by literally any subsequent log line,
  which is exactly what happens continuously during a chatty run.

### CONSOLE-CHANGES-3 · defect · med
- Element: Console error entry for a **script load failure at scene
  start/Play** (as opposed to a live hot-reload failure)
- Observed: Broke `shake-toggle.lua`'s syntax (removed the closing `end`)
  before opening the project, then pressed Play. The scene mounts, the
  broken script fails to compile, and the Console shows: `Script hit an
  error in scripts/shake-toggle.lua — Failed to load script
  scripts/shake-toggle.lua: scripts/shake-toggle.lua:14: 'end' expected (to
  close 'function' at line 6) near <eof>`. The error *message* clearly
  contains the line (`:14`), but the entry's clickable link renders as bare
  `scripts/shake-toggle.lua` with **no line number** — `link.line` is null.
  Clicking it opens the file at the top, not line 14.
- Expected: This is inconsistent with the *reload*-path failure (finding 5
  below), which correctly extracts and links the line for the exact same
  class of Lua parse error. The load-time path should use the same
  line-extraction logic reload uses.
- Contrast (verified correct): a mid-session hot-reload failure for the
  identical error shape (`'end' expected...`) produced a link labeled
  `scripts/resume-button.lua:17`, and clicking it correctly scrolled the Code
  panel to line 17 with the ember-flash highlight. So the extraction logic
  exists and works — it's just not applied on the initial-load path.

### CONSOLE-CHANGES-4 · defect · med
- Element: Console entries for a hot-reload compile failure while playing
- Observed: Introduced a syntax error in `resume-button.lua` (deleted the
  closing `end`) via the Code panel, saved with Cmd+S while the game was
  playing (with Code split into its own dock group so the Game tab stayed
  visible — see finding 6, this is required to reach this path at all). The
  Console logged **two** near-identical entries for the single failure:
  `Script hit an error in scripts/resume-button.lua:17 — ...'end' expected...`
  (source `runtime`, via `recordRuntimeError`/`onErrorEntry`) immediately
  followed by `Hot-reload failed: scripts/resume-button.lua:17 —
  ...'end' expected...` (source `runtime`, via `applyReload`'s own direct
  `get().log(...)` in store.ts). Both fire because `PixiSceneView.reloadScript`
  both (a) returns `{ok:false,...}` to the caller, which `applyReload` logs
  itself, and (b) internally calls `recordError`, which independently
  bridges to `onErrorEntry` → `recordRuntimeError` → another log call.
- Expected: One user-visible line per failure. Right now every hot-reload
  error doubles the Console noise, which compounds with findings 1/2 during
  a busy session.

### CONSOLE-CHANGES-5 · defect · high
- Element: Checkpoint (⇧⌘S global shortcut) and the main Toolbar's
  "Checkpoint" button, vs. the Changes panel
- Observed: `store.ts`'s `checkpoint()` (bound to the ⇧⌘S keybind) and
  `Toolbar.tsx`'s own `snapshot()` (the main toolbar's "Checkpoint" button)
  both call `exec('snapshotProject', ...)` and then log "Checkpoint saved.
  The Changes panel now compares against this checkpoint." — but **neither
  calls `refreshDiff()`**. If the Changes panel is already the focused tab
  when either of these fires, the panel keeps showing the *previous* diff
  state (or the stale "No checkpoint to compare against" empty state)
  instead of what the console message promises, until the user manually
  clicks "Refresh changes" or switches tabs away and back (which triggers
  `onDidActivePanelChange` → `refreshDiff()`). Verified: pressed ⇧⌘S with
  Changes focused and showing "No changes since the last checkpoint" from a
  prior checkpoint — after the shortcut, "Restore checkpoint" was still
  disabled and the panel text was byte-for-byte unchanged, even though a
  fresh checkpoint had genuinely just been taken server-side.
- Expected: Both call sites should call `refreshDiff()` on success, exactly
  like `DiffPanel.tsx`'s own local `snapshot()` (its in-panel "Checkpoint"
  button) already does correctly.

### CONSOLE-CHANGES-6 · defect · high
- Element: Undo / Redo (both the Changes-panel buttons and the main
  Toolbar's Undo/Redo), interaction with the diff body
- Observed: Same root issue as #5, different call sites. `DiffPanel.tsx`'s
  `undo()`/`redo()` exec `'undo'`/`'redo'` and log a message, but never call
  `refreshDiff()`. The History list *does* update live (it's reloaded via
  `useHistoryList`'s `commandSeq` dependency), but the diff summary/body does
  not. Verified: checkpointed, nudged the Player entity right by 1px,
  clicked "Refresh changes" (diff correctly showed `Transform.position.x:
  405→406`), then clicked "Undo" without switching tabs — the diff body was
  byte-for-byte identical to before the Undo (`405→406` still displayed),
  even though the position had actually reverted server-side. A manual
  "Refresh changes" click afterward corrected it.
- Expected: The Changes panel should reflect the true current diff
  immediately after Undo/Redo, not just after a manual refresh or a tab
  blur/refocus. This is a real workflow gap: reviewing a diff and undoing an
  edit to watch it shrink is a natural interaction, and right now it lies
  to the user until they notice and manually refresh.

### CONSOLE-CHANGES-7 · friction · med
- Element: Editing a script (Code panel) while the game is playing, in the
  default (unsplit) layout
- Observed: `Workspace.tsx`'s `GamePanelHost` calls
  `props.api.onDidVisibilityChange(({isVisible}) => { if (!isVisible)
  setPlaying(false) })` — i.e. the moment the Game tab is hidden (because
  Scene/Game/Code share one tab group and the user switched to Code to make
  an edit), the entire run is silently stopped (verified: toolbar's
  Play/Stop button read "Stop" right after Play, then read "Play" again
  merely from clicking the Code tab — no Stop button was pressed). Since
  hot-reload-while-playing only runs `if (get().playing)`, this means the
  single most natural workflow for exercising this audit's own "compile
  error via hot-reload" requirement — keep the game running, tab to Code,
  fix a bug, save, watch it hot-reload — is unreachable by default: opening
  Code to make the edit auto-stops the run before Cmd+S ever executes, and
  the user gets **zero feedback** that this happened (no console line, no
  toast, just a Play button that quietly changed state off-screen). I only
  got hot-reload to fire at all (finding 4) by manually dragging the Code
  tab out of the Scene/Game/Code group into its own dock panel first.
- Expected: At minimum, some visible signal when Play silently stops because
  of a tab switch (today it's indistinguishable from the user having pressed
  Stop themselves). Better: don't couple "hot-reload capability" so tightly
  to Game-tab visibility, since the Code and Game panels default to sharing
  a tab strip and most users will never think to split them.

### CONSOLE-CHANGES-8 · friction · med
- Element: Undo/redo History list rows (`.history-row` in `DiffPanel.tsx`'s
  `HistorySection`)
- Observed: Each row is a plain `<div>` with no `onClick` handler at all —
  clicking a history row does nothing (verified: captured panel-body
  innerText before/after clicking the first row, byte-identical). Rows show
  a `seq` number that maps 1:1 to an undo/redo target, so click-to-jump reads
  as a natural, expected affordance that simply isn't there.
- Expected: Either make rows clickable (jump the undo cursor to that point)
  or, if that's out of scope, the rows shouldn't look interactive (no hover
  state is shown either way today, so this is at least visually consistent —
  just noting the capability gap explicitly since the audit brief asked to
  check for it).

### CONSOLE-CHANGES-9 · polish · low
- Element: Console panel, no log-level filter/search
- Observed: `ConsolePanel.tsx`'s toolbar has exactly two controls: "Validate
  project" and "Clear". There is no way to filter by level (info/warn/error)
  or by source (command/runtime/validate/editor), and no text search. With
  only 3 levels this is a lesser concern normally, but combined with findings
  1/2/4 (auto-scroll breaking + duplicate entries under load), a chatty
  session gives the user no way to cut through the noise to just the errors.
- Expected: At minimum a level filter (or "errors only" toggle) would let a
  user recover from a spammy run without scrolling through hundreds of lines
  manually.

### CONSOLE-CHANGES-10 · polish · low
- Element: Console entries, copy affordance
- Observed: No per-entry or bulk "copy" button/icon anywhere in
  `ConsolePanel.tsx`. Getting an error message out (e.g. to paste into a bug
  report or hand to an agent) requires manual text selection across a flex
  row (time/source/message/link spans), which is workable but not a
  one-click action the way "click the link to jump to code" is.
- Expected: A small per-row copy icon (or "Copy all" in the toolbar) would
  match the one-click ethos the link affordance already sets.

### CONSOLE-CHANGES-11 · polish · low
- Element: Duplicate console entries from React StrictMode double-mount
  (dev only)
- Observed: In dev, `GamePreview`'s mount effect can run twice for the same
  Play (documented elsewhere in the codebase as a known StrictMode
  double-invoke pattern), which produces exact duplicate "Script hit an
  error in..." lines for the same single failure (seen twice, 6s apart, for
  the same `shake-toggle.lua` load failure across two different fresh-Play
  runs). This compounds with finding 4's own doubling. Likely dev-only
  (StrictMode doesn't double-invoke in production builds) so lower priority,
  but worth a note since it makes the "how many times did this actually
  fail" signal unreliable while developing the engine itself.
- Expected: Not necessarily fixable outside of guarding the mount effect;
  flagged for awareness rather than as an actionable UI fix.

## Verified working

- Console empty state: icon + "Console is quiet" + descriptive hint,
  correct copy, shown only when `entries.length === 0`.
- Console "Clear" button: correctly disabled at 0 entries, enabled once
  entries exist, and clears back to the empty state on click.
- Console entry level styling: `info` (default ink), `warn` (amber dot +
  amber message text), `error` (red dot + red message text + faint red row
  background) all render correctly — confirmed via `validateProject`
  warnings and runtime errors.
- `ConsoleLink` (`path:line` clickable suffix): renders as a real `<button>`
  (keyboard reachable, focus-visible ring per code), correctly opens the
  Code panel and scrolls + flashes the exact line when `link.line` is
  populated (verified for both a mid-session hot-reload failure at line 17
  and a runtime hook error at line 49).
- Runtime error formatting (`formatRuntimeError`): correctly produces
  "`<Entity>` hit an error in `<script>:<line>` — `<message>`" when the
  entity is known (verified: "Player hit an error in
  scripts/player-move.lua:49 — attempt to index a nil value (field
  'nonexistentTable')" after injecting a deliberate crash into
  `onCollision`), and falls back to "Script hit an error..." when the entity
  is unknown (compile/load failures).
- Console tab unread badge (`consoleUnread`): correctly increments on each
  `error`-level log while the Console tab isn't the visible/active panel
  (verified badge showing "8" after switching away and letting 8 collision
  crashes accumulate), and correctly clears to no badge the moment the
  Console tab is clicked/focused (`setConsoleOpen`/`onDidVisibilityChange`
  wiring in `Workspace.tsx`'s `ConsolePanelHost`).
- Console entry cap (`MAX_CONSOLE = 500`): confirmed the list truncates to
  exactly 500 entries under sustained high-volume logging (300-enemy horde
  with a per-enemy `ctx.log` every 30 frames), oldest entries correctly
  evicted first.
- `validateProject` flow: "Validate project" button correctly logs one line
  per issue (`warn` for warnings, `error` for errors) plus a final summary
  line, using the `[CODE] message` format from the validation report.
- Mod+S ("Save"): correctly recognized as a no-op that only logs "Your
  changes are saved automatically — no need to save." and does **not**
  create/refresh a checkpoint — confirmed distinct from ⇧⌘S.
- DiffPanel baseline rendering: `added`/`removed`/`modified` all render with
  correct color coding (`diff-added` green, `diff-removed` red, `diff-modified`
  amber) and correct before→after arrows for field changes; verified for
  entity moves (`Transform.position.x: 400→405`) and via a 60-entity
  duplication burst (410 total `.diff-row` elements rendered).
- DiffPanel empty states: "No checkpoint to compare against" (before any
  checkpoint) vs. "No changes since the last checkpoint" (after a checkpoint
  with no edits) are distinct, correctly worded, and correctly toggle.
- Undo/Redo button labels: dynamically show the target command name ("Undo
  moveEntity" / "Redo moveEntity"), correctly disable when there's nothing
  to undo/redo, and correctly enable/relabel after an Undo makes a Redo
  target available.
- Revert flow: "Restore checkpoint" is disabled when `diff.hasChanges` is
  false, opens a `ConfirmDialog` with the expected copy ("All scene, script,
  and asset-index changes since the last checkpoint are discarded. A revert
  isn't recorded in the undo history, so it can't be reversed with Undo —
  unlike other edits."), and on confirm correctly resets the diff to "No
  changes since the last checkpoint" (this path — unlike Undo/Redo/Toolbar
  Checkpoint — does correctly call `refreshDiff()` after the exec).
- Post-revert Undo: clicking "Undo" after a revert did not error or corrupt
  state (it replayed the inverse of the last journal entry against the
  now-reverted project without incident) — a plausible edge case, sanity
  checked though not exhaustively probed.
- Long-diff performance: a 410-row diff (60 duplicated entities) rendered
  and scrolled with no perceptible lag (sub-second for both refresh and
  scroll-to-bottom) — fine at this scale, though `DiffBody` has no
  virtualization so this isn't a guarantee at much larger scales.
- History list entries render with the correct `#seq command` format and
  correctly dim (`history-row-undone`) once undone/ahead-of-cursor.
- Dockview's documented "All panels are closed" bug (per AUDITOR-COMMON.md
  setup notes) reproduced on first project open for the whole bottom tab
  group (Assets/Console/Changes/Agent/Input/Game Settings) and for
  Hierarchy/Inspector; toggling each affected panel off/on via the View menu
  reliably forced a fresh mount and fixed it for the session.

## Not covered

- Exact OS-clipboard copy fidelity (whether a real drag-select + Cmd+C of a
  console row preserves the same field separation `innerText()` reports) —
  not verifiable through Playwright's automation-focused clipboard access
  within the time budget; noted the absence of a dedicated copy button
  instead (finding 10).
- Deeper post-revert Undo/Redo semantics (e.g. redoing several steps after a
  revert, or reverting mid-way through a long undo chain) — only did a
  single-step sanity check (see "Verified working"); this looked like a
  promising area for a dedicated defect but I didn't have a clean repro
  showing actual corruption, just the same stale-diff symptom as finding 6.
- DiffPanel/Console behavior with genuinely large scenes (hundreds of authored
  entities, not just 60 duplicates) — the 300-enemy horde itself doesn't
  stress this path since Play-spawned enemies are runtime-only and never
  reach the authored scene.json / diff engine; would need bulk `createEntity`
  exec calls to push `DiffBody`'s lack of virtualization further.
- `checkScript` inline diagnostics (the live squiggly-underline linting in
  the Code panel) — out of surface (that's CodePanel/CodeEditor, not
  Console/Changes), only touched it insofar as it interacts with the "Format
  on save" warning path.
- Whether the Toolbar's Undo/Redo buttons (as opposed to DiffPanel's own)
  share the exact same stale-diff-after-refresh bug as finding 6 — they call
  the same `exec('undo'/'redo', ...)` path so almost certainly yes, but I
  only directly instrumented DiffPanel's buttons.
