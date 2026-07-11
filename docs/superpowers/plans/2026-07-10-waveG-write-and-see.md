# Wave G: Write & See Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.10.0: an in-editor CodeMirror 6 code panel (Lua/JS highlighting, CTX_API completion, checkScript lint), a curated visual-effects tier (Camera.postEffects stack + SpriteEffects component, hand-rolled Pixi filters), an agent-fidelity pack (strict property paths with did-you-mean, setProperties batch, seeded ids + CI clean-tree, Tilemap grid cap), play-mode debugging (pause/step-frame + Live runtime inspector), and a hygiene pass (Origin/Host enforcement on /api + WS, editor code-split, bundle budgets).

**Architecture:** Effects are pure schema-validated component data (`Camera.postEffects` array of a discriminated union; new flat-scalar `SpriteEffects` component) — agent-native for free through existing commands; the runtime decays flash deterministically per fixed step and the Pixi layer translates data → hand-written GLSL filters. The code panel is a lazy-loaded dockview panel whose lint IS the new read-only `checkScript` command (one implementation, CLI/MCP/editor), whose saves flow through `editScript`, and which live-follows the journal feed. Strict paths live in a new zod-shape-walking `paths.ts` shared by `setComponentProperty` and the new `setProperties`. Play-mode debugging is interface-widening: `PixiSceneView.stepOnceAsync()/renderOnce()` already exist.

**Tech Stack:** TypeScript ESM NodeNext, zod, vitest, commander, MCP SDK, React 18 + zustand + dockview, PixiJS v8, wasmoon, CodeMirror 6, luaparse, esbuild, playwright-core (gated).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-waveG-write-and-see-design.md`. Where this plan and the spec conflict, stop and escalate.
- Every mutation flows through `HearthSession.execute` (packages/core/src/session.ts); CLI/MCP/editor are thin adapters — never bypass the registry.
- CLI/MCP parity lands **in the same task** as each core command: CLI verb in `packages/cli/src/program.ts` AND ToolSpec in `packages/mcp-server/src/tools.ts` (snake_case, mirrored zod inputShape).
- CLI/MCP test suites consume @hearth/core via built dist — run `npm run build --workspace=@hearth/core` after core changes before those suites, or they fail UNKNOWN_COMMAND.
- Editor UI: typed cohesive controls, never raw JSON fields (a `postEffects` array falls through Inspector's generic dispatch to JsonField — Task 10 adds the typed control BEFORE docs/example ship the feature to humans).
- Examples are GENERATED: edit `packages/examples/generate.mjs` only; playtest expectations are probe-derived (GameSession.create → stepAsync → read), never hand-computed.
- Tests: root `npx vitest run` AND `npm run typecheck` must both pass at every commit (vitest does NOT typecheck). TS ESM: relative imports need `.js`.
- Keybind/platform tests must be platform-independent (no hardcoded metaKey — Wave F release-breaker).
- Runtime determinism: effects decay/noise must be seeded/frame-derived, never Date.now/Math.random; golden hashes and existing playtest report shapes stay stable; new report fields are additive.
- No-op invariant for effects: default component values must render byte-identical to no component (pixel test guards this).
- Version bumps to 0.10.0 happen only in the final task (mirror the 0.9.0 pattern: all package.json + lock + 3 constants).
- No AI attribution in commits. Plain human-voice commit messages.
- File-overlap sequencing: **Chain A (core)** Tasks 1→2→4→5→6 in order (shared registry/CLI/MCP/schema files). **Task 3** is disjoint (ids.ts, generate.mjs, ci.yml) — may run parallel to Chain A but MUST land before Task 13. **Chain B (editor)** Tasks 7→8→9→10 in order (shared Workspace/layout/store/Inspector/SceneView files); 7 needs Task 1 shipped (checkScript), 10 needs Tasks 2+5. **Task 11** (server only) parallel to anything. **Task 12** after 6, 7, 9. **Task 13** after 3, 5, 6. **Task 14** last.
- Electron serves the editor over `http://127.0.0.1:<random port>` (apps/editor/electron/main.ts:44-78, loadURL at :193) — Origin/Host allowlists must be host-based (localhost/127.0.0.1/::1, any port), never fixed strings.
- npm audit posture (verified 2026-07-10): `npm audit --omit=dev` = 0 vulnerabilities. Full audit: 11 dev-tooling advisories requiring breaking bumps (electron 33→43, electron-builder 25→26, esbuild 0.24→0.28). Wave G does NOT take those bumps (release-toolchain risk); Task 12 documents the waiver.

---

### Task 1: `checkScript` command + CLI/MCP

**Files:**
- Modify: `packages/core/src/validate.ts` (extract pure checker from `validateScriptSyntax`, lines 96-137)
- Modify: `packages/core/src/commands/scriptCommands.ts` (new command after `editScript` at :174)
- Modify: `packages/core/src/commands/registry.ts` (ALL_DEFINITIONS, script block)
- Modify: `packages/core/src/index.ts` (export new types)
- Modify: `packages/cli/src/program.ts`, `packages/mcp-server/src/tools.ts`
- Test: `packages/core/tests/checkScript.test.ts`, additions to `packages/cli/tests/` + `packages/mcp-server/tests/` per suite convention

