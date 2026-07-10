# Wave G — Write & See (v0.10.0)

Date: 2026-07-10. Status: approved by Jake (scope + all five pillars;
"implement end to end"). Backlog sources: §8 editor support (Lua
highlighting/completion/diagnostics, promised "over time"), §12 tier 2
(screen effects beyond camera shake — curated, no user GLSL yet), the
open agent-fidelity items from Waves E/F (strict setComponentProperty,
batch command, seeded ids, TilemapSchema cap), the Wave E `/api` Origin
gap, and the 755KB editor-chunk debt.

Theme: what you **write** (a real in-editor code editor) and what you
**see** (a curated visual-effects tier + live play-mode state), with an
agent-fidelity pack and a security/bloat hygiene pass. Standing rules
apply: every system ships CLI/MCP-first; no engine chrome in shipped
games; snapshot-shape changes get same-day old-format upgrade tests;
human-facing copy plain-language, agent-facing names unchanged.

---

## Pillar 1 — In-editor code editor

Today the editor has **no way to write or edit a script** — scripts are
agent/external-editor only. This pillar closes that.

### Library and bundle discipline

- **CodeMirror 6** (not Monaco): ~10× smaller, tree-shakeable, MIT.
  Packages: `@codemirror/state`, `view`, `language`, `autocomplete`,
  `lint`, `commands`, `@codemirror/legacy-modes` (Lua mode),
  `@codemirror/lang-javascript`. Custom minimal theme matching the
  editor palette (neutral charcoal surfaces, ember accents) — cohesive
  per Jake's editor-UX bar, no stock light theme.
- The whole CodeMirror dependency graph loads as a **lazy chunk** on
  first Code-panel open (`React.lazy` / dynamic import). The main
  editor chunk must not grow from this pillar (see Pillar 5 budgets).

### Code panel

- New dockable **Code** panel (dockview, ViewMenu toggle like the
  others). Tab-per-script within the panel (or single-document with a
  script picker — plan decides; single-document is acceptable v1).
- Open flows: double-click / "Edit" on script cards in AssetsPanel;
  an edit affordance next to the Script component's script picker in
  the Inspector.
- Lua + JS syntax highlighting; line numbers; bracket matching;
  standard CodeMirror editing keymap.

### Completion

- `ctx.` member completion sourced from the existing **`CTX_API`
  metadata** (`packages/core/src/ctxApi.ts` — same source as
  `hearth inspect api` and AGENTS.md). Completions show signature +
  doc line, per-language example where CTX_API has one. **No new
  hand-maintained mirror** — a drift test asserts the completion
  source is CTX_API itself.
- Lua keyword/snippet basics (function/if/for skeletons) are
  nice-to-have, not required.

### Diagnostics — new `checkScript` command (CLI/MCP-first)

- New core command **`checkScript`** (read-only, `read` permission):
  params `{ name?, language, content }` → structured diagnostics
  `[{ line, column?, message, severity }]`. It reuses the existing
  script syntax-validation module (v0.3.0, file+line, including the
  validate-time dry execution of lifecycle hooks where that already
  exists) — **content is passed in, nothing is saved**, so agents can
  pre-flight a script before `editScript`.
- CLI: `hearth check script --language lua [--name x] < file` (exact
  verb shape at plan time); MCP tool `check_script`.
- The Code panel runs `checkScript` debounced (~500ms after typing
  stops) against the buffer → CodeMirror lint squiggles + gutter
  markers. Editor lint IS the agent surface — one implementation.

### Saving and the agent seam

- Save flows through the **`editScript` command**
  (`packages/core/src/commands/scriptCommands.ts:175`) — so undo,
  journal, diff, and the agent Timeline all see human edits. No
  direct-file writes from the panel.
- ⌘S inside the panel = save script (CodeMirror `Mod-s` keymap inside
  the editor instance; the global keybind registry's typing-guard
  already skips contentEditable targets, so no double-fire — test
  this, platform-independent per the Wave F rule). Dirty indicator in
  the tab; unsaved-changes confirm on close.
