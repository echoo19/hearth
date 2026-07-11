# Wave H — Iteration Loop (v0.11.0)

Date: 2026-07-10. Status: approved by Jake (all four decision points +
architecture). Backlog source: Road-to-1.0 Wave H (iteration loop) in
`2026-07-02-v0.3-engine-systems-backlog.md` §Road-to-1.0, plus on-theme
ledger minors from the Wave G tail.

Theme: **write→play→tweak becomes professional.** The Stop/Play dance
dies: scripts hot-reload during play, Inspector edits apply live,
runtime errors click through to the exact line, saving formats the
code, and the Code panel grows tabs, hover docs, and cross-script
find/replace. Every item doubles for agents: hot-reload = cheaper
iteration; error→line = faster self-fixes; format/search/replace are
commands first.

Standing rules apply: every system ships CLI/MCP-first; no engine
chrome in shipped games; anti-bloat is binding; human-facing copy
plain-language, agent-facing names unchanged; snapshot-shape changes
get same-day old-format upgrade tests.

Decisions locked with Jake:
1. **Hot-reload preserves state** — vars/timers/tweens survive,
   `onStart` does not re-run; Stop/Play stays the clean-slate path.
2. **Live patch is dual-write** — one edit hits the saved project AND
   the running game; no sandbox mode, no keep-changes prompt.
3. **Formatting is opinionated and on by default** — fixed Hearth
   style (StyLua + Prettier defaults), no config files honored;
   per-project setting to disable format-on-save.
4. **Scope includes the on-theme ledger minors + end-of-wave polish.**

---

## Architecture — how changes reach the running game

The play view is in-page Pixi mounted via `mountGameView()` with
direct object refs (`gameViewRef.ts`); it plays a **baked snapshot**
loaded from saved project files at Play. External agent mutations
already stream into the editor as journal entries over `/api/ws`.

**Chosen approach: direct-ref patching.** `MountedGameView` (and under
it `SceneRuntime` / `PixiSceneView`) gains imperative methods:

- `reloadScript(path, source)` — recompile + hot-swap (Pillar 1)
- `patchComponentProperty(entityId, componentType, propertyPath, value)`
- `patchSceneSettings(partial)` — ambientLight and friends
- (plan may add narrow siblings, e.g. transform move, if the property
  path form can't express them)

A single **live-update dispatcher** in the editor store routes
successful mutating commands to those methods while `playing`:

- Local edits: after any `exec(...)` succeeds, the dispatcher inspects
  `{command, args}` and forwards.
- External agents: the existing journal WS feed delivers the same
  `{command, args}` shape; the dispatcher consumes both streams
  identically. **A human in the Inspector and an agent running
  `hearth script edit` get identical live behavior — this is the
  unification point.** No new WS frame types, no new server surface.

Rejected: WS-frame-driven push from the server (indirection with no
benefit while the game is in-page; nothing on the roadmap moves it
out); full snapshot-diffing on every journal entry (guesses at
structural semantics — see the hybrid rule below).

### The hybrid rule (what patches live vs. what doesn't)

- **Targeted live patches**: the property-write commands
  (`setComponentProperty`, `setProperties`, `moveEntity`,
  scene-settings updates incl. `ambientLight`) and script content
  commands (`editScript`, `formatScript`, `replaceInScripts` → reload
  affected paths).
- **Structural changes** (entity/component add/remove, asset
  create/delete/import, scene add/rename, prefab ops): no half-applied
  guessing. A quiet, non-blocking **toolbar badge** appears:
  "Scene changed — restart play to apply." Clicking it restarts play
  (bumps `runNonce`). Badge clears on Stop/Play.
- Patch divergence rule: a live patch sets **only the named field** on
  the running entity; runtime-diverged state (positions from physics,
  spawned entities) is otherwise untouched. Entities that exist only
  in the runtime (spawned) or only in the editor (created during play)
  are skipped by id-miss without error.

---

## Pillar 1 — Script hot-reload during play

- `SceneRuntime.reloadScript(path, source)`:
  - Recompile via the existing per-language path (JS Function-eval,
    Lua wasmoon). **On compile failure: the old module keeps running**;
    the failure is reported as a `RuntimeError` (phase `reload`) with
    file+line and surfaced in Console + Code panel diagnostics.
  - On success: swap hooks in `scriptModules`; for every entity whose
    script list includes the path, swap its `hooks` reference while
    **preserving `vars`, scheduler (timers/tweens), ctx, and
    subscriptions**; reset `consecutiveErrors`; re-enable scripts that
    were disabled by the error limit. `onStart` does NOT re-run.
  - Event subscriptions made via `ctx.events` from old code stay live
    (they belong to entity state); handlers resolved through the
    swapped hooks table so new code receives them. Plan verifies this
    against the actual subscription plumbing and may re-register.
- Console notice on success: `Hot-reloaded scripts/foo.lua (3
  entities)`. Notice, not modal — comfort means never interrupting.
- Triggers: Code panel save; `editScript` / `formatScript` /
  `replaceInScripts` from CLI/MCP (via journal feed); the same feed
  covers external-editor writes that agents journal. All triggers
  funnel through the one dispatcher.
- Headless playtests are untouched (they never mutate scripts
  mid-run); determinism guarantees are unchanged for playtests.

## Pillar 2 — Live property patching

- Dual-write: the Inspector already persists edits through commands;
  the dispatcher additionally forwards them into the running game.
  This closes the long-standing "ambientLight needs Stop/Play" gap —
  scene settings patch live like component properties.
- The patch reuses the runtime's property-path semantics (strict paths
  from Wave G) so editor writes and runtime patches can't drift.