**Interfaces:**
- Consumes: existing JS `new Function` compile-check + `extractJsErrorLine` (validate.ts:83-113), `luaparse.parse(source, { luaVersion: '5.3' })` (validate.ts:116), `ProjectStore.readScript` (store.ts:192).
- Produces (Task 8 consumes via `query('checkScript', ...)`):
  ```ts
  // packages/core/src/validate.ts
  export interface ScriptDiagnostic { line: number | null; message: string; severity: 'error' | 'warning' }
  export function checkScriptSource(language: 'lua' | 'js', source: string): ScriptDiagnostic[];
  // command result shape:
  // checkScript { source: string; language?: 'lua'|'js'; path?: string } -> { valid: boolean; language: 'lua'|'js'; diagnostics: ScriptDiagnostic[] }
  ```

- [ ] Extract `checkScriptSource` from the body of `validateScriptSyntax` (same `export default` → `module.exports` rewrite, compile-only `new Function`, luaparse path). `validateScriptSyntax` becomes a thin wrapper mapping `ScriptDiagnostic[]` into `ValidationIssue` pushes — **all existing validate tests must stay green unchanged** (proves behavior identical).
- [ ] Add `checkScript` command: `permission: 'read'`, `mutates: false`. Params `z.object({ source: z.string().optional(), path: z.string().optional(), language: z.enum(['lua','js']).optional() }).refine(source or path present)`. If `path` given: must be under `scripts/`, read via `ctx.store.readScript`; language inferred from extension unless overridden; bare `source` defaults to `lua`. Returns `{ valid: diagnostics.every(d => d.severity !== 'error'), language, diagnostics }`. Never writes anything.
- [ ] Tests: lua syntax error yields `{ line, message }` matching luaparse; js error line matches the `-2` wrapper offset; valid script → `valid: true, diagnostics: []`; `path` mode reads project script; path outside `scripts/` → INVALID_INPUT; neither source nor path → INVALID_INPUT.
- [ ] CLI: `hearth check-script <path> [--source <text>] [--language lua|js]` following the `guarded`/`runAndEmit` shape (program.ts:430-438 pattern). Plain output: one line per diagnostic `path:line message`, exit non-zero when invalid (match `hearth validate` behavior). `--json` via global flag.
- [ ] MCP: `check_script` ToolSpec (tools.ts, mirror inputShape; description notes "pre-flight a script before edit_script — nothing is saved").
- [ ] Rebuild core dist; run core+cli+mcp suites + typecheck; commit.

### Task 2: Strict property paths + `setProperties` batch command

**Files:**
- Create: `packages/core/src/schema/paths.ts`
- Modify: `packages/core/src/commands/componentCommands.ts` (setComponentProperty :93-148; add setProperties after it)
- Modify: `packages/core/src/commands/registry.ts` (component block, :49-52)
- Modify: `packages/core/src/validate.ts` (unknown-persisted-keys warning pass)
- Modify: `packages/cli/src/program.ts`, `packages/mcp-server/src/tools.ts`
- Test: `packages/core/tests/paths.test.ts`, `packages/core/tests/setProperties.test.ts`, additions to componentCommands/validate tests

**Interfaces:**
- Consumes: `COMPONENT_SCHEMAS` (components.ts:250-268), unwrap pattern from `enumOptions` (components.ts:356-363), `setByPath` (componentCommands.ts:78-91), all-or-nothing pre-validation pattern from `paintTiles` (tilemapCommands.ts:81-90).
- Produces (Task 10's SceneView switch and Task 5's postEffects paths rely on these):
  ```ts
  // packages/core/src/schema/paths.ts
  export interface PathCheck { ok: true } | { ok: false; failedAt: string; validKeys: string[]; suggestions: string[] }
  export function validateComponentPath(type: ComponentType, pathParts: string[]): PathCheck;
  // command: setProperties { scene, entity, properties: Record<string, unknown> } (dot-path keys incl. "Type." prefix)
  //   -> { entityId, applied: Record<string, unknown>, components: Partial<ComponentMap> }
  ```

- [ ] `paths.ts`: walk the zod schema along pathParts. Unwrap `ZodDefault`/`ZodOptional`/`ZodNullable` at each node (loop like enumOptions). `ZodObject` → segment must be a shape key; `ZodArray` → segment must match `/^\d+$/`, descend into element; `ZodRecord` → any segment, descend into value; `ZodDiscriminatedUnion`/`ZodUnion` → segment valid if valid in ANY option (needed for `Camera.postEffects.0.strength` after Task 5). A path may stop early (setting a whole object/array is legal) — only reject when a segment fails at its node. Include a tiny levenshtein (≤ 32-line helper, no dependency): `suggestions` = validKeys with distance ≤ 2, else empty.
- [ ] Wire into `setComponentProperty` between the pathParts-length check and `setByPath`: on `!ok`, throw `INVALID_INPUT`: `Unknown property "<failedAt>" on <joined-prefix>. Did you mean "<suggestions[0]>"? Valid keys: <validKeys>` (suggestion clause only when non-empty). RED-prove with the exact bug: `Transform.postiion.x` currently returns success — test asserts it now fails with `position` suggested.
- [ ] `setProperties` command: `permission: 'safe-edit'`, `mutates: true`. Params `{ scene, entity, properties: z.record(z.string().min(1), z.unknown()).refine(≥1 entry) }`. Phase 1 validate everything: group keys by component type (`isComponentType` on first segment, same errors as setComponentProperty incl. path validation and NOT_FOUND for missing components); apply all of a type's writes to one cloned component via successive `setByPath`, then `COMPONENT_SCHEMAS[type].safeParse` once per touched type. ANY failure → throw before Phase 2. Phase 2 write all parsed components, one `ctx.changed({kind:'component', ...})` per touched type. One `execute()` = one history + one journal entry automatically (session.ts:156-213) — regression test: after one setProperties touching width+height, ONE `hearth undo` restores both.
- [ ] Conflict rule: two keys targeting the same component are applied in `Object.entries` order onto the same clone (later wins on identical paths) — document in the command description; test it.
- [ ] validate.ts: new warning pass `UNKNOWN_COMPONENT_KEY` — for each entity component, diff actual object keys against schema shape keys (top level only; recurse one level into known object fields) and warn (never error — pre-fix projects must still load).
- [ ] CLI: `hearth set-many <scene> <entity> --properties <json>` (reuse `parseJsonObject`, precedent program.ts:414). MCP: `set_properties` with `properties: z.record(z.string(), z.unknown())`.
- [ ] Rebuild core dist; all suites + typecheck; commit.

