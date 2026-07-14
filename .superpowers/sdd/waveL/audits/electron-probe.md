# Audit: electron-probe  (example: ember-trail (Lua), packaged Electron app — no vite port)

Surface: divergences between the dev editor (`npm run dev`) and the packaged
Electron app (`apps/editor/dist-electron/main.cjs`). Built fresh from current
source (`npm run build` then `npm run app:bundle`) rather than reusing any
stale `dist/`/`dist-electron/` output, specifically to exercise the new
split `src/styles/` tree + `@fontsource-variable/bricolage-grotesque` (T2)
through a real production build. Driven with `playwright-core`'s `_electron`
against the actual packaged bundle (not `ELECTRON_START_URL` pointing at
Vite) plus `HEARTH_SMOKE=1`. Scratch project: a copy of
`packages/examples/ember-trail` (all-Lua) at
`/private/tmp/waveL-audit-electron-probe/ember-trail`.

## Findings

### ELECTRON-1 · defect · med
- Element: packaged app's static file server (`startServer()` /
  `MIME` table in `apps/editor/electron/main.ts:27-36`)
- Observed: `apps/editor/electron/main.ts`'s hand-rolled `MIME` lookup table
  has no `.wasm` entry:
  ```
  const MIME: Record<string, string> = {
    '.html': ..., '.js': ..., '.css': ..., '.svg': ..., '.png': ...,
    '.ico': ..., '.json': ..., '.woff2': 'font/woff2', '.map': ...,
  };
  ```
  Any `.wasm` asset therefore falls through to the `?? 'application/octet-stream'`
  default (main.cjs:62). wasmoon's Lua engine (`glue.wasm`, built to
  `dist/assets/glue-*.wasm` and fetched via `wasmoon/dist/glue.wasm?url` in
  `src/runtimeBridge.ts`) calls `WebAssembly.compileStreaming`, which
  strictly requires `Content-Type: application/wasm` — Chromium rejects the
  octet-stream response and the devtools console logs, every single time a
  Lua project's runtime spins up in the packaged app:
  ```
  wasm streaming compile failed: TypeError: Failed to execute 'compile' on
  'WebAssembly': Incorrect response MIME type. Expected 'application/wasm'.
  falling back to ArrayBuffer instantiation
  ```
  Reproduced twice, deterministically, across two separate app launches
  (4 occurrences per run — one pair per Lua context spin-up).
  Confirmed **electron-specific**: Vite's dev/build static serving sets
  correct MIME types for `.wasm` out of the box, so `npm run dev` /
  `ELECTRON_START_URL` mode never hits this path — only the packaged app's
  own `http.createServer` static handler does.
- Expected: `.wasm` should map to `application/wasm` so
  `WebAssembly.compileStreaming` succeeds on the fast path instead of
  silently degrading to the slower `ArrayBuffer` instantiation path on every
  Lua-script load. The game still runs correctly (see ELECTRON-1's non-impact
  on Play below — this is graceful degradation, not a functional break), but
  it's console-error noise on every single launch of a Lua project in the
  shipped app, and would matter more as wasm payload size grows. One-line
  fix: add `'.wasm': 'application/wasm'` to the `MIME` map at
  `apps/editor/electron/main.ts:27`.

### ELECTRON-2 · polish · low
- Element: same `MIME` table (`apps/editor/electron/main.ts:27-36`)
- Observed: `.woff2` is mapped but plain `.woff` is not, even though
  `@fontsource/ibm-plex-mono` ships both formats (confirmed in the fresh
  `vite build` output: `ibm-plex-mono-*-400-normal-*.woff` files are part of
  the built asset set).
- Expected: currently harmless in practice — Electron's bundled Chromium
  always accepts `woff2` and browsers fetch only the first working
  `@font-face src` entry, so the `.woff` fallback is never actually
  requested — but it's a latent completeness gap in the same table as
  ELECTRON-1. Worth closing in the same edit for correctness's sake.

### ELECTRON-3 · defect · low (likely NOT electron-specific — flag for cross-check)
- Element: Pixi asset loader via the shared `/api/file?project=...&path=...`
  route (used identically by dev and packaged modes; not part of Electron's
  own static server)