- **Live-follow external edits** (the Wave E/F bug class): journal
  watcher frames already invalidate the session. A non-dirty buffer
  reloads silently; a dirty buffer with an external change shows a
  conflict banner (Reload / Keep mine). Regression test: external
  `editScript` while the panel is open must never be clobbered by a
  later panel save without the user choosing "Keep mine".

## Pillar 2 — Curated visual effects (no user GLSL)

Custom shader **assets** remain a later wave (sandbox + asset-format
design). This wave ships a curated, data-driven effect tier that is
agent-native for free because it's all schema-validated component data.

### Camera post-effect stack

`Camera.postEffects`: ordered array (max 8) of typed effect objects —
discriminated union on `type`:

- `bloom` (strength, threshold)
- `crt` (curvature, scanlineIntensity, optional noise — seeded)
- `vignette` (intensity, color)
- `chromaticAberration` (offset)
- `pixelate` (size)
- `colorGrade` (brightness, contrast, saturation, tint)

Array order = application order. Defaults keep every effect a no-op at
neutral values. Existing component commands (`setComponentProperty`,
and Pillar 3's `setProperties`) cover mutation; `COMPONENT_DOCS` +
validation warnings updated. Scripts mutate via `ctx.getComponent
('Camera')` as usual.

### Per-sprite effects — new `SpriteEffects` component (18th)

- `outline` (enabled, color, width)
- `flash` (deterministic decay: `ctx.effects.flash(color, duration)`
  writes component state the runtime decays per fixed-step frame —
  seeded/deterministic like camera effects)
- `dissolve` (amount 0–1, seed — deterministic noise)

`ctx.effects` helper group added to CTX_API (flash at minimum; exact
surface at plan time), identical across Lua/JS.

### Implementation and verification

- **Hand-written minimal GLSL fragment shaders as Pixi filters** in
  `packages/runtime/src/pixi/` — NOT the pixi-filters package (bloat
  rule). Player bundle size measured before/after and published.
- Headless runs record active post-effects / sprite-effect state per
  frame; new playtest step **`assertPostEffect`** (shape follows
  `assertCameraEffect`). Determinism: any noise is seeded from the
  session seed.
- Chromium-gated **pixels-change** tests per the house rule (each
  effect ON vs OFF must change pixels; follow the existing gated
  pattern).
- Works in web exports (filters are part of the runtime pixi code
  already bundled by the player).

### Example #10 — effects showcase

New generated example (working name "Afterglow", plan names it): a
small scene exercising the post stack + SpriteEffects, all-Lua,
probe-derived playtests (never hand-computed), doubles as the
pixel-test target. Examples stay engine-repo-only (website rule).

## Pillar 3 — Agent fidelity pack

### Strict `setComponentProperty`

Today an unknown property path **false-successes**: `setByPath` writes
any key and Zod object parsing silently strips unknown keys
(`componentCommands.ts:93`). Fix: walk the component schema shape along
the dot path; any segment that doesn't exist in the schema (objects:
key present; arrays/records: index/key forms allowed per the existing
path semantics) → `INVALID_INPUT` with **did-you-mean suggestions**
(nearest schema keys). Applies to `setProperties` too. Add a validate
warning for unknown keys already persisted in loaded components (data
written before this fix) rather than hard-failing old projects.

### Batch multi-property command — `setProperties`

New command `setProperties`: `{ scene, entity, properties:
Record<dotPath, value> }` — all paths validated (strict rules above),
all-or-nothing, **one history entry / one journal entry**. CLI verb +
MCP tool `set_properties`. The editor's corner handle-drags switch to
it, closing the Wave F "2 undo steps" leftover.

### Seeded ids → CI clean-tree

`generateId` (`packages/core/src/ids.ts`) gains a pluggable source:
default stays `Math.random`; a `HearthSession`/store option enables a
deterministic per-prefix sequence (for generators and tests only —
never the default). `packages/examples/generate.mjs` uses it, making
regeneration **byte-identical** → add the CI clean-tree check from the
Wave E backlog (regenerate examples in CI, fail on dirty tree).

### TilemapSchema grid cap