- Pixi sync happens through the normal render path — a patch mutates
  component data; the next frame draws it. Paused games render the
  patch too (pause blocks simulation, not rendering; matches Step's
  existing behavior — verify in plan).
- LivePanel gains nothing new — it already polls runtime state, so
  patches show up there automatically (free verification for users).

## Pillar 3 — Runtime error → exact line

- `RuntimeError` gains optional `line`/`column` (and keeps
  entity/script/phase).
  - Lua: parse wasmoon's `[string "scripts/foo.lua"]:12:` message
    form.
  - JS: parse the eval stack frame (`<anonymous>:LINE:COL`), adjusting
    for the Function-wrapper offset. Known V8 limits mean some JS
    errors have no line — **degrade gracefully to today's behavior**
    (checkScript JS diagnostics are already line:null; same story).
- Console error entries for runtime errors become **clickable**: click
  opens the script in the Code panel (new tab if needed) scrolled to
  the line with a transient line highlight. Entries show a
  `foo.lua:12` affix so the target is visible before clicking.
- Error lines also land in `runtime.errors[]`, so playtest reports and
  `hearth log` carry them — agents get line numbers in the same
  envelope humans see.

## Pillar 4 — Format-on-save

- New core command **`formatScript`** (`{path}` or `{source,
  language}` for format-without-write, mirroring checkScript's
  shapes — plan decides the exact zod schema): StyLua-WASM for Lua,
  Prettier-standalone for JS, **fixed defaults, no config files**.
  CLI `hearth script format <path>` (and `--all`), MCP
  `format_script`. Mutating form journals + participates in undo like
  any command.
- Bundle discipline: both formatters load via **lazy dynamic import**
  — the editor main chunk and the player bundle must not grow (player
  never ships formatters; budget test already guards 1.45MB). The
  standalone CLI bundle may grow (release-asset size is not
  player-critical), but the plan measures it and keeps the wasm
  external or base64-inlined, whichever keeps `hearth-cli.mjs`
  reasonable. Core stays browser-safe (validate.ts lesson: no
  Node-only imports reachable from the barrel).
- Code panel: saving formats first, then saves (one undo entry, one
  journal entry); a format keybind (registry + `?` cheat sheet; not a
  hardcoded combo, platform-independent per the Wave F lesson).
  Formatting is a no-op that preserves the buffer when the formatter
  errors (never block a save on a formatter bug — save unformatted and
  log a console warning).
- Per-project setting `formatOnSave` (default **true**) in project
  settings, editable via the existing settings command surface +
  a plain checkbox in the editor (Settings panel/section — plan
  locates it with the existing settings UI).
- Idempotency test: format(format(x)) === format(x) for both
  languages; goldens for representative scripts; examples regenerate
  formatted (generate.mjs output must be format-stable so the CI
  clean-tree examples check stays green — if not, the generator
  pipes through formatScript).

## Pillar 5 — Code tabs