- Observed: opening ember-trail and reaching gameplay assets triggers, in
  the devtools console:
  ```
  PixiJS Warning: [Assets] http://127.0.0.1:<port>/api/file?project=...&path=assets%2Fsprites%2Fwisp.svg
  could not be loaded as we don't know how to parse it, ensure the correct
  parser has been added
  ```
  Root cause is almost certainly that `/api/file`'s URL has no real
  extension in its own pathname (the extension lives inside the `path=`
  query param, not the URL path Pixi's default format-sniffing inspects) —
  this is a property of the shared project-server route, identical in dev
  and packaged builds, not something introduced by Electron packaging.
- Expected: flagging for the assets/sceneview surface auditor(s) to confirm
  and own — did not chase further since it's outside this surface's
  dev-vs-packaged mandate; wisp.svg is a gameplay sprite in ember-trail's
  Play scene, not something I exercised past the title/menu screen.

### ELECTRON-4 · defect · low, unconfirmed scope (flag for cross-check, not scored against this surface)
- Element: CodeMirror script editor (`.cm-content`) text input, packaged app
- Observed: driving literal per-keystroke synthetic typing
  (`page.keyboard.type(text, { delay: 60 })`) into an open `.lua` script
  reproducibly drops/garbles characters — e.g. typing
  `local probeEditSlow    =   42` twice (once at default speed, once with an
  explicit 60ms per-key delay) both landed on disk as garbage
  (`loclprobit=42` / `loclprobitlo=42`), not the typed text.
  **However**: switching to `page.keyboard.insertText(...)` (single paste-like
  insertion, bypassing per-keydown event dispatch) for the same edit
  produced byte-perfect results, and the subsequent Format & save round-trip
  (ELECTRON verified-working item, below) was also byte-perfect. This
  strongly suggests the corruption is an interaction between CodeMirror's
  autocomplete popup (`@codemirror/autocomplete`, live-filtering as `local`
  types) and literal rapid keydown-event simulation, not something specific
  to the Electron bundle — the same `CodeEditor.tsx` + autocomplete wiring
  runs unchanged in dev mode.
- Expected: could not confirm or rule out reproduction in `npm run dev`
  within this surface's time budget (a throwaway `vite --port 5299` attempt
  hit an unrelated stale-`packages/core/dist` build error, likely from
  another auditor's concurrent rebuild, and was abandoned rather than
  chased). Flagging explicitly for whichever auditor owns the Code
  panel/CodeEditor surface to confirm against dev mode — if it reproduces
  there too, it's a real (if narrow, synthetic-typing-speed-triggered) data
  integrity bug worth a proper look, not an electron-probe finding.

## Verified working
- `npm run build` (tsc typecheck + `vite build`) succeeds cleanly against
  current `main` with the new `src/styles/` split-CSS tree +
  `@fontsource-variable/bricolage-grotesque` — no import/resolution errors;
  output includes `index-*.css` (173 KB) with Archivo, IBM Plex Mono, and
  Bricolage Grotesque woff2 assets all present.