`Tilemap.grid` gets a max-length constraint consistent with the
`resizeTilemap` caps, closing the `setComponentProperty` bypass noted
in Wave E Task 14.

## Pillar 4 — Play-mode debugging (human-facing)

- **Pause / Resume / Step-frame** controls on the game preview
  toolbar. `MountedGameView` already has `play()/pause()`; add a
  `stepFrame()` (one fixed-timestep tick + render) through
  `runtimeBridge.ts`.
- **Live runtime inspector** (read-only) while playing: pick a runtime
  entity (list includes runtime-spawned entities, not just authored
  ones) and see transform, velocity, active timers/tweens, recent
  events for it — polled ~10Hz via a new `MountedGameView` inspection
  accessor. Placement: cohesive with the existing panel system (plan
  + design pass decide exact placement; typed controls, no raw JSON —
  Jake's bar).
- No new agent surface: headless playtests already step frame-by-frame
  and record state; docs cross-reference the two.

## Pillar 5 — Hygiene: security + bloat

### `/api` Origin enforcement (the Wave E gap)

Browser-borne CSRF can currently drive the local project server. In
`apps/editor/server/projectServer.ts` `route()` + the `/api/ws`
upgrade:

- Requests **with an Origin header** must match an allowlist: the dev
  server's own origin(s) (vite port), the Electron origin, and
  localhost/127.0.0.1 equivalents. Mismatched Origin → 403, WS upgrade
  rejected.
- Requests **without Origin** (CLI, curl, non-browser) stay allowed —
  the CLI/MCP path must not regress.
- Host-header sanity check (localhost/127.0.0.1) for DNS-rebinding
  defense. Tests for allowed/blocked/absent-Origin on both a mutating
  route and the WS upgrade.

### Editor code-split

Main chunk is 755KB. Lazy-load: CodeMirror (Pillar 1), xterm +
AgentPanel terminal internals, SliceDialog. Target: **main chunk under
500KB** (stretch; record the real number). Add a cheap build-size
report (script or CI log line) so regressions are visible; hard-fail
budget optional if cheap.

### Player/export budget

Record exported-game bundle size (single-file mode) in
`docs/performance.md` before/after the effects work; hand-rolled
filters keep the delta small (target: < 30KB added).

### Dependency posture

No new heavy dependencies beyond CodeMirror's lazy graph. `npm audit`
pass: fix or consciously waive criticals/highs, note the outcome.

## Docs, counts, release

- New: `docs/effects.md`. Updated: `docs/editor.md` (Code panel,
  play-mode debugging), `docs/scripting.md` (checkScript, ctx.effects),
  `docs/cli.md`, `docs/mcp.md`, `docs/performance.md` (budgets),
  component/command references, AGENTS.md regeneration, README/roadmap
  truth pass.
- Expected counts: 60 → **62 commands** (checkScript, setProperties),
  59 → **61 MCP tools**, 17 → **18 components** (SpriteEffects),
  9 → **10 examples**.
- Version: **v0.10.0** across all package.json + constants. Release:
  tag-push after final review; website sync + deploy (no example
  showcase on the website — engine docs pages only).

## Non-goals (this wave)

- User-written GLSL / shader assets (needs sandbox design — later).
- Agent panel v2 chat UI, Codex auto-wiring, notarization,
  live-linked prefab overrides, visual logic editor.
- Lua LSP-grade intelligence (rename, go-to-def) — completion +
  diagnostics only.
- Mobile/touch editor concerns.

## Verification bar (house rules)

- `npx vitest run` AND `npm run typecheck` (vitest doesn't typecheck).
- Rebuild `@hearth/core` before CLI/MCP suites (dist consumption).
- Pixel-change assertions for every visual effect (Chromium-gated).
- Platform-independent keybind tests (no hardcoded metaKey).
- Probe-derived playtest expectations for the example (no hand-computed
  counts).
- Old-format upgrade tests for any snapshot/baseline shape change
  (postEffects/SpriteEffects must load pre-0.10 projects cleanly —
  schema defaults cover it; test it anyway).
- `HEARTH_SMOKE=1` Electron self-test before release.