- CodePanel's single-buffer state (`selectedPath/source/savedSource/
  dirty/conflict/saveError/scriptMissing` + journal cursor) becomes a
  **buffer list keyed by path**: tab strip above the editor, dirty
  dots, close buttons, confirm-on-close for dirty buffers (existing
  ConfirmDialog), middle-click close.
- Per-buffer undo history survives tab switches (keep `EditorState`
  per buffer rather than remounting from string — plan verifies CM6
  state-swap pattern).
- External-change tracking (`decideExternalChange`) runs per buffer;
  the conflict banner applies to the affected tab only. The journal
  follow cursor moves from "one open path" to the buffer set.
- Open flows unchanged (Assets card, Inspector affordance, script
  picker) — they now open/activate a tab. Error-click (Pillar 3) and
  search results (Pillar 7) open tabs at lines.
- Visual language: matches the existing panel chrome exactly — no new
  colors, spacing per the panel's rhythm. Keyboard: tab-switch
  keybinds via the registry; a11y focus order tab-strip → editor.

## Pillar 6 — Hover docs on ctx API

- CM6 `hoverTooltip` over `ctx.*` dot-paths, resolved through the
  **same CTX_API trie the completion source already builds** — one
  source of truth (drift test already asserts completion ≡ CTX_API;
  extend it to the hover source).
- Tooltip shows signature, description, and the example in the
  buffer's language when CTX_API has one. Styled with the code theme
  (charcoal surface, readable width, no stock CM tooltip look).
- Works identically in Lua and JS buffers.

## Pillar 7 — Find/replace across scripts

- New core commands (CLI/MCP-first):
  - **`searchScripts`** (read-only): `{query, regex?, caseSensitive?,
    pathGlob?}` → per-file matches `{path, line, column, preview}`
    with a capped total (suggestions say how to narrow when capped).
  - **`replaceInScripts`** (mutating): same matching params +
    `{replacement, dryRun?}`. Dry-run returns the would-be changes;
    real run applies **all files as one undo entry** and one journal
    entry per file (plan decides envelope detail), then hot-reload
    fires for affected running scripts via the dispatcher.
  - Invalid regex → structured error with the regex engine's message,
    not a stack trace.
- CLI `hearth script search <query>` / `hearth script replace`; MCP
  `search_scripts` / `replace_in_scripts`.
- Editor: **in-file** find via CM6 search, restyled to the code theme
  (⌘F equivalent from the keybind registry); **cross-script** search
  UI inside the Code panel (⇧⌘F equivalent): query + regex/case
  toggles, grouped-by-file results, click → open tab at line,
  replace-all with a dry-run preview list before applying.

## Ledger minors (on-theme sweep)

- **WS-status indicator**: small editor affordance showing the /api/ws
  connection state (journal + live-follow health) — iteration-loop
  trust depends on the feed being visibly alive.
- **Union validKeys hint**: property-path errors on union components
  list the valid keys for the active variant.
- **Pre-0.10 phantom postEffects diff**: old snapshots diff clean.
- **PostEffectsField↔Inspector circular import**: break the cycle.

## End-of-wave polish pass

Jake-directed sweep as in Waves F/G: keyboard a11y on all new UI
(tabs, search, badge), inline error surfaces, plain-language copy
check, cohesive styling audit of tab strip/tooltips/search panel
against DESIGN.md. No raw JSON anywhere (standing bar).

## Testing

- **Runtime**: reload preserves vars/timers/tweens + does not re-run
  onStart; reload compile-failure keeps old code running; error-limit
  re-enable on reload; patch semantics (targeted field only, id-miss
  skip); error line extraction (Lua + JS + no-line fallback).
- **Chromium pixel tests**: live patch visibly changes pixels across
  frames (ambientLight and a sprite tint case); hot-reload changes
  behavior mid-run without remount (per the "assert pixels CHANGE"
  lesson).
- **Formatter**: idempotency, goldens, examples format-stable,
  formatter-error save fallback; bundle budgets (player unchanged,
  editor main chunk unchanged, CLI measured).
- **Commands**: searchScripts/replaceInScripts/formatScript envelope,
  undo (replace-all = one undo), journal entries, MCP parity count
  tests; CLI/MCP suites need a core rebuild first (dist consumption
  gotcha).
- **Editor**: tab state (dirty/conflict per buffer), error-click
  opens correct tab+line, keybind tests platform-independent.
- Typecheck alongside vitest (standing rule) + HEARTH_SMOKE.

## Out of scope (unchanged non-goals)

Agent panel v2 chat UI, custom GLSL assets, live-linked prefabs
(Wave I), desktop game export (Wave J), visual logic editor (cut).
No watch-mode file poller beyond what the journal already provides —
un-journaled external edits (raw `vim` on a script) still require the
existing manual reload path; journaling editors/agents are the target.

## Release

v0.11.0: tag-push release (11 assets), website sync + deploy
(iteration-loop copy, docs page for the code workflow; counts update:
commands 62→65, MCP tools 61→64), CHANGELOG. Counts verified at plan
time, not trusted from this spec.