- `npm run app:bundle` (esbuild main-process bundle) succeeds; only
  pre-existing `import.meta` warnings (unrelated to this wave — same 3
  warnings, same files, present before this wave's CSS work).
- `HEARTH_SMOKE=1 npx electron .`: exits 0. `/api/meta` responds through
  the real in-process server, window loads `http://127.0.0.1:<port>/`,
  `@lydell/node-pty` loads and a real PTY spawn+echo round-trip succeeds —
  confirms the native node-pty module (asarUnpack'd, ad-hoc re-signed)
  actually works in a from-scratch build, not just a cached one.
- Launcher (project-manager window) renders correctly in the packaged app:
  Bricolage-styled "Hearth" wordmark, tagline, New Project card (Name,
  Location + "Browse…" native-picker button, Description, 4 template
  cards, Create project), Open a Project card (typed-path input + "Open" +
  "Open Folder…" native-picker button, Recent projects list with real
  paths from other auditors' concurrent sessions).
- Open-a-project via typed absolute path + "Open" button: works, project
  loads, window grows from compact project-manager size into the maximized
  full editor and retitles to the project name ("Ember Trail — Hearth").
- Full editor workspace renders with the new CSS/fonts: toolbar
  (Play/Pause/Step/Undo/Redo/Debug/View/Checkpoint/Review/Export/Close
  project), Scene/Game/Code tabs, Hierarchy/Inspector docked panels, bottom
  tab group (Assets/Console/Changes/Agent/Input/Game Settings).
- Known dockview "All panels are closed" bug (documented in
  AUDITOR-COMMON as cross-surface, not electron-specific) reproduced here
  too, on first project open. `View > Reset layout` did **not** fix it in
  this surface (3 panel groups still stuck after Reset layout); a full
  renderer reload (`page.reload()`) did cleanly fix it, re-mounting
  Hierarchy/Inspector/bottom-tab-group with live content. Noting the extra
  data point (Reset layout ≠ fix) for whoever owns that cross-cutting bug.
- Code tab → "Open a script…" select correctly lists all 4 project scripts
  (`best-label.lua`, `ember-spawner.lua`, `player-move.lua`,
  `start-button.lua`) and opens the selected one into a `.cm-editor`
  CodeMirror surface with correct Lua syntax highlighting.
- **Format & save round-trip** (the specific bundle-dependent risk called
  out in the dispatch — the StyLua-wasm inline shim in `main.cjs`):
  confirmed genuinely working, not just "saves as-is". Inserted
  deliberately malformed valid Lua (`local   badlyFormatted={x=1,y=2}`) via
  `insertText`, clicked "Format & save", and the file on disk came back
  correctly normalized to `local badlyFormatted = { x = 1, y = 2 }` —
  StyLua actually ran inside the packaged app's bundled main process.
  (An earlier attempt that inserted a statement *after* `return script`
  triggered a — correct — StyLua parse-error fallback, "saved as-is" with a
  `FORMAT_FAILED` warning surfaced in the app's own in-app Console panel;
  that was invalid Lua on my part, not an app bug, and it usefully proved
  the app's own Console panel is where `ctx.warn()`-level command warnings
  surface, separate from the devtools console.)
- Plain script save round-trip (edited existing `best-label.lua`, saved):
  content landed on disk exactly as edited.
- "Format on save" checkbox: default `true` on a fresh-opened script,
  toggleable.
- Play button: launches the Game tab, renders the ember-trail title/menu
  scene ("Ember Trail" / "Collect the embers before they fade" / Start
  button / "Best: 0"). The "Best: 0" text is written at runtime by
  `best-label.lua`'s `script.onStart` (`ctx.load("best")` →
  `string.format("Best: %d", best)`) — this is live proof the Lua
  wasm runtime actually executed successfully end-to-end in the packaged
  app, despite the ELECTRON-1 streaming-compile fallback (which is silent
  to the user and doesn't block execution).
  Stop button correctly halts the preview.
- Agent panel: renders correctly (Claude Code agent selector, "Safe edit"
  mode selector, Start agent/Stop buttons, "Idle" status, Checkpoint/Review
  changes controls, and a live changelog entry — "editScript · just now" —
  from the format-and-save probe above, confirming the agent panel's
  change-tracking sees edits made through the regular Code tab too).
  Did not actually start a live agent session (would need real Claude Code
  CLI credentials/network — out of scope; the PTY prerequisite itself is
  covered by the HEARTH_SMOKE node-pty round-trip above).
- Web export from the packaged app: Export dialog opens (Web/Desktop
  segmented control, Web build folder / Single HTML file radio choices,
  project-relative output dir field, "Zip for itch.io" checkbox), running
  it against ember-trail produced "Exported 7 files" to
  `export/web/` with `index.html`, `hearth-player.js` (1.3 MB, Lua wasm
  inlined via the same lua-wasm-inline shim — no separate `.wasm` file, so
  exported games are unaffected by ELECTRON-1), `project.bundle.json`, and
  the project's sprite/sound assets — verified all 7 files exist on disk
  with the right structure.
- New Project (typed-path variant): filled Name + Location fields, clicked
  "Create project" — project scaffold (`hearth.json`, `scenes/`,
  `scripts/`, `assets/`, `assets.json`, `.gitignore`, `AGENTS.md`,
  `CLAUDE.md`, `.hearth/` with `agent-config.json` + `log`) was created on
  disk at the slugified path (`probe_project/`), window transitioned into
  the editor for the new project, zero page errors.

## Not covered
- Native OS file-picker dialogs ("Open Folder…" on the launcher,
  "Browse…" next to the create-project location field, and
  `dialog.showOpenDialog` more generally): confirmed present, correctly
  labeled, and rendered — did not click them, since Playwright can't drive
  a real macOS native folder-picker sheet and doing so would block the
  Electron main process waiting on user input with no way to dismiss it
  headlessly. The typed-path equivalents for both Open and Create were
  fully exercised instead.
- `dev.hearth.editor` full installer/DMG paths (`app:dist`,
  `app:dist:installers`, code-signing/notarization, Gatekeeper flows): out
  of scope for this probe (dispatch's `app:bundle` + direct `electron .`
  invocation only); not exercised.
- Starting a real Agent-panel session end-to-end (spawning Claude Code CLI
  through the PTY and completing an actual agent turn): the PTY substrate
  itself is verified (HEARTH_SMOKE's node-pty spawn+echo, and the panel's
  UI rendering), but a full live session needs real CLI credentials/network
  access this sandbox doesn't have.
- Whether ELECTRON-3 (Pixi SVG parse warning) and ELECTRON-4 (CodeMirror
  synthetic-typing corruption) reproduce in `npm run dev`/browser mode —
  both are flagged above as likely NOT electron-specific but couldn't be
  confirmed against dev mode within this surface's time budget (a
  throwaway `vite --port 5299` attempt hit an unrelated, apparently
  transient `packages/core/dist` build error from concurrent work
  elsewhere in the shared repo checkout).
- Desktop export target (`hearth export desktop`) from the packaged app —
  only Web export was exercised, per the dispatch's explicit list of
  probes ("web export from the packaged app").
- Windows/Linux packaged-app behavior — this probe ran entirely on macOS
  (darwin/arm64); the dispatch's build/smoke commands and this report are
  macOS-only.
