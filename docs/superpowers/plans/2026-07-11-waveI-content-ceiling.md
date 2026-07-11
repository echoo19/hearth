# Wave I — Content Ceiling (v0.12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.12.0: animation state machines, 47-blob tilemap autotiling, live-linked prefabs with per-field overrides, in-scene particle preview, atomic bulk asset import, and an ember-horde prefab showcase — with full editor + CLI + MCP parity and Wave H live-patch integration.

**Architecture:** All new capability flows through `HearthSession.execute` commands with strict Zod schemas; runtime additions are pure fixed-step steppers mirroring `animator.ts`/`particles.ts`; editor work extends the existing Inspector/SceneView/Assets-panel patterns and the Wave H live-patch dispatcher (`apps/editor/src/livePatch.ts` + `session.ts extractJournalDetail`).

**Tech Stack:** TypeScript ESM NodeNext (relative imports need `.js`), npm workspaces (NOT pnpm), Zod, vitest (does NOT typecheck — always also run `npm run typecheck`), React 18 + zustand + dockview, PixiJS v8, wasmoon, commander CLI, MCP server.

**Spec:** `docs/superpowers/specs/2026-07-11-waveI-content-ceiling-design.md` — binding for all requirements; this plan adds file-level decomposition. Where they conflict, the spec governs.

## Global Constraints

- **Command counts after wave:** 70 core commands (65 + `createStateMachineAsset`, `updateStateMachineAsset`, `setTileAutotile`, `revertPrefabOverride`, `importAssets`), 67 MCP tools (62 + 5). Docs/README counts must say 70/67.
- **Parity in-task:** every new command lands in `packages/core/src/commands/registry.ts` + `packages/mcp-server/src/tools.ts` + `packages/cli/src/program.ts` in the same task as the core command.
- **Live-patch dual wiring:** any command that should live-update the running preview needs BOTH a `session.ts extractJournalDetail` entry (targets only, never values) AND a `apps/editor/src/livePatch.ts` classification. Unwired commands fall back to the restart badge — acceptable only where the spec says "structural/none".
- **Strict Zod:** all schemas `.strict()`; every component field has `.default(...)`; bare `{}` must parse for any component. Baseline/older-file reads use `safeParse` + raw fallback, never `.parse`.
- **Dynamic imports:** never add `import('literal')` for optional/wasm deps — esbuild AND vite statically resolve literals. Route specifiers through a `const` (see `packages/core/src/format.ts` header).
- **Examples CI gate:** any change that alters example output requires `npm run build -w @hearth/core && node packages/examples/generate.mjs` and committing the regen IN THE SAME COMMIT. The version bump commit MUST include the examples regen (embedded `hearthVersion`).
- **No AI attribution** in any commit or PR: no Co-Authored-By, no "Generated with" lines. Plain human-voice imperative commit messages.
- **Editor UI uniformity:** no raw JSON fields in the Inspector or any editor surface — typed controls only. Palette: neutral charcoal surfaces + ember accents.
- **Test hygiene:** vitest + `npm run typecheck` before every commit claim. Keybind tests must be platform-independent.
- **Staging discipline:** implementers stage explicit paths (`git add <paths>`), never `git add -A`.
- **Bundle boundaries:** only `apps/editor/src/components/code/CodeEditor.tsx` may value-import CodeMirror; editor may import from `@hearth/runtime` only pure modules (particles, autotile resolver via core) — no Pixi into the editor main chunk.

## Parallelization lanes

Contention files: `schema/components.ts`, `schema/project.ts`, `commands/registry.ts`, `session.ts`, `mcp-server/src/tools.ts`, `cli/src/program.ts` (Lane A, sequential). Editor files partition cleanly (Lane C). Runtime files (Lane B).

- **Lane A (core, strictly sequential):** T1 → T3 → T5 → T6 → T10 → T13
- **Lane B (runtime):** T2 (after T1), T4 (after T3)
- **Lane C (editor):** T9 (no deps — start immediately), T7 (after T6), T8 (after T1+T2)
- **Integration tail (sequential):** T11 (after T1,T2,T3,T6,T10) → T12 → T14 → T15 → T16

Parallel implementers must have disjoint file sets; the controller enforces lane order.

---

### Task 1: State-machine asset schema + commands (core + CLI + MCP)