### Task 3: Seeded ids + examples determinism + CI clean-tree

**Files:**
- Modify: `packages/core/src/ids.ts`
- Modify: `packages/examples/generate.mjs` (header + seed install at top of `main`)
- Modify: `.github/workflows/ci.yml` (step after "Regenerate examples")
- Regenerate: all `packages/examples/<name>/` project trees
- Test: `packages/core/tests/ids.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // packages/core/src/ids.ts
  export function setIdRandomSource(rng: (() => number) | null): void; // null restores Math.random
  export function createSeededRng(seed: number): () => number;         // mulberry32, matches runtime's createRng convention
  ```

- [ ] `ids.ts`: module-level `let rng: () => number = Math.random`; `randomChars` uses `rng`. `setIdRandomSource(fn|null)` swaps it. Doc comment MUST restate the runtime invariant (runtime.ts:1131-1143): spawned-entity ids never consume the seeded ctx.random stream; this seam is for generators/tests only and defaults to Math.random. Tests: same seed → same sequence; null restores randomness; distinct prefixes share one stream (documented).
- [ ] `generate.mjs`: `setIdRandomSource(createSeededRng(1))` before the first example; note in the header comment that regen is now byte-identical (replace the "ids change" sentence at lines 1-9). Run generator twice → `git diff --exit-code -- packages/examples` clean between runs (prove locally before committing).
- [ ] Regenerate all examples once, commit the now-stable trees. Full examples suite green.
- [ ] ci.yml: after the existing "Regenerate examples (dogfoods the command system)" step add:
  ```yaml
  - name: Examples are clean (byte-identical regen)
    run: git diff --exit-code -- packages/examples
  ```
- [ ] Typecheck + suites; commit.

### Task 4: Tilemap grid cap

**Files:**
- Modify: `packages/core/src/schema/components.ts` (TilemapSchema :179-191; export shared constant)
- Modify: `packages/core/src/commands/tilemapCommands.ts` (resize/fill caps reference the constant)
- Test: additions to existing tilemap/componentCommands tests

- [ ] `export const TILEMAP_MAX_DIM = 1024;` in components.ts. `grid: z.array(z.string()).max(TILEMAP_MAX_DIM).default([])` — the grid is an array of row strings (one string per row, chars = columns), so cap rows at TILEMAP_MAX_DIM and add `.refine(rows => rows.every(r => r.length <= TILEMAP_MAX_DIM), 'row longer than TILEMAP_MAX_DIM')`. **Verify the row-string representation against the actual TilemapSchema/grid usage first** (paintTiles' assertInBounds, tilemapCommands.ts:63-72) — if the grid is instead flat cells, cap length at `TILEMAP_MAX_DIM * TILEMAP_MAX_DIM`; match reality, keep the shared constant.
- [ ] `resizeTilemap`/`fillTilemapRect` paramsSchemas swap literal 1024 for the constant.
- [ ] Test: `setComponentProperty Tilemap.grid` with an oversized grid → SCHEMA_ERROR (this is the exact bypass being closed); resize at the cap still works.
- [ ] Suites + typecheck; commit.

### Task 5: Effects schemas + deterministic runtime state + `ctx.effects` + `assertPostEffect` (headless)

**Files:**
- Modify: `packages/core/src/schema/components.ts` (PostEffectSchema union; Camera.postEffects; SpriteEffectsSchema; COMPONENT_SCHEMAS/ComponentMap/COMPONENT_DOCS)
- Modify: `packages/core/src/schema/project.ts` (PlaytestStepUnionSchema :154-241 + superRefine :249-293)
- Modify: `packages/core/src/ctxApi.ts` (new `// --- effects ---` block)
- Modify: `packages/runtime/src/runtime.ts` (camera getter :422-440; flash decay in step(); makeContext effects group after camera: :1510-1547)
- Modify: `packages/runtime/src/scripts.ts` (ScriptContext effects member before events: :201)
- Modify: `packages/playtest/src/index.ts` (ASSERT_TYPES :114; executor case near :529; PlaytestResult additive field)
- Test: `packages/core/tests/effectsSchema.test.ts`, `packages/runtime/tests/spriteEffects.test.ts`, `packages/playtest/tests/` additions

**Interfaces:**
- Produces (Tasks 6, 10, 13 rely on these exactly):
  ```ts
  // components.ts
  export const POST_EFFECT_TYPES = ['bloom','crt','vignette','chromaticAberration','pixelate','colorGrade'] as const;
  export const PostEffectSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('bloom'), strength: z.number().min(0).max(3).default(1), threshold: z.number().min(0).max(1).default(0.5) }),
    z.object({ type: z.literal('crt'), curvature: z.number().min(0).max(1).default(0.15), scanlineIntensity: z.number().min(0).max(1).default(0.25), noise: z.number().min(0).max(1).default(0) }),
    z.object({ type: z.literal('vignette'), intensity: z.number().min(0).max(1).default(0.4), color: ColorSchema.default('#000000') }),
    z.object({ type: z.literal('chromaticAberration'), offset: z.number().min(0).max(20).default(2) }),
    z.object({ type: z.literal('pixelate'), size: z.number().int().min(1).max(64).default(4) }),
    z.object({ type: z.literal('colorGrade'), brightness: z.number().min(0).max(2).default(1), contrast: z.number().min(0).max(2).default(1), saturation: z.number().min(0).max(2).default(1), tint: ColorSchema.default('#ffffff') }),
  ]);
  // Camera gains: postEffects: z.array(PostEffectSchema).max(8).default([])
  export const SpriteEffectsSchema = z.object({
    outlineEnabled: z.boolean().default(false), outlineColor: ColorSchema.default('#ffffff'), outlineWidth: z.number().min(0).max(16).default(2),
    flashColor: ColorSchema.default('#ffffff'), flashStrength: z.number().min(0).max(1).default(0), flashDuration: z.number().min(0.01).max(10).default(0.15),
    dissolveAmount: z.number().min(0).max(1).default(0), dissolveSeed: z.number().int().default(0),
  });
  // runtime camera getter adds: postEffects: PostEffect[]
  // ctx.effects.flash(color?: string, seconds?: number): void  — sets own SpriteEffects flashColor/flashStrength=1/flashDuration (adds runtime-side component copy if absent)
  // playtest step: { type: 'assertPostEffect', effect: enum(POST_EFFECT_TYPES), active: boolean }
  // PlaytestResult additive field: postEffects: string[]  // active types on main camera at end of run
  ```

- [ ] Schemas + registration (COMPONENT_SCHEMAS, ComponentMap, COMPONENT_DOCS: `SpriteEffects: 'Per-sprite visual effects: outline, hit flash (ctx.effects.flash), dissolve. All values are no-ops at defaults.'`). ComponentMapSchema/scene/inspectComponents/diff pick it up automatically — test `inspectComponents` returns 18 types with SpriteEffects defaults, and a pre-0.10 scene (Camera without postEffects) parses with `postEffects: []`.
- [ ] Runtime: camera getter returns `postEffects` (default `[]` when absent). In `step()` next to `cameraEffects.step` (:571): for every enabled entity with SpriteEffects and `flashStrength > 0`, `flashStrength = max(0, flashStrength - fixedDt / flashDuration)` — pure arithmetic, no RNG, deterministic. Test: two identical runs produce identical flashStrength traces; decay from 1 reaches 0 in ceil(duration/dt) frames.
- [ ] `ctx.effects.flash(color?, seconds?)` in makeContext (sibling group after `camera:`): mutates the entity's own runtime SpriteEffects (create the component object on the runtime copy if missing — authored data untouched); clamps via schema bounds. `scripts.ts` ScriptContext gains the `effects` member. ctxApi.ts entries: `effects.flash` (+ description pointing at data-driven postEffects for camera-wide looks). Lua parity test: dot-call `ctx.effects.flash('#ff0000', 0.2)` from a .lua script affects decay identically to JS (wasmoon proxy handles nesting — no lua.ts changes).
- [ ] Playtest: `assertPostEffect` union branch + superRefine (require `active` boolean present — mirrors :283-293 style), ASSERT_TYPES entry, executor case: read the session runtime's main-camera postEffects at step time, `active: true` asserts the type is present, `false` asserts absent; failure message lists the active stack. `PlaytestResult.postEffects` populated beside cameraEffects (:203-204 and the runSmokeTest mirror :615-616). Tests: script that pushes a bloom entry onto `ctx.getComponent('Camera')`… (or authored postEffects) passes `active:true`, fails `active:false` with the stack named.
- [ ] Rebuild core; all suites + typecheck; commit.

### Task 6: Pixi filters + pixel tests + player budget

**Files:**
- Create: `packages/runtime/src/pixi/postEffects.ts`, `packages/runtime/src/pixi/spriteEffectsFilter.ts`
- Modify: `packages/runtime/src/pixi/index.ts` (stage assembly :231-239; syncCamera :608; updateNode sprite block :1050-1056)
- Modify: `packages/runtime/tests/player-bundle.test.ts` (size budget)
- Test: `packages/playtest/tests/screenshot.test.ts` additions (Chromium-gated)

**Interfaces:**
- Consumes: `PostEffect[]` from runtime camera getter (Task 5), `SpriteEffects` component data, Pixi v8 `Filter.from({ gl: { vertex, fragment }, resources })` API.
- Produces:
  ```ts
  // postEffects.ts
  export function syncPostEffectFilters(current: PostEffectFilterState, stack: PostEffect[], frame: number): Filter[] | null; // cached by stack signature; uniforms updated per call
  // spriteEffectsFilter.ts
  export function syncSpriteEffectsFilter(node: Container, fx: SpriteEffectsComponent | undefined): void; // attaches/detaches/updates one combined filter
  ```

- [ ] Stage restructure: new `gameView = new Container()` holding `[world, lightmapSprite, ui, fxOverlay]` in the existing order; `debugLayer` stays a direct stage child ABOVE gameView (debug overlay must never be filtered). Post filters attach to `gameView.filters`. Verify existing screenshot goldens/tests unaffected when stack is empty (`gameView.filters = null`).
- [ ] Hand-written GLSL, one small filter per effect type (pixi v8 default vertex; fragment ~10-30 lines each: bloom = threshold + 9-tap blur + additive; crt = barrel distortion + scanlines + optional hash noise seeded from a `uFrame` uniform — frame-derived, never Date.now; vignette = radial mix to color; chromaticAberration = per-channel UV offset; pixelate = UV quantize; colorGrade = brightness/contrast/saturation matrix + tint multiply). Cache Filter instances per view keyed by `JSON.stringify(stack)`; update uniforms each syncCamera; rebuild only on signature change.
- [ ] Sprite combined filter (one shader, uniforms: outlineColor/width/enabled, flashColor/strength, dissolveAmount/seed; dissolve = deterministic hash(uv, seed) threshold discard; outline = alpha-edge sampling at width offsets; flash = mix toward flashColor by strength). Attach in `updateNode` only when any field is non-neutral; detach (filters = null) when all neutral.
- [ ] Pixel tests (screenshot.test.ts pattern, `it.skipIf(!hasChromium)`, before/after `Buffer.compare(...).not.toBe(0)`): each of the 6 post effects ON differs from OFF; outline ON differs; dissolve 0.5 differs; flash mid-decay differs; **neutral guard**: default SpriteEffects component AND `postEffects: []` are byte-identical to no component/stack (`.toBe(0)`), following the white-tint regression pattern (:661).
- [ ] Player budget: rebuild `hearth-player.js` (build-player.mjs logs size; baseline 1,349,649 B). Add to player-bundle.test.ts: `expect(size).toBeLessThan(1_450_000)` with a comment stating the 0.10 baseline + effects delta. Record the measured delta for Task 12's docs.
- [ ] All suites + typecheck; commit.

### Task 7: Code panel foundation (lazy CodeMirror, load/save, external-change follow)

**Files:**
- Modify: `apps/editor/src/workspace/layout.ts` (PANEL_IDS :12-24 gains `'code'`), `apps/editor/src/workspace/Workspace.tsx` (PANEL_TITLES/VIEW_MENU_PANELS/PANEL_COMPONENTS + default layout: code as a CENTER panel tabbed with `scene`/`game`)
- Create: `apps/editor/src/components/CodePanel.tsx` (host: script picker header, dirty state, Suspense), `apps/editor/src/components/code/CodeEditor.tsx` (all CodeMirror imports live ONLY here), `apps/editor/src/components/code/codeTheme.ts`, `apps/editor/src/components/code/externalChange.ts` (pure decision helper)
- Modify: `apps/editor/package.json` (deps: `codemirror`, `@codemirror/lang-javascript`, `@codemirror/legacy-modes`, `@codemirror/lint`, `@codemirror/autocomplete`, `@codemirror/language`)
- Modify: `packages/core/src/commands/inspectCommands.ts` **only if** `inspectProject` doesn't already list scripts — verify first; if absent, add additive `scripts: string[]` from `store.listScripts()` (Wave D Task 6 precedent; consumers checked)
- Test: `apps/editor/tests/externalChange.test.ts` (or colocated per editor test convention), core test for the inspectProject addition

**Interfaces:**
- Consumes: `exec('editScript', { path, source })` (scriptCommands :174), `fileUrl(project, path)` + `fetch().text()` for content (api.ts:87-90), `journalFeed`/`commandSeq` store fields (store.ts:52,46), `ProjectStore.listScripts()` (store.ts:196), Task 1's checkScript (used in Task 8, not here).
- Produces (Task 8 extends CodeEditor; Task 12 relies on the lazy boundary):
  ```ts
  // CodePanel: single-document editor with a script <select> (from inspectProject.scripts), dirty dot, Save button.
  // CodeEditor.tsx is imported ONLY via React.lazy(() => import('./code/CodeEditor')) — the CodeMirror chunk boundary.
  // externalChange.ts
  export type ExternalChangeAction = 'reload' | 'banner' | 'ignore';
  export function decideExternalChange(opts: { openPath: string | null; dirty: boolean; entry: { kind: string; source: string; path?: string } }): ExternalChangeAction;
  ```

- [ ] Panel registration triple + default layout placement (`position: { referencePanel: 'scene', direction: 'within' }, inactive: true` like `game`). Title: **"Code"**.
- [ ] CodeEditor: CM6 `EditorView` with `basicSetup`-equivalent extensions, `@codemirror/lang-javascript` for `.js`, `StreamLanguage.define(lua)` from `@codemirror/legacy-modes/mode/lua` for `.lua`. `codeTheme.ts`: `EditorView.theme` using the editor's existing CSS variables (charcoal surfaces, ember accent for selection/active-line/caret; check `apps/editor/src/styles.css` for the variable names — match them, don't invent colors).
- [ ] Save path: CM6 keymap binds `Mod-s` → save (calls the host's onSave → `exec('editScript', ...)`); the global registry's `isTypingTarget` (keybinds.ts:168-172) already ignores CM's contenteditable content — add a platform-independent test asserting `dispatchDecision` returns `ignore` for a contenteditable target with mod+s pressed (guards the double-fire seam).
- [ ] External follow: subscribe to `journalFeed`; for entries with `kind === 'script'` matching the open path and `source !== 'editor'`: `decideExternalChange` → not dirty = silent reload (re-fetch content), dirty = conflict banner (Reload / Keep mine); "Keep mine" marks the buffer as the future save source (a later Save overwrites knowingly). Pure-helper tests cover all branches (the Wave E stale-clobber class: external edit must NEVER be silently overwritten by a later panel save without the user choosing Keep mine — test the decision table exhaustively).
- [ ] Unsaved-changes: dirty dot in the picker row; switching scripts or closing with dirty buffer → ConfirmDialog (existing component).
- [ ] Manual smoke (headless-browser instructions in commit message or ledger): open example project, edit a .lua script, save, verify journal shows editScript, undo restores.
- [ ] Suites + typecheck; commit.

### Task 8: Completion from CTX_API + checkScript lint

**Files:**
- Create: `apps/editor/src/components/code/completion.ts`, `apps/editor/src/components/code/lint.ts`
- Modify: `apps/editor/src/components/code/CodeEditor.tsx` (wire extensions)
- Test: `apps/editor/tests/completion.test.ts`, `apps/editor/tests/lint.test.ts`

**Interfaces:**
- Consumes: `CTX_API`/`CtxApiEntry` from `@hearth/core` (ctxApi.ts:15-25, `path`/`kind`/`signature`/`description`/`example`), Task 1's `checkScript` via the store's silent `query()` (store.ts:169-180), `ScriptDiagnostic`.
- Produces:
  ```ts
  export function ctxCompletionSource(language: 'lua' | 'js'): CompletionSource; // completes after `ctx.` and nested prefixes (`ctx.scene.`) from CTX_API paths; info = signature + description
  export function makeCheckScriptLinter(check: (source: string) => Promise<ScriptDiagnostic[]>, language: 'lua' | 'js'): Extension; // @codemirror/lint linter(), ~500ms debounce via lint's delay option; maps 1-based line -> CM range (clamp to doc)
  ```

- [ ] Completion: derive a prefix-tree from `CTX_API` at module load (pure function of the imported array). Matching: text before cursor `ctx.(\w+\.)*\w*$`. Lua additionally completes bare keywords (`function`, `then`, `end`, `local`, …) — a short static list is fine.
- [ ] **Drift guard test**: every `CTX_API` entry's `path` appears in the completion tree (iterate the real import — the test fails if someone forks a copy).
- [ ] Lint: wrap `query('checkScript', { source, language })`; null result (offline/error) → no diagnostics (never crash typing). Map `line: null` diagnostics to doc start. Severity mapping error→error, warning→warning.
- [ ] Tests: completion source returns `scene.spawn` etc. for `ctx.sce` prefix; lua keyword completion; linter maps a luaparse error line to the right CM position; clamps out-of-range lines.
- [ ] Suites + typecheck; commit.

### Task 9: Play-mode debugging (pause/step + Live panel)

**Files:**
- Modify: `packages/runtime/src/stdlib.ts` (EntityScheduler getters), `packages/runtime/src/runtime.ts` (getSchedulerSnapshot), `packages/runtime/src/pixi/index.ts` (stepFrame method near stepOnceAsync :342-356)
- Modify: `apps/editor/src/runtimeBridge.ts` (widen MountedGameView), `apps/editor/src/components/GamePreview.tsx` (register view; paused effect), `apps/editor/src/store.ts` (paused state + actions), `apps/editor/src/components/Toolbar.tsx` (Pause/Step buttons next to Play/Stop :102-108), `apps/editor/src/keybinds.ts` (cheat-sheet rows if a pause keybind is added — optional, skip if noisy)
- Create: `apps/editor/src/gameViewRef.ts` (module-level set/get), `apps/editor/src/components/LivePanel.tsx`
- Modify: `apps/editor/src/workspace/layout.ts` + `Workspace.tsx` (panel id `'live'`, title **"Live"**, BOTTOM_PANELS group)
- Test: `packages/runtime/tests/` scheduler-getter + stepFrame determinism tests; `apps/editor/tests/` pure-helper tests

**Interfaces:**
- Consumes: `PixiSceneView.stepOnceAsync()` (:342-356), `renderOnce()` (:359-361), `pause()`/`play()` (:325-332), `SceneRuntime.getEntities()` (:377-393), `RuntimeEntity` (:180-192), `runtime.events` (:235), `scriptStates` (private, :292), `EntityScheduler` timers/tweens (stdlib.ts:83-179).
- Produces:
  ```ts
  // stdlib.ts
  listTimers(): ReadonlyArray<{ id: string; remaining: number; interval: number; repeat: boolean }>;
  listTweens(): ReadonlyArray<{ id: string; key: string; elapsed: number; duration: number; from: number; to: number }>;
  // runtime.ts
  getSchedulerSnapshot(entityId: string): { timers: ...; tweens: ... } | null;
  // pixi/index.ts
  async stepFrame(): Promise<void>; // await stepOnceAsync(); renderOnce();
  // runtimeBridge.ts MountedGameView gains: stepFrame?(): Promise<void>; runtime?: RuntimeHandle (local structural type: getEntities/find/events/eventCounts/getSchedulerSnapshot/camera/frame)
  // gameViewRef.ts: setGameView(v: MountedGameView | null): void; getGameView(): MountedGameView | null;
  // store: paused: boolean; setPaused(on: boolean): void  (Play/Stop resets paused=false; pause() also zeroes accumulator — existing behavior)
  ```

- [ ] Runtime getters (omit `fn`/`onComplete`/`holder` closures — plain serializable data only). Tests: after `ctx.after`/`ctx.tweenTo` in a script, snapshot lists them with correct remaining/elapsed; unknown entity → null.
- [ ] `stepFrame` determinism test: pause → 3× stepFrame ≡ run(3) unpaused (compare an entity position trace).
- [ ] Toolbar: Pause toggle (`⏸`/`▶` state label, enabled while playing) and Step button (enabled only while playing && paused), same button-group pattern as Play/Stop; both call gameViewRef methods + store.setPaused. GamePreview: `setGameView(view)` on mount, `setGameView(null)` + paused reset on destroy/Stop.
- [ ] LivePanel: while playing, 100ms `setInterval` poll (Timeline.tsx:169-172 interval-with-cleanup shape; poll only when panel visible — use the ConsolePanelHost visibility pattern, Workspace.tsx:103-118). Entity `<select>` (from `runtime.getEntities()`, seeded from `store.selection` when it matches a runtime id — spawned entities appear here too), then read-only typed rows: name/id/tags/enabled, world position, PhysicsBody velocity (when present), timers/tweens tables, last 10 `runtime.events` (name + frame), plus a header line: frame counter + entity count. Empty states: "Press Play to inspect the running game." No raw JSON anywhere.
- [ ] Suites + typecheck; commit.

### Task 10: PostEffectsField typed control + one-undo corner drags

**Files:**
- Create: `apps/editor/src/components/PostEffectsField.tsx` (+ pure row-model helper `apps/editor/src/postEffectsList.ts`)
- Modify: `apps/editor/src/components/Inspector.tsx` (special-case `Camera.postEffects` before the generic dispatch :751-852)
- Modify: `apps/editor/src/components/SceneView.tsx` (commitHandleDrag :691-777 → one setProperties)
- Test: `apps/editor/tests/postEffectsList.test.ts`; SceneView smoke additions

**Interfaces:**
- Consumes: Task 5's `POST_EFFECT_TYPES` + PostEffect defaults via `inspectComponents` enums/defaults (componentDocs store field), Task 2's `setProperties`, `exec` (store.ts:614).
- Produces: Inspector renders `postEffects` as a typed list (NEVER JsonField); SceneView corner drags = ONE history entry.

- [ ] `postEffectsList.ts` pure helpers: `addEffect(stack, type)` (append defaults from componentDocs defaults for that variant), `removeEffect(stack, i)`, `moveEffect(stack, i, dir)`, `updateEffect(stack, i, field, value)` — all return new arrays; cap 8 enforced (add disabled at cap). Tests cover all.
- [ ] PostEffectsField: one card per effect (type label + per-field typed inputs reusing existing `NumberField`/`ColorField` controls; sliders where ranges are 0-1), ↑/↓ reorder, ✕ remove, "Add effect" dropdown of the 6 types. Every change commits `exec('setComponentProperty', { property: 'Camera.postEffects', value: nextStack })` — one command per user action. Follow Vec2ListField/TileAssetsField patterns for layout/styling.
- [ ] Inspector wiring: field-level special case `type === 'Camera' && field === 'postEffects'` in the dispatch chain (before the JsonField fallthrough). SpriteEffects needs NO custom control (flat scalars/colors/bools render via existing branches) — verify by adding it to an entity in the running editor.
- [ ] SceneView: replace the `for (const [property, value] of commands) await setProp(...)` loop (:772-776) with a single `exec('setProperties', { scene, entity, properties: Object.fromEntries(commands) }, { quiet: true })` when `commands.length > 1` (keep single setComponentProperty for one property — cheaper). Update the doc comment at :674-690 (corner drags are now ONE undo step). Update the headless smoke expectations from Wave F Task 10.
- [ ] Suites + typecheck; commit.

### Task 11: Origin/Host enforcement on /api + WS

**Files:**
- Modify: `apps/editor/server/projectServer.ts` (guard at top of `route()` :700-704)
- Modify: `apps/editor/server/ws.ts` (upgrade handler :163-173)
- Create: `apps/editor/server/originGuard.ts` (pure helper) + `apps/editor/tests/originGuard.test.ts`, `apps/editor/tests/httpOrigin.test.ts`
- Modify: `apps/editor/tests/ws.test.ts` (origin cases)

**Interfaces:**
```ts
// originGuard.ts
export function isRequestAllowed(headers: { origin?: string; host?: string }): { ok: true } | { ok: false; reason: 'origin' | 'host' };
// Rules: no Origin header -> ok (CLI/curl/non-browser). Origin present -> parse URL; hostname must be
// 'localhost' | '127.0.0.1' | '::1' | '[::1]' (any port, http or https) else reject.
// Host present -> same hostname set (strip port) else reject (DNS-rebinding defense). Malformed Origin -> reject.
```

- [ ] Pure helper + exhaustive unit tests (allowed: absent origin, `http://localhost:5173`, `http://127.0.0.1:39271`; rejected: `https://evil.example`, `http://localhost.evil.example`, malformed `Origin: null` — reject `null` origin: sandboxed iframes/file pages have no business here; Electron loads over http://127.0.0.1 so it never sends `null`, verified main.ts:41-43,193).
- [ ] `route()`: first statement — on `!ok`, `sendJson(res, 403, { ok: false, error: 'Forbidden: cross-origin request rejected' })`. Applies to ALL /api routes uniformly (GET included — simpler and stricter than mutating-only; HttpFs/editor fetches are same-origin, CLI sends no Origin).
- [ ] `ws.ts` upgrade: after the pathname check, run the guard on `req.headers`; on failure write a minimal `HTTP/1.1 403 Forbidden\r\n\r\n` to the socket and `socket.destroy()` (before `wss.handleUpgrade`).
- [ ] `httpOrigin.test.ts`: boot `http.createServer((req,res) => handleApiRequest(ctx, req, res))` (ws.test.ts:41-51 server-boot pattern); assert 403 with evil Origin on `POST /api/command`, 200-path with localhost Origin and with no Origin. `ws.test.ts` additions: `new WebSocket(url, { headers: { Origin: 'https://evil.example' } })` → connection fails; localhost Origin → journal frames flow as before.
- [ ] Electron manual check note in ledger: packaged app still boots (HEARTH_SMOKE covers it in final task).
- [ ] Suites + typecheck; commit.

### Task 12: Editor code-split + bundle-size reporting

**Files:**
- Modify: `apps/editor/src/components/AgentPanel.tsx` (Terminal → React.lazy), `apps/editor/src/components/AssetsPanel.tsx` (SliceDialog → React.lazy, render inside Suspense only when open)
- Modify: `.github/workflows/ci.yml` (size log step after "Build editor")
- Modify: `docs/performance.md` (new `## Bundle sizes` section)
- Modify: `docs/desktop-app.md` (npm-audit waiver paragraph)

- [ ] `const Terminal = React.lazy(() => import('./agent/Terminal'))` — xterm + css move out of the main chunk (Terminal.tsx:20-22 is the only xterm import site; verify). Suspense fallback: the panel's existing loading/empty style. Same treatment for SliceDialog (mounted only when `sliceDialog` state is truthy, so lazy costs nothing on the common path). CodeEditor is already lazy (Task 7).
- [ ] Fresh `npm run build` for the editor; record before (index 1,227,045 B raw / 324,536 gz from the stale 2026-07-08 dist — rebuild first for an honest before) and after sizes of the top chunks. Target: main chunk materially down (xterm + CM out); record actuals, no fantasy numbers.
- [ ] ci.yml after the Build editor step:
  ```yaml
  - name: Report editor chunk sizes
    run: ls -S apps/editor/dist/assets/*.js | head -8 | xargs -I{} sh -c 'printf "%8d  %s\n" "$(wc -c < {})" "{}"'
  ```
- [ ] `docs/performance.md` `## Bundle sizes`: editor main chunk before/after table, `hearth-player.js` size + Task 6 effects delta, the player budget test pointer, and one line on how to re-measure.
- [ ] `docs/desktop-app.md`: audit posture paragraph — prod deps 0 vulnerabilities; dev-tooling advisories (electron/electron-builder/esbuild) deferred as breaking bumps, revisit next toolchain wave.
- [ ] Suites + typecheck (lazy imports can break TS project refs — verify); commit.

### Task 13: Ember Arcade example (10th) — effects showcase

**Files:**
- Modify: `packages/examples/generate.mjs` (new `generateEmberArcade()` + registration in main)
- Modify: `packages/examples/tests/examples.test.ts`
- Regenerate: all examples

**Interfaces:**
- Consumes: Tasks 3 (seeded ids), 5 (schemas/ctx.effects/assertPostEffect), 6 (filters — for screenshot sanity, not required by headless tests).

- [ ] All-Lua mini-arcade: a scene with `Camera.postEffects: [crt, vignette, bloom]`; a player that shoots/touches targets — targets `ctx.effects.flash` on hit and dissolve out (script animates `dissolveAmount` 0→1 then `ctx.scene.destroy`); a UIToggle "CRT" wired to add/remove the crt entry via `ctx.getComponent('Camera')` mutation (proves scripts can drive the stack).
- [ ] Playtests (probe-derived, GameSession.create → stepAsync → read; NEVER hand-computed — fp spawn timing is real): `assertPostEffect crt active:true` at start; toggle interaction then `assertPostEffect crt active:false`; `assertProperty` on a target's `SpriteEffects.flashStrength` mid-decay frame (probe the exact value); dissolve completion → entity count assertion.
- [ ] Regenerate ALL examples (seeded ids → tree stays byte-stable; `git diff` shows only the new example + generator). examples.test.ts: Ember Arcade playtests pass; 10-example count assertions updated.
- [ ] Suites + typecheck; commit.

### Task 14: Docs truth pass + counts + v0.10.0

**Files:**
- Create: `docs/effects.md`
- Modify: `docs/editor.md` (Code panel, Live panel, Pause/Step), `docs/scripting.md` (checkScript, ctx.effects, completion note), `docs/cli.md` (check-script, set-many), `docs/mcp.md` (check_script, set_properties), `docs/components.md` (SpriteEffects, Camera.postEffects), `docs/project-format.md` (version literal, postEffects), `docs/performance.md` (verify Task 12 section), `docs/roadmap.md`, `README.md`, `packages/mcp-server/README.md`, `packages/core/src/agentFiles.ts` (AGENTS.md generation — verify new ctx/commands/component appear; regenerate examples after)
- Modify: version to 0.10.0 — all package.json + package-lock + the 3 constants (grep `0\.9\.0` exactly like the Wave F Task 12 commit)

- [ ] `docs/effects.md`: postEffects catalog (all 6 types, params, ranges, order semantics, max 8, no-op defaults), SpriteEffects fields, `ctx.effects.flash`, `assertPostEffect`, determinism notes, export/works-in-player note, pixel-test pointer.
- [ ] Verify counts BY RUNNING them (Wave F found drift): expect **62 commands, 61 MCP tools, 18 components, 10 examples** — if actuals differ, the numbers in README/agents/mcp README follow reality, not this plan.
- [ ] AGENTS.md regen check: `hearth inspect api` shows effects.flash; component docs show SpriteEffects; regenerate all examples (their AGENTS.md embeds update).
- [ ] Version bump 0.10.0 everywhere + regen; full `npx vitest run` + `npm run typecheck`; commit.

---

## Final verification (controller, after all tasks)

- Whole-branch final review (fable) with live probes — house pattern.
- `HEARTH_SMOKE=1` Electron self-test at 0.10.0 (also exercises Task 11 origin guard in the packaged app).
- Tag v0.10.0 → release workflow (11 assets) → website sync + deploy (docs pages for effects/editor updates; no example showcase on the website).