**Files:**
- Modify: `packages/core/src/schema/project.ts` (add `StateMachineDataSchema`, `STATEMACHINES_DIR = 'assets/statemachines'`, asset type `'stateMachine'` wherever asset types are enumerated)
- Create: `packages/core/src/commands/stateMachineCommands.ts`
- Modify: `packages/core/src/commands/registry.ts` (+2 commands, new "state machines" group comment)
- Modify: `packages/core/src/session.ts` (`extractJournalDetail`: `createStateMachineAsset` → `{name}`, `updateStateMachineAsset` → `{assetId}`)
- Modify: `packages/core/src/commands/assetCommands.ts` or inspect path so `inspectAsset` returns parsed ASM data for `type === 'stateMachine'`
- Modify: `packages/cli/src/program.ts` (create/set subcommands per house style, `--data <json|@file>` accepted)
- Modify: `packages/mcp-server/src/tools.ts` (`create_state_machine_asset`, `update_state_machine_asset`)
- Test: `packages/core/src/commands/stateMachineCommands.test.ts`, schema tests beside existing project-schema tests

**Interfaces:**
- Produces: `StateMachineDataSchema` (exported), TS type `StateMachineData`; commands `createStateMachineAsset { name, data } → { assetId, path }`, `updateStateMachineAsset { assetId, data } → { assetId }`; error codes `ASM_ANIMATION_NOT_FOUND`, plus standard validation errors. Asset files at `assets/statemachines/<slug>.asm.json`.

**Schema (verbatim from spec):** params record `{type: 'bool'|'number'|'trigger', default?}`; states array (min 1) `{name unique non-empty, animation: assetId string, speed: number > 0 default 1}`; `initial` names a state; transitions `{from: stateName|'any', to: stateName, conditions: [{param, op: eq|neq|gt|gte|lt|lte, value}] , exitTime?: 0..1}`. superRefine: initial exists; from/to valid; condition params exist; bool params → eq/neq only; trigger conditions are `{param}` only (no op/value); each transition needs ≥1 condition OR exitTime; from-'any' needs ≥1 condition; duplicate state names rejected. Animation ids validated against the asset index at command time (`ASM_ANIMATION_NOT_FOUND`), not in schema.

**Steps (TDD):**
- [ ] Failing schema tests: round-trip valid doc; rejects bad initial, unknown condition param, trigger with op, dup state names, empty transition (no conditions, no exitTime), from-'any' without conditions, speed ≤ 0.
- [ ] Implement `StateMachineDataSchema` + superRefine; tests pass.
- [ ] Failing command tests: create writes file + registers asset (type `stateMachine`), slug/name collision behavior matches other asset creates; create/update with unknown animation id → `ASM_ANIMATION_NOT_FOUND`; update replaces doc; undo restores prior doc; journal detail shapes; permission `asset-edit`; `inspectAsset` returns parsed data.
- [ ] Implement commands + registry + journal detail; tests pass.
- [ ] CLI + MCP entries; parity test per house pattern (existing CLI/MCP invocation tests as template).
- [ ] `npm run typecheck && npx vitest run` (workspace-scoped ok); commit in logical chunks.

---

### Task 2: AnimationStateMachine component + runtime stepper + ctx.animator

**Files:**
- Modify: `packages/core/src/schema/components.ts` (`AnimationStateMachineSchema { assetId: string default '', playing: boolean default true }`, register in `COMPONENT_SCHEMAS`/`COMPONENT_DOCS`)
- Create: `packages/runtime/src/stateMachine.ts`
- Modify: `packages/runtime/src/runtime.ts` (own `SmState` per entity — created lazily, reaped on destroy, mirrors animator/particle state; step order: state machine BEFORE plain animator; if both components present, SM wins + one-time warning)
- Modify: runtime script-context files (Lua + JS) adding `ctx.animator.setParam/getParam/fire/state` with the id-or-unique-name entityRef convention; errors are script errors (line info applies)
- Test: `packages/runtime/src/stateMachine.test.ts` + runtime integration tests beside existing animator tests

**Interfaces:**
- Consumes: `StateMachineDataSchema`/`StateMachineData` from Task 1.
- Produces: `SmState` type; `stepStateMachine(smState, component, asset, animAssets, fixedDt)` pure function; `createSmState(asset)` initializing params from defaults; runtime exposes per-entity SM state lookup used later by Task 11's bridge (`getSmState(entityId)` or equivalent export).

**Semantics (verbatim from spec):** transitions evaluated in declaration order, explicit `from: current` before `from:'any'`, first eligible wins; eligibility = all conditions true AND (no exitTime or clip progress ≥ exitTime); on transition reset clip to frame 0 and consume ONLY triggers named in the taken transition's conditions; unconsumed triggers latch; self-transition only via 'any' (restarts clip); state's clip advances with `speed` multiplier and writes `{assetId, frame}` into sibling SpriteRenderer (reuse `stepAnimator` frame math — extract shared helper rather than duplicating); deterministic; SmState survives hot-reload (owned by runtime entity state).

**Steps (TDD):**
- [ ] Failing stepper goldens: bool/number/trigger conditions, exitTime gating, any-state, declaration-order priority, trigger consumption + latch, speed scaling, non-loop clip end behavior, determinism (two identical runs → identical frame sequences).
- [ ] Implement `stateMachine.ts`; goldens pass.
- [ ] Failing runtime integration: entity with SM component animates SpriteRenderer; SM+SpriteAnimator both present → SM wins + single warning; destroy reaps state; hot-reload (`reloadScript`) leaves SmState intact.
- [ ] Wire into runtime step loop; tests pass.
- [ ] ctx.animator bindings (Lua + JS) + tests: setParam type errors, fire/consume round-trip through a scripted transition, `state()` returns current name; unknown param → script error.
- [ ] Typecheck + vitest; commit.

---

### Task 3: Autotile resolver + Tilemap schema union + setTileAutotile (core + CLI + MCP)

**Files:**
- Create: `packages/core/src/tilemap/autotile.ts`
- Modify: `packages/core/src/schema/components.ts` (`TilemapSchema.tileAssets` value union: `z.string()` | `z.object({ sheet: z.string(), template: z.literal('blob47'), mapping: z.record(z.string()).optional() }).strict()`)
- Create: `packages/core/src/commands/autotileCommands.ts` (or extend `tilemapCommands.ts` if cleaner — one command)
- Modify: `packages/core/src/commands/registry.ts`, `packages/core/src/session.ts` (detail `{scene, entity, char}`), `packages/cli/src/program.ts`, `packages/mcp-server/src/tools.ts` (`set_tile_autotile`)
- Modify: `packages/core/src/commands/componentCommands.ts` ONLY if the path validator needs a guard so `setComponentProperty` cleanly rejects writes into the object arm of the union (error message pointing at `setTileAutotile`)
- Test: `packages/core/src/tilemap/autotile.test.ts`, command tests

**Interfaces:**
- Produces: `AUTOTILE_SHAPES` (exported array of the 47 canonical shape keys), `computeMask(grid, row, col, char) → number` (8-neighbor bitmask, out-of-bounds counts as same), `maskToShape(mask) → shapeKey` (corner bits masked out when adjacent edges absent — 256→47 reduction), `resolveTileFrame(rule, mask) → { sheet, frame }`, `BLOB47_TEMPLATE: Record<shapeKey, frameName>` (standard blob template layout; frame naming convention documented in code + docs). Command `setTileAutotile { entity, char, sheet, template?: 'blob47', mapping?, clear?: true }`, permission `safe-edit`, validates sheet is a spritesheet asset and all mapped frame names resolve (`AUTOTILE_SHEET_NOT_FOUND` / `AUTOTILE_FRAME_MISSING`).

**Steps (TDD):**
- [ ] Failing resolver tests: golden table covering all 47 shapes, corner-reduction cases (corner without both edges ignored), out-of-bounds-as-same at all four map edges, purity (no mutation).
- [ ] Implement resolver; tests pass.
- [ ] Failing schema tests: string arm unchanged (back-compat: existing example scenes parse), object arm round-trips, unknown template rejected.
- [ ] Failing command tests: set/clear rule; sheet/frame validation errors; journal detail; undo; `setComponentProperty` into the object arm rejected with pointer to `setTileAutotile`.
- [ ] Implement schema union + command + registry/CLI/MCP wiring; all tests pass.
- [ ] Typecheck + vitest; commit.

---

### Task 4: Autotile rendering (runtime + editor SceneView + Inspector)

**Files:**
- Modify: runtime tilemap rendering (locate via `packages/runtime/src/` tilemap renderer) — when a char's rule is an autotile object, draw `resolveTileFrame(rule, computeMask(...))` from the sheet
- Modify: `apps/editor/src/components/SceneView.tsx` (`renderTilemap` ~1074-1114 and `renderPaintPreview` ~1123-1163) — resolve autotile frames; preview may fall back to plain tile-at-cursor where resolving the stroke is expensive (must not regress paint responsiveness)
- Modify: `apps/editor/src/components/Inspector.tsx` (tileAssets char-row editor ~205-436): per-char mode toggle sprite/autotile; autotile mode = sheet dropdown (spritesheet assets) + template select (blob47) + collapsed advanced per-shape mapping editor (frame dropdowns); writes via `setTileAutotile`
- Test: runtime render tests beside existing tilemap render tests; editor unit tests for any extracted pure helpers

**Interfaces:**
- Consumes: Task 3's resolver exports and command. Colliders and grid semantics untouched (grid-identity collider cache must keep working — do not clone grids in render paths).

**Steps (TDD):**
- [ ] Failing runtime test: tilemap with autotile char renders resolved frames per neighbor mask; painting a cell (new grid identity) re-resolves neighbors.
- [ ] Implement runtime rendering; test passes.
- [ ] SceneView rendering + paint preview; extract mask/frame lookups into a memoized helper if needed.
- [ ] Inspector UI (typed controls only); manual check via `npm run dev` noted in report.
- [ ] Typecheck + vitest; commit.

---

### Task 5: Prefab live-link data model + implicit override recording (core)

**Files:**
- Modify: `packages/core/src/schema/scene.ts` (marker: `prefab: z.object({ asset: z.string(), ids: z.record(z.string()).default({}), overrides: z.array(z.object({ entity: z.string(), component: z.string(), path: z.string(), value: z.unknown() }).strict()).default([]) }).optional()`)
- Modify: `packages/core/src/project/prefabData.ts` (`instantiatePrefabData` returns the localId→sceneId map; `serializePrefab` unaffected)
- Modify: `packages/core/src/commands/prefabCommands.ts` (`instantiatePrefab` writes `ids`)
- Modify: `packages/core/src/commands/componentCommands.ts` + `entityCommands.ts` (moveEntity/position): after successful write, if target is inside an instance subtree (locate via root markers' `ids` in the same scene), record/replace override on root marker. Exclusions: root `name`, root `Transform.position`, `enabled` — never recorded.
- Modify: `inspectEntity` (wherever it lives in inspect commands): add `prefab: { asset, root, localId, overridden: [{component, path}] }` for instance members
- Test: prefab data tests + command tests beside existing ones

**Interfaces:**
- Produces: marker shape above (defaults keep old scenes parsing; instances without `ids` are "legacy-detached" — behave as today until a sync repopulates ids); helper `findInstanceMembership(scene, entityId) → { rootId, asset, localId } | null` (exported for Task 6); override record `{entity, component, path, value}`.

**Steps (TDD):**
- [ ] Failing schema tests: old marker `{asset}` parses (defaults); new fields round-trip.
- [ ] Failing instantiate tests: `ids` maps every prefab local id to the spawned scene id.
- [ ] Failing override-recording tests: setComponentProperty on instance child records override (replace-not-append on same path); setProperties records one per key; moveEntity on a NON-root instance member records Transform.position override, on root does not; `enabled`/root name never recorded; edits to non-instance entities record nothing; undo removes the override record along with the value change (both live in the same command mutation).
- [ ] Implement; tests pass. Failing inspectEntity test → implement.
- [ ] Typecheck + vitest; commit.

---

### Task 6: Prefab merge sync, auto-sync, revert, structural detach (core + CLI + MCP)

**Files:**
- Modify: `packages/core/src/commands/prefabCommands.ts` (`syncPrefabInstances` → merge; `updatePrefab` → auto-sync all instances project-wide, single undo entry, result `{instancesSynced, overridesPreserved, overridesDropped}`)
- Modify: `packages/core/src/project/prefabData.ts` (merge helper: rebuild subtree reusing `ids`; fresh ids for new prefab entities; delete removed; update `ids`; preserve root id/name/Transform.position/enabled; re-apply overrides; drop stale overrides with `PREFAB_OVERRIDE_STALE` warning)
- Create: `revertPrefabOverride` command in `prefabCommands.ts` — `{ entity, component?, path? }`, write-through restore of prefab value(s), removes records, permission `safe-edit`
- Modify: entity/component structural commands (add/remove entity or component inside an instance subtree, incl. root component add/remove) → detach: remove marker, warning `PREFAB_INSTANCE_DETACHED` in result
- Modify: `registry.ts` (+1), `session.ts` (revert detail `{scene, entity, component?, path?}`; updatePrefab/sync details as today), `cli/program.ts` (`hearth prefab revert <entity> [component] [path]`), `mcp-server/src/tools.ts` (`revert_prefab_override`)
- Test: prefab command tests

**Interfaces:**
- Consumes: Task 5's marker/helpers. Produces: merge behavior later tasks (T7 UI, T12 example) rely on; scene entity ids stable across sync.

**Steps (TDD):**
- [ ] Failing merge tests: sync preserves scene ids via `ids`; new prefab child gets fresh id + ids entry; removed child deleted; overrides re-applied; stale override dropped + warning; root name/position/enabled preserved; legacy (no-ids) instance falls back to full rebuild then becomes linked.
- [ ] Implement merge; tests pass.
- [ ] Failing auto-sync tests: updatePrefab syncs all instances across all scenes in one undo entry; result counts correct; undo restores every instance AND the prefab file.
- [ ] Failing revert tests: field / whole-component / whole-entity revert restore prefab values and drop records; reverting a non-overridden path is a no-op success.
- [ ] Failing detach tests: add/remove entity/component inside instance removes marker + warns; subsequent edits record no overrides.
- [ ] Implement + registry/CLI/MCP parity; all tests pass; typecheck + vitest; commit.

---

### Task 7: Prefab live-link editor UI

**Files:**
- Modify: `apps/editor/src/components/Inspector.tsx` (ember dot before overridden field labels; per-field "Revert to prefab" action; instance banner gains override count + "Revert all"; detached state messaging)
- Modify: `apps/editor/src/prefabActions.ts` (sync-preflight copy → merge semantics; helpers for override counts)
- Modify: hierarchy/toast surface for one-time "instance detached" toast (follow existing toast/log pattern)
- Test: editor unit tests for pure helpers (override lookup per field path)

**Interfaces:**
- Consumes: `inspectEntity`'s `prefab.overridden` list (Task 5), `revertPrefabOverride` (Task 6). Dot styling uses the ember accent variable already in the palette.

**Steps:**
- [ ] Pure helper + tests: `isFieldOverridden(prefabInfo, component, path)` handling nested paths (a recorded `Transform.position` override marks `position.x` and `position.y` rows).
- [ ] Inspector wiring: dot, revert actions (dispatch `revertPrefabOverride`, rely on journal refresh), banner count + Revert all with confirm.
- [ ] Preflight copy + detach toast.
- [ ] Typecheck + vitest + manual `npm run dev` pass noted in report; commit.

---

### Task 8: Animator editor (structured list UI)

**Files:**
- Create: `apps/editor/src/components/AnimatorEditor.tsx` (+ small pure module `apps/editor/src/asmEdit.ts` for draft-doc reducers so logic is unit-testable)
- Modify: `apps/editor/src/workspace/layout.ts` (`PANEL_IDS` + `PanelId` add `animator`; bump `LAYOUT_VERSION` only if required by validation — adding an id must not invalidate stored layouts; verify `isValidDockviewLayout` tolerates additions)
- Modify: `apps/editor/src/workspace/Workspace.tsx` (`PANEL_COMPONENTS`, `PANEL_TITLES`, `VIEW_MENU_PANELS`, `showPanel`; NOT in `buildDefaultLayout` — opened on demand)
- Modify: `apps/editor/src/components/AssetsPanel.tsx` (stateMachine asset card: "Edit state machine" opens the panel targeting that asset)
- Modify: `apps/editor/src/components/Inspector.tsx` (`AnimationStateMachine.assetId` → dropdown of `type === 'stateMachine'` assets, mirroring the SpriteAnimator special case at ~679-683, + "Edit" button opening the panel)
- Modify: `apps/editor/src/store.ts` (small seam: `openAnimatorFor(assetId)` — coordinate with controller; store.ts is a contention file, keep the diff minimal)
- Test: `apps/editor/src/asmEdit.test.ts`

**Interfaces:**
- Consumes: `StateMachineData` shape (Task 1), `updateStateMachineAsset` via the existing exec/API layer, `AnimationStateMachine` component (Task 2).
- UI contract (spec): Params table (name, type select, default), States list (name, animation dropdown of `type==='animation'` assets, speed field, initial marker), Transitions table (from select incl. Any, to select, exitTime optional 0..1, condition rows with param select / op select scoped to param type / value input, add+remove). Save = one `updateStateMachineAsset` (single undo entry); command validation errors render inline. No raw JSON anywhere.

**Steps:**
- [ ] `asmEdit.ts` reducers + failing tests: add/remove/rename param (renaming a param updates or flags dependent conditions), add/remove state (deleting the initial state forces choosing a new initial; deleting a state removes/flags its transitions), transition condition op choices per param type, doc → save payload.
- [ ] Implement reducers; tests pass.
- [ ] Panel component + registration + entry points (Assets card, Inspector row).
- [ ] Inspector assetId dropdown special case.
- [ ] Typecheck + vitest + manual pass; commit.

---

### Task 9: Particle preview in Scene view (editor-only — no core deps, start anytime)

**Files:**
- Create: `apps/editor/src/particlePreview.ts` (manages `EmitterState`s for selected entities' ParticleEmitters; fixed-dt stepping on a rAF ticker; gating: Scene panel visible AND toggle on AND ≥1 selected emitter; reset on relevant component/Transform change; expose `getPreviewParticles(entityId)` snapshot for rendering)
- Modify: `apps/editor/src/components/SceneView.tsx` (draw live particles — position, size + color interpolation start→end — at emitter world position for selected emitters; unselected keep the cone gizmo at ~1268-1296; toolbar "Particles" toggle, default ON, persisted in localStorage alongside existing editor prefs)
- Test: `apps/editor/src/particlePreview.test.ts` (gating, reset-on-edit, determinism — seedable, no Date.now/Math.random)

**Interfaces:**
- Consumes: `EmitterState` from `@hearth/runtime` `particles.ts` (pure — verify it's exported from the package root; if not, add the export in `packages/runtime/src/index.ts` as part of this task; that file is otherwise uncontended).
- Perf guard: only selected emitters simulate; ticker stops when none selected; respects `maxParticles` (≤2048).

**Steps (TDD):**
- [ ] Failing tests: ticker starts/stops on selection + visibility + toggle transitions; identical seeds → identical snapshots; changing an emitter field resets that emitter's state only.
- [ ] Implement `particlePreview.ts`; tests pass.
- [ ] SceneView rendering + toolbar toggle (SVG circles with interpolated fill/opacity/size — match existing gizmo rendering idiom).
- [ ] Typecheck + vitest + manual `npm run dev` verification (drag gravity/spread in Inspector → live update) noted in report; commit.

---

### Task 10: Bulk asset import (core + CLI + MCP + editor)

**Files:**
- Modify: `packages/core/src/commands/assetCommands.ts` — extract `importAsset`'s copy/probe/register internals into a shared helper; add `importAssets { sourcePaths: string[], type?: string }` → `{ imported: [{path, assetId, name, type}], skipped: [{path, code, message}] }`; one atomic journal/undo entry covering all imported files; collision-safe auto-naming (`-2`, `-3`…) reported in result; permission `asset-edit`
- Modify: `registry.ts` (+1), `session.ts` (detail `{count, types}`), `cli/program.ts` (multi-path import per house style, `--recursive` for directories), `mcp-server/src/tools.ts` (`import_assets`)
- Modify: `apps/editor/src/components/AssetsPanel.tsx` (`importFiles()` ~320-380 collects FileList into ONE `importAssets` call; folder drop via `webkitGetAsEntry` recursive traversal in the drop handler ~465-537; summary toast "Imported N, skipped M (reason)"; 25MB per-file cap stays client-side)
- Test: asset command tests; editor traversal helper unit test (extract pure `collectDropEntries`)

**Interfaces:**
- Consumes: nothing new. Produces: `importAssets` used by AssetsPanel and documented for agents. `importAsset` (single) remains unchanged in behavior.

**Steps (TDD):**
- [ ] Failing command tests: multi-file import registers all + one journal entry; undo removes all files + index entries; per-file skips (missing file, unknown extension without `type`, oversize if core enforces size — else skip reason comes only from validation) with codes; name collisions auto-suffixed and reported; `type` override applies to all.
- [ ] Implement helper refactor + command; tests pass (existing `importAsset` tests still green).
- [ ] Registry/CLI/MCP parity + tests.
- [ ] AssetsPanel single-call + folder drop + toast; extract + test `collectDropEntries`.
- [ ] Typecheck + vitest; commit.

---

### Task 11: Live-patch integration for Wave I commands

**Files:**
- Modify: `apps/player/src/runtimeBridge.ts` (or wherever `MountedGameView` seams live — Wave H put `reloadScript`/`patchComponent` there): add `reloadStateMachineAsset(assetId, data)` → swap parsed asset, reset affected entities' SmState to `initial` (params re-defaulted); verify tilemap/prefab patches flow through existing `patchComponent`/refresh paths
- Modify: `packages/runtime/src/runtime.ts` (support seam for the above: replace asset + reset SmStates)
- Modify: `apps/editor/src/livePatch.ts` (`classifyLocal` + `classifyJournal`): `updateStateMachineAsset` → asm-reload action; `setTileAutotile` → patch (re-read tilemap component + refresh, same lane as paints); `revertPrefabOverride` → patch (re-read affected entity post-refresh, valueless like Wave H property patches); `syncPrefabInstances`/`updatePrefab` → structural (restart badge); `importAssets`/`createStateMachineAsset` → none
- Modify: `apps/editor/src/store.ts` (dispatch handling for the new action kinds — minimal diff)
- Test: `apps/editor/src/livePatch.test.ts` classification tests; runtime test for `reloadStateMachineAsset` reset semantics

**Interfaces:**
- Consumes: journal details from T1/T3/T6/T10 (already emitted), runtime SmState (T2), `MountedGameView` seam pattern from Wave H.

**Steps (TDD):**
- [ ] Failing classification tests for every new command in both local and journal paths (external agent parity).
- [ ] Failing runtime test: reloadStateMachineAsset swaps doc + resets SmState, leaves other entity state alone.
- [ ] Implement bridge + dispatcher + store handling; tests pass.
- [ ] Manual verification: `hearth set …` autotile + ASM update from a second terminal live-update a running preview; note in report.
- [ ] Typecheck + vitest; commit.

---

### Task 12: Examples — ember-horde prefab showcase, sky-courier ASM, glow-caves autotile

**Files:**
- Modify: `packages/examples/generate.mjs` (ember-horde: replace disabled "Enemy Template" entity + hand-mirrored table in `horde-director.lua` with `createPrefab` → `assets/prefabs/enemy.prefab.json`, director spawns via `ctx.scene.spawnPrefab('enemy', …)`, plus ≥1 placed instance with a per-field override e.g. tinted elite; sky-courier: idle/walk via state machine with `moving` bool param set from the movement script; glow-caves: one terrain char converted to a blob47 autotile rule)
- Modify: `packages/examples/pixelart.mjs` (generate a blob-template spritesheet for glow-caves)
- Modify: committed example project files (regen output)
- Test: existing example playtest assertions must pass; extend ember-horde assertions to cover prefab spawns if the house pattern supports it

**Interfaces:**
- Consumes: T1/T2 (ASM), T3/T4 (autotile), T5/T6 (prefab overrides), runtime `spawnPrefab` (existing).

**Steps:**
- [ ] Update `pixelart.mjs` + `generate.mjs`; run `npm run build -w @hearth/core && node packages/examples/generate.mjs`.
- [ ] `git status` — commit ALL regen output with the generator changes in one commit (CI clean-tree gate).
- [ ] Run `hearth test` on the touched examples (same invocations as `.github/workflows/ci.yml`); all assertions pass.
- [ ] Regen a second time → `git diff --exit-code -- packages/examples` proves byte-identical.
- [ ] Typecheck + vitest; commit.

---

### Task 13: Ledger minors (on-theme fixes)

**Files:**
- Modify: `packages/core/src/commands/diffCommands.ts` (`loadBaseline`: project parse must be `safeParse` + raw fallback exactly like the per-scene handling from Wave H fix 524f7c7 — currently the PROJECT parse still throws on old baselines; crash bug)
- Modify: `packages/cli/src/program.ts` + arg parsing (`hearth create script` gains `--no-format` mapping to the `format: false` per-call override; set-settings bool parsing strict: accept only `true`/`false` (case-insensitive) and reject others with a clear error instead of loose truthiness)
- Test: diff command test with an old-shape baseline project file; CLI parse tests

**Steps (TDD):**
- [ ] Failing test: baseline with a project file that fails current schema parse → diff/revert still work via raw fallback.
- [ ] Fix `loadBaseline`; test passes.
- [ ] Failing CLI tests: `--no-format` passes `format:false`; `set-settings` rejects `yes`/`1` with clear error, accepts `TRUE`/`false`.
- [ ] Fix; tests pass; typecheck + vitest; commit.

**Note:** runs in Lane A (touches `program.ts`); schedule so it never overlaps T1/T3/T6/T10.

---

### Task 14: Documentation

**Files:**
- Modify: `docs/scripting.md` (ctx.animator API, both Lua and JS, param types + trigger semantics + hot-reload note), `docs/editor.md` (Animator editor, autotile UI + blob template layout reference with ASCII diagram of the frame-name convention, particle preview toggle, bulk/folder import, override dots + revert), `docs/prefabs.md` (rewrite live-link section: marker shape, implicit overrides, merge sync, auto-sync, detach rules; REMOVE the "Non-goals" lines this wave delivers; point example section at ember-horde), `docs/cli.md`, `docs/mcp.md`, `docs/agents.md` (recipes: build an ASM from scratch, autotile a map, override + revert an instance field, bulk import a folder), `docs/roadmap.md` (mark v0.12 shipped), `README.md` + `packages/mcp-server/README.md` (counts 70/67)
- Modify: `apps/editor/src/components/code/hoverDocs.ts` (ctx.animator entries)
- Test: docs link check if the house has one; hoverDocs unit test if pattern exists

**Steps:**
- [ ] Write all doc updates; verify every count says 70 commands / 67 MCP tools; verify no doc still claims prefab instances are copies.
- [ ] hoverDocs entries.
- [ ] Typecheck + vitest (hoverDocs); commit.

---

### Task 15: Polish + live verification + packaging checks

**Files:** small fixes anywhere surfaced by the pass; no new features.

**Steps:**
- [ ] `npm run dev`; browser pass over all six pillars: create + edit an ASM in the Animator editor and see sky-courier-style switching in play; autotile paint + Inspector rule UI; instance override dot + revert + auto-sync on prefab update; particle preview live-follows Inspector drags, toggle works; bulk folder drop imports with summary toast; ember-horde plays. Check palette conformance (charcoal + ember), no raw JSON fields, keyboard/discoverability.
- [ ] Wave H C-1-class packaging checks: build standalone CLI, run `hearth` in a node_modules-free dir exercising a new command (`setTileAutotile` on a temp project); build Electron bundle and verify `main.cjs` includes/uses the new core paths without dynamic-import breakage.
- [ ] Full `npm run typecheck && npx vitest run` at repo root; fix fallout; commit polish fixes with explicit paths.

---

### Task 16: Release v0.12.0 + website

**Steps:**
- [ ] Version bump to 0.12.0 across workspace packages (house bump script/process per previous release commits) AND regenerate examples IN THE SAME COMMIT (embedded `hearthVersion` — the I-1 lesson). Verify `git diff --exit-code -- packages/examples` after a second regen.
- [ ] Full test + typecheck green; commit bump; tag `v0.12.0`; push with tags.
- [ ] Watch the tag CI run to completion; verify 11/11 release assets.
- [ ] Website repo: sync counts (70/67), add/refresh content-tools feature copy (bento cell) for state machines / autotiling / live-linked prefabs; NO example showcase sections (standing rule). Push via `direnv exec . git push`, deploy `direnv exec . vercel --prod --yes`, live-verify at hearth-engine.vercel.app.
- [ ] Update `.superpowers/sdd/progress.md`, run note, and SecondBrain index.

---

## Self-review notes

- Spec coverage: P1→T1/T2/T8, P2→T3/T4, P3→T5/T6/T7, P4→T9, P5→T10, P6→T12; cross-cutting 1→in-task + counts, 2→T11, 3→T14, 4→T13, 5→T15, 6→T16. No gaps.
- Type consistency: `StateMachineData`/`StateMachineDataSchema` (T1) consumed by T2/T8/T11; `findInstanceMembership` (T5) consumed by T6; resolver exports (T3) consumed by T4; marker shape identical in T5/T6/T7.
- Known judgment calls delegated with bounds: exact CLI subcommand spelling follows `program.ts` house style (parity is the requirement); Animator ships as a dockview panel unless an existing overlay pattern fits better; `LAYOUT_VERSION` bumped only if stored-layout validation actually rejects added ids.
