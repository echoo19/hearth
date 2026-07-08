# Wave F: Editor Friendliness + Prefabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.9.0: a prefab system (tracked stamps — create/place/update/sync commands, runtime `ctx.scene.spawnPrefab`, editor surfaces) plus editor friendliness (plain-language chrome with visible Undo/Redo, a declarative keybind registry with a `?` cheat sheet, and direct-manipulation scale/rotate handles in the scene view).

**Architecture:** Prefabs are a new `'prefab'` asset type whose JSON payload is a serialized entity subtree in normalized local-id space (`pfe_N`); a pure `prefabData.ts` module owns serialize/instantiate/local-id math and is shared by four new registry commands, the runtime spawner, and validation — so assets inherit index/trash/history/undo for free. Editor friendliness is UI-layer only: string renames (agent-facing CLI/MCP untouched), one central keybind table driving both dispatch and the cheat-sheet render, and a pure `transformHandles.ts` geometry module powering on-canvas handles that commit exactly one command per gesture (the existing drag-move/vertex-editor pattern).

**Tech Stack:** TypeScript ESM NodeNext, zod, vitest, commander, MCP SDK, React + zustand + dockview, PixiJS, wasmoon.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-07-waveF-editor-friendliness-prefabs-design.md`. Where this plan and the spec conflict, stop and escalate.
- Every mutation flows through `HearthSession.execute` (packages/core/src/session.ts); CLI/MCP/editor are thin adapters — never bypass the registry.
- CLI/MCP parity lands **in the same task** as each core command: CLI verb in `packages/cli/src/program.ts` AND ToolSpec in `packages/mcp-server/src/tools.ts` (snake_case, mirrored zod inputShape).
- Human-facing copy changes NEVER rename CLI verbs, MCP tools, core command names, or AgentPanel CLI hint strings (`hearth snapshot`, `hearth diff` stay).
- Editor UI: typed cohesive controls, never raw JSON fields; follow existing panel patterns (zustand `useEditor`, `exec()`, `commandSeq`).
- Examples are GENERATED: edit `packages/examples/generate.mjs` only; playtest expectations are probe-derived, never hand-computed.
- Tests: root `npx vitest run` AND `npm run typecheck` must both pass at every commit (vitest does NOT typecheck). TS ESM: relative imports need `.js`.
- Runtime determinism: no new reads of the seeded RNG stream in fixed-order code paths; playtest report shapes stay stable.
- Version bumps to 0.9.0 happen only in the final task (mirror the 0.8.0 pattern: all package.json + constants).
- No AI attribution in commits. Plain human-voice commit messages.
- File-overlap sequencing: Tasks 1→2→3→4→5→6 share core/CLI/MCP/editor prefab files — execute in order. Tasks 7→8→9→10 share editor chrome/SceneView files — in order (9 is a pure new module but sits between 8 and 10 for review flow). Tasks 11→12 close the wave — in order, after everything else.
- Audit result baked into this plan (verified 2026-07-07): component schemas contain NO entity-id-typed fields (`packages/core/src/schema/components.ts` — only doc strings mention "entity"). Prefab remap therefore covers `id` + `parentId` only; Task 1 adds a guard comment + test so a future entity-ref field must update the remap helper.

---

### Task 1: Prefab schema + pure data module

**Files:**
- Create: `packages/core/src/project/prefabData.ts`
- Modify: `packages/core/src/schema/project.ts` (ASSET_TYPES ~:83 gains `'prefab'`; add `PrefabEntitySchema`, `PrefabDataSchema`, `PREFABS_DIR = 'assets/prefabs'` beside AnimationDataSchema ~:100-106)
- Modify: `packages/core/src/schema/scene.ts` (EntitySchema ~:18-26 gains optional `prefab: z.object({ asset: z.string() }).optional()`)
- Test: `packages/core/tests/prefabData.test.ts`

**Interfaces:**
- Consumes: `EntitySchema`, `ComponentMap`, `generateId` (existing core utils), `childrenOf`/BFS walk shape from `commands/entityCommands.ts:113-171`.
- Produces (later tasks rely on these exactly):
  ```ts
  // packages/core/src/schema/project.ts
  export const PrefabEntitySchema = /* Entity minus `prefab` marker, with local ids */;
  export type PrefabEntity = z.infer<typeof PrefabEntitySchema>;
  export const PrefabDataSchema = z.object({
    name: z.string().min(1),
    entities: z.array(PrefabEntitySchema).min(1), // root first; ids `pfe_<n>`; root.parentId === null
  });
  export type PrefabData = z.infer<typeof PrefabDataSchema>;

  // packages/core/src/project/prefabData.ts
  export function collectSubtree(entities: Entity[], rootId: string): Entity[]; // BFS, root first, stable order; throws HearthError NOT_FOUND if missing
  export function serializePrefab(name: string, entities: Entity[], rootId: string): PrefabData;
  // - normalizes ids to pfe_1.. in BFS order, remaps parentId, strips `prefab` markers from ALL entities (nested markers flattened per spec non-goal)
  export interface InstantiateOptions { position?: { x: number; y: number }; name?: string; preserveRootId?: string; }
  export function instantiatePrefabData(data: PrefabData, opts?: InstantiateOptions): Entity[];
  // - fresh ent_* ids (preserveRootId keeps a given root id — sync uses this), remaps parentId,
  //   applies opts.position to root Transform.position (creates Transform if absent), root name = opts.name ?? data.name
  export function validatePrefabLocalIds(data: PrefabData): string[]; // human-readable problems: non-root-first, dangling parentId, duplicate local ids, marker present
  ```
- NOTE for implementer: components are `structuredClone`d; NO component-field id remap is needed (audit above) — leave a `// If a component ever stores entity ids, remap here (see wave F plan)` comment at the remap site plus a test asserting no current component schema has a field named like `entityId`/`targetEntity` (grep-style over COMPONENT schema keys) so drift fails loudly.

**Steps:**
- [ ] **Step 1: Failing tests** in `packages/core/tests/prefabData.test.ts`: (a) collectSubtree returns root+descendants BFS root-first, ignores unrelated entities, throws on missing root; (b) serializePrefab normalizes to pfe_1.. with correct parentId remap and strips prefab markers from children AND root; (c) round-trip: instantiatePrefabData(serializePrefab(...)) yields fresh ent_* ids, intact hierarchy, position override applied, name default/override; (d) preserveRootId keeps the root id and remaps children only; (e) validatePrefabLocalIds catches each malformed shape; (f) EntitySchema accepts and round-trips the optional `prefab` marker and old scenes (no marker) still parse; (g) schema-key guard test per NOTE.
- [ ] **Step 2:** `npx vitest run packages/core/tests/prefabData.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement schema additions + `prefabData.ts`.
- [ ] **Step 4:** Test file → PASS; full `npx vitest run` + `npm run typecheck` → PASS (existing scene tests must be untouched by the additive field).
- [ ] **Step 5:** Commit `feat: prefab data schema and subtree serialization module`.

### Task 2: createPrefab + instantiatePrefab commands (+ CLI + MCP)

**Files:**
- Create: `packages/core/src/commands/prefabCommands.ts`
- Modify: `packages/core/src/commands/registry.ts` (register both)
- Modify: `packages/cli/src/program.ts` (new `prefab` command group: `hearth prefab create`, `hearth prefab place`)
- Modify: `packages/mcp-server/src/tools.ts` (ToolSpecs `create_prefab`, `instantiate_prefab`)
- Test: `packages/core/tests/prefabCommands.test.ts`, extend existing CLI + MCP test files (match their current location/pattern)

**Interfaces:**
- Consumes: Task 1 module; `registerAsset` unique-name rule (`assetCommands.ts:19-29`); `writeJson`/slug conventions from `createAnimationAsset` (`assetCommands.ts:222-264`); `ctx.changed()`/`ctx.warn()` recorders.
- Produces:
  ```ts
  // core commands (both mutates: true, permission matching createAnimationAsset's mode)
  createPrefab      params { scene: string; entity: string; name: string }
    → data { asset: Asset; entityCount: number }
    // serialize subtree → write assets/prefabs/<slug>.prefab.json → registerAsset type 'prefab'
    // (metadata: { entityCount }); source root entity GAINS marker { asset: <new ast id> }
  instantiatePrefab params { prefab: string; scene: string; position?: {x,y}; name?: string }
    → data { entity: Entity; entityCount: number }
    // resolve asset by id or name (follow existing asset-resolution helper), read+PrefabDataSchema.parse payload
    // (parse failure → HearthError PREFAB_DATA_INVALID), instantiate, root gains marker, append to scene
  ```
  - CLI: `hearth prefab create <scene> <entity> <name>`, `hearth prefab place <prefab> <scene> [--position x,y] [--name <n>]` — flag parsing mirrors existing position-flag verbs in program.ts.
  - MCP inputShapes mirror params exactly (zod raw shapes).

**Steps:**
- [ ] **Step 1: Failing tests**: (a) createPrefab writes payload file (read it back, schema-parses, root-first local ids), registers asset with unique-name enforcement (duplicate name → error), marks source root; (b) instantiatePrefab from that asset adds a full subtree to a DIFFERENT scene with fresh ids + marker + position/name overrides; (c) instantiate unknown prefab → NOT_FOUND; corrupt payload on disk → PREFAB_DATA_INVALID; (d) undo/redo across create + instantiate restores exactly (history snapshot round-trip — follow `packages/core/tests/history.test.ts` patterns); (e) CLI: `hearth prefab create`/`place` happy path + `--position` parse; (f) MCP: both tools registered, inputShape keys mirror params.
- [ ] **Step 2:** Run those test files → FAIL.
- [ ] **Step 3:** Implement commands + registry + CLI group + ToolSpecs.
- [ ] **Step 4:** Full `npx vitest run` + `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: createPrefab and instantiatePrefab with CLI and MCP parity`.

### Task 3: updatePrefab + syncPrefabInstances (+ CLI + MCP)

**Files:**
- Modify: `packages/core/src/commands/prefabCommands.ts`, `packages/core/src/commands/registry.ts`
- Modify: `packages/cli/src/program.ts` (`hearth prefab update`, `hearth prefab sync`)
- Modify: `packages/mcp-server/src/tools.ts` (`update_prefab`, `sync_prefab_instances`)
- Test: extend `packages/core/tests/prefabCommands.test.ts` + CLI/MCP test files

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  ```ts
  updatePrefab         params { prefab: string; scene: string; entity: string }
    → data { asset: Asset; entityCount: number }
    // entity must be a marked instance of THAT prefab (else HearthError PREFAB_NOT_INSTANCE);
    // re-serialize its subtree over the payload (same path), keep asset id, refresh metadata.entityCount
  syncPrefabInstances  params { prefab: string; scene?: string }
    → data { scenes: Array<{ scene: string; instances: number }>; total: number }
    // for each marked instance root (all scenes or one): preserve root id (preserveRootId), root name,
    //   root Transform.position, root enabled; delete old descendants; splice rebuilt subtree at the
    //   root's original array position (deterministic scene order); marker kept
  ```

**Steps:**
- [ ] **Step 1: Failing tests**: (a) update from a modified instance rewrites the payload (read back, assert new component values), errors on non-instance entity and mismatched prefab; (b) sync across two scenes with three instances: children rebuilt from payload, per-instance root name/position/enabled preserved, root ids unchanged, counts correct; (c) sync with `scene` param limits scope; (d) instance root order in the scene entity array is stable across sync (assert index); (e) undo of sync restores pre-sync scenes; (f) CLI + MCP parity tests for both verbs/tools.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Full suite + typecheck → PASS.
- [ ] **Step 5:** Commit `feat: updatePrefab and syncPrefabInstances with CLI and MCP parity`.

### Task 4: Prefab validation + inspectAssets summary + removeAsset warning

**Files:**
- Modify: `packages/core/src/validate.ts` (new passes after the ANIMATION_FRAME_NOT_FOUND block ~:194-221)
- Modify: `packages/core/src/commands/assetCommands.ts` (removeAsset warns when a prefab with live instances is removed)
- Modify: the command behind `inspectAssets` (find it in `packages/core/src/commands/` — extend prefab entries with `{ entityCount, rootComponents: string[] }` the way sheet frames surface today)
- Test: `packages/core/tests/validate.test.ts` (extend), prefabCommands test (removeAsset warning), inspect test file (match existing)

**Interfaces:**
- Consumes: Tasks 1–3; `ValidationIssue` (`validate.ts:11-21`).
- Produces validation codes (exact strings): `PREFAB_DATA_INVALID` (error — payload unparseable or `validatePrefabLocalIds` non-empty), `PREFAB_SCRIPT_NOT_FOUND` / `PREFAB_ASSET_NOT_FOUND` (error — payload component references missing script/asset; resolve refs the same way scene-entity validation does), `PREFAB_INSTANCE_ORPHANED` (warning — entity marker → missing or non-prefab asset).

**Steps:**
- [ ] **Step 1: Failing tests**: one test per code (seed a project, break it, assert code+locator), a clean-project no-issues test, removeAsset-with-instances warning (and no warning when no instances), inspectAssets prefab summary shape.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Full suite + typecheck → PASS.
- [ ] **Step 5:** Commit `feat: prefab validation passes and asset summaries`.

### Task 5: Runtime ctx.scene.spawnPrefab (+ Lua parity + export/player)

**Files:**
- Modify: `packages/runtime/src/runtime.ts` (multi-entity spawn beside `spawn` ~:1514)
- Modify: `packages/runtime/src/scripts.ts` (SpawnDef area ~:45-81: `spawnPrefab` on `ctx.scene`)
- Modify: `packages/runtime/src/ctxApi.ts` (CTX_API docs entry — Wave A lesson: missing entries silently drop from AGENTS.md/`hearth inspect api`)
- Modify: runtime construction path so prefab payloads are available headless AND in exports: mirror how AnimationData payloads reach the runtime/player today (follow `getSheetFrames`-style accessors + the Wave A `loadStore` asset-content fix in `packages/runtime/src/player/`); include `assets/prefabs/*.prefab.json` in the export bundler the same way animation JSON ships
- Test: `packages/runtime/tests/spawnPrefab.test.ts` (new), extend the export/player test that verifies asset content reaches exported bundles

**Interfaces:**
- Consumes: `PrefabDataSchema` + `instantiatePrefabData`-equivalent local-id remap (import the shared helper from core — runtime already depends on core schemas), `handleFor`, `registerScript`, `invalidateEntitiesCache`.
- Produces:
  ```ts
  // ctx.scene.spawnPrefab(name: string, opts?: { position?: {x,y}; name?: string }): EntityHandle
  // - resolves prefab asset by name; unknown → recordLog('warn', ...) and returns null (matches spawn's unknown-component tolerance style; document the null)
  // - spawns ALL subtree entities as runtime entities with fresh ids, parentId links preserved among them,
  //   position applied to root; returns root handle; children registered for scripts; NO prefab marker at runtime
  // - deterministic: no seeded-RNG reads; entity insertion order = payload order
  ```
  - Lua: same dot-call surface (`ctx.scene.spawnPrefab("Coin", { position = { x = 10, y = 20 } })`) — verify option-table crossing via the existing NullToNil/proxy conventions; payloads passed in are plain-JS-converted per docs/scripting.md:67.

**Steps:**
- [ ] **Step 1: Failing tests**: (a) JS script calls spawnPrefab → subtree exists with parent links, root handle usable (`getComponent`, `destroy` cascades? — destroy is per-entity today: assert root destroy leaves children per existing engine semantics and DOCUMENT that in the ctxApi entry); (b) position/name opts; (c) unknown prefab warns + null; (d) Lua parity test (same spawn via .lua script); (e) determinism: two identical seeded runs → identical playtest report hash; (f) exported player: extend the existing export asset-content test to assert a prefab payload lands in the bundle and a `spawnPrefab`-using script finds it (both singleFile and multi-file modes — Wave A regression class).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Full suite + typecheck → PASS.
- [ ] **Step 5:** Commit `feat: runtime prefab spawning via ctx.scene.spawnPrefab`.

### Task 6: Editor prefab surfaces

**Files:**
- Modify: `apps/editor/src/components/Hierarchy.tsx` ("Save as prefab" row action beside Duplicate/Delete ~:124-139; instance badge on marked rows)
- Modify: `apps/editor/src/components/AssetsPanel.tsx` (prefab cards: entity-count detail, "Add to scene", "Sync instances" with ConfirmDialog)
- Modify: `apps/editor/src/components/Inspector.tsx` (root-instance banner: "Instance of <name>" + "Update prefab" / "Sync all" buttons)
- Test: pure-logic extraction only if needed; editor has no component test infra (existing convention) — cover any new pure helpers, otherwise verified by review + the copy-sweep test from Task 7 must still pass after this task

**Interfaces:**
- Consumes: `exec('createPrefab'|'instantiatePrefab'|'updatePrefab'|'syncPrefabInstances', ...)` via store `exec()`; `ConfirmDialog` (used by Timeline.tsx:254); asset list already in store via `inspectAssets`.
- Produces: UI only. "Add to scene" instantiates into the CURRENT scene at the viewport center (SceneView exposes center via store — if no seam exists, add `sceneViewCenter: {x,y}` updated on pan/zoom, or fall back to (0,0) with a code comment; do NOT reach into SceneView internals). Sync confirm copy exactly: "Rebuilds N instances from this prefab. Names and positions are kept."
- "Save as prefab" prompts for a name (inline field pattern like Hierarchy rename `Hierarchy.tsx:113-114`), default = entity name.

**Steps:**
- [ ] **Step 1:** Implement Hierarchy action + badge (tooltip shows prefab name; resolve asset name from store).
- [ ] **Step 2:** Implement AssetsPanel cards + dialogs; Inspector banner.
- [ ] **Step 3:** Manual smoke via dev editor (`npm run dev` route used in prior waves): create → place → edit → update → sync round-trip visible; screenshot for the review.
- [ ] **Step 4:** Full suite + typecheck → PASS.
- [ ] **Step 5:** Commit `feat: prefab authoring surfaces in the editor`.

### Task 7: Plain-language chrome + toolbar Undo/Redo + copy-sweep test

**Files:**
- Modify: `apps/editor/src/components/Toolbar.tsx` (Snapshot→Checkpoint :105-107, Diff→Review :108-117, success log :41, new Undo/Redo buttons beside Play/Stop with listHistory-driven enabled state — reuse the DiffPanel wiring `DiffPanel.tsx:24-49,53-65`)
- Modify: `apps/editor/src/components/DiffPanel.tsx` ("Restore checkpoint" + rewritten empty-state/confirm/log copy per spec table)
- Modify: `apps/editor/src/workspace/Workspace.tsx` (panel title `diff: 'Diff'` → `'Changes'` ~:33-45), `apps/editor/src/workspace/ViewMenu.tsx` (checkbox label)
- Modify: `apps/editor/src/components/SceneMenu.tsx` (delete-confirm copy :261), `apps/editor/src/components/agent/Timeline.tsx` ("Snapshot"→"Checkpoint" :208)
- Create: `apps/editor/tests/copySweep.test.ts` (location: match however editor-adjacent pure tests are placed today; if none, `packages/` level test that reads editor source files)
- Test: copy-sweep test + extend any string-asserting tests that break

**Interfaces:**
- Consumes: spec §1a rename table verbatim.
- Produces: copy-sweep test = reads all `apps/editor/src/**/*.tsx` sources, extracts string literals rendered in JSX/title/aria attributes matching `/snapshot|diff|baseline/i`, and fails unless the file:line is in an explicit allowlist (AgentPanel.tsx CLI hints + internal identifiers list). Keep the mechanism simple (regex over source is fine); the allowlist lives in the test file with a comment per entry.

**Steps:**
- [ ] **Step 1:** Write the copy-sweep test → run → FAIL (current jargon strings found).
- [ ] **Step 2:** Apply the rename table + rewrite copy + add toolbar Undo/Redo buttons (tooltips "Undo (⌘Z)" / "Redo (⇧⌘Z)"; platform symbol via `navigator.platform` helper — put it in `apps/editor/src/keybinds.ts`? NO — Task 8 creates that file; inline a tiny `isMac` here and Task 8 absorbs it).
- [ ] **Step 3:** Copy-sweep test → PASS; full suite + typecheck → PASS.
- [ ] **Step 4:** Manual smoke: toolbar renders, Undo/Redo enable/disable correctly, Review focuses the Changes panel.
- [ ] **Step 5:** Commit `feat: plain-language editor chrome with visible undo and redo`.

### Task 8: Keybind registry + new bindings + cheat-sheet overlay

**Files:**
- Create: `apps/editor/src/keybinds.ts` (table + dispatcher + guards + platform display, absorbs Task 7's isMac)
- Create: `apps/editor/src/components/ShortcutSheet.tsx` (overlay rendered from the table)
- Modify: `apps/editor/src/App.tsx` (delete ad-hoc undo/redo listener :37-56; mount the dispatcher + ShortcutSheet)
- Modify: `apps/editor/src/store.ts` (actions the table needs: `duplicateSelection`, `deleteSelection`, `nudgeSelection(dx,dy)` with 300 ms debounce committing ONE `moveEntity`, `focusSelectionRequest` nonce — mirror the `diffFocusRequest` seam, `togglePlay`, `checkpoint`)
- Modify: `apps/editor/src/components/SceneView.tsx` (consume `focusSelectionRequest`: center+fit camera on selected entity bounds, min/max zoom clamp; Escape-deselect only when no mode active — extend the existing Escape handlers :307-356)
- Modify: `apps/editor/src/workspace/ViewMenu.tsx` ("Keyboard shortcuts" item opening the sheet)
- Test: `apps/editor/tests/keybinds.test.ts` (pure: table dispatch, guards, combo matching, platform strings; plus a no-drift test: every table row has label+group, ShortcutSheet renders one row per table entry — render test via the same lightweight approach used anywhere else, or assert the sheet's data source IS the table export)

**Interfaces:**
- Consumes: store `exec()`, selection state, Task 7's toolbar (tooltips gain combos from the table).
- Produces:
  ```ts
  // apps/editor/src/keybinds.ts
  export interface Keybind { id: string; combo: string;            // 'mod+z', 'shift+mod+z', 'mod+d', 'delete', 'mod+s', 'f', 'mod+enter', 'up'/'down'/'left'/'right' (+shift), 'escape', 'shift+/'
    label: string; group: 'General' | 'Scene' | 'Selection';
    when?: 'selection' | 'always'; run(store: EditorStore): void; }
  export const KEYBINDS: Keybind[];                                 // includes DISPLAY-ONLY rows for Space-pan and mode-Escape (run: no-op, documented)
  export function installKeybinds(getStore: () => EditorStore): () => void; // one window listener; typing-guard (INPUT/TEXTAREA/contentEditable/open dialog/key-capture-armed); preventDefault on match (Cmd+S!)
  export function comboDisplay(combo: string): string;              // '⌘Z' on mac, 'Ctrl+Z' elsewhere
  ```
  - Bindings per spec §1b table exactly; Delete/Backspace both map to delete; arrows nudge 1px, shift+arrows 10px, debounced to one undo step per burst; `?` toggles the sheet; Escape priority: dialogs/popovers/modes first (they already stopPropagation or are checked via guards), then deselect.

**Steps:**
- [ ] **Step 1: Failing tests** for the table/dispatcher/guards/no-drift.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement module + overlay + store actions + SceneView focus/deselect + App.tsx migration + ViewMenu item + toolbar tooltip combos.
- [ ] **Step 4:** Tests + full suite + typecheck → PASS. Manual smoke: every new combo works in the dev editor; typing in Inspector fields does NOT trigger; key-capture in InputSettings still swallows.
- [ ] **Step 5:** Commit `feat: central keybind registry with shortcut cheat sheet`.

### Task 9: Transform-handle geometry module (pure)

**Files:**
- Create: `apps/editor/src/transformHandles.ts`
- Test: `apps/editor/tests/transformHandles.test.ts` (co-located with however `polygonEditing.ts` is tested — match it)

**Interfaces:**
- Consumes: nothing editor-specific — pure math (mirror `polygonEditing.ts` style).
- Produces:
  ```ts
  export type HandleId = 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'rotate';
  export interface HandleTarget {                       // what this gesture edits (resolved by Task 10)
    kind: 'sprite-size' | 'collider-box' | 'collider-circle' | 'ui-size' | 'transform-scale';
    width: number; height: number;                      // current extent in world px (circle: radius*2 both)
  }
  export interface SelectionBox { center: {x,y}; width: number; height: number; rotation: number; } // world space
  export function handlePositions(box: SelectionBox, zoom: number): Array<{ id: HandleId; x: number; y: number }>;
  // 8 box handles on the ROTATED box + rotate handle offset above center along the box's local -Y; screen-constant sizes via zoom
  export function hitHandle(box: SelectionBox, zoom: number, point: {x,y}): HandleId | null; // generous radius, screen-constant
  export interface DragResult { width: number; height: number; rotation: number; centerShift: {x,y}; }
  export function applyHandleDrag(box: SelectionBox, id: HandleId, start: {x,y}, current: {x,y}, mods: { shift: boolean }): DragResult;
  // - size handles: delta in box-LOCAL space (unrotate), corners edit both axes (shift ⇒ aspect lock),
  //   edges one axis; opposite edge stays anchored ⇒ centerShift; min extent 2px clamp
  // - rotate: angle from center, shift ⇒ snap 15°; sizes unchanged
  export function cursorFor(id: HandleId, rotation: number): string; // resize cursors rotated to nearest 45°, 'grab' for rotate
  ```

**Steps:**
- [ ] **Step 1: Failing tests**: handle positions for unrotated + 90°-rotated boxes at zoom 1 and 2 (screen-constant offsets); hitHandle inside/outside; corner drag grows both axes with anchored opposite corner (assert centerShift); shift aspect-lock; edge drag single axis; min clamp; rotation angle math + 15° snap; cursor mapping.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Tests + full suite + typecheck → PASS.
- [ ] **Step 5:** Commit `feat: pure geometry for scene-view transform handles`.

### Task 10: SceneView handle integration

**Files:**
- Modify: `apps/editor/src/components/SceneView.tsx` (render handles on selection :1005-1028 area; pointer routing before entity drag :509-534; live ghost + single-command commit like `commitPoints` :423-439)
- Test: extend `transformHandles.test.ts` only if new pure logic is extracted (target resolution below SHOULD be extracted pure: `resolveHandleTarget(entity): HandleTarget & { property: string; component: string }`)

**Interfaces:**
- Consumes: Task 9 module; `setComponentProperty` via `exec(..., { quiet: true })`; existing dragRef/ghost patterns.
- Produces behavior (spec §1c, exact rules):
  - Target priority: `SpriteRenderer.width/height` → box `Collider.size` → circle `Collider.radius` (any handle drags radius uniformly) → `UIElement.size` → `Transform.scale` (fallback; scale = newExtent/baseExtent where baseExtent = current rendered bounds at scale 1).
  - One `setComponentProperty` per gesture on pointer-up (rotation → `Transform.rotation` via same command; centerShift → additionally ONE `moveEntity` when nonzero — acceptable two commands for anchored resize, they're one gesture: use `moveEntity` FIRST then size property, and note in the commit message that undo restores in two steps ONLY if that's unavoidable — if the history model makes this two undo steps, instead commit size without centerShift compensation, i.e. resize from center, keeping strictly one command; decide by testing undo behavior and DOCUMENT the choice in code comments).
  - Handles hidden while: playing, point-edit mode active, paint mode active, or no selection. Values round like drag-move; cursors from `cursorFor`.

**Steps:**
- [ ] **Step 1:** Extract + test `resolveHandleTarget` (pure) — failing first.
- [ ] **Step 2:** Wire rendering + pointer routing + ghost + commit; verify against a rotated sprite entity, a circle collider, and a UIElement in the dev editor (screenshots for review).
- [ ] **Step 3:** Full suite + typecheck → PASS; keybinds from Task 8 still work (no pointer/keyboard conflicts).
- [ ] **Step 4:** Commit `feat: drag handles for resize and rotate in the scene view`.

### Task 11: Ember Warrens example (10th)

**Files:**
- Modify: `packages/examples/generate.mjs` (new `generateEmberWarrens()`: enemies + pickup prefabs authored via createPrefab/instantiatePrefab/updatePrefab/syncPrefabInstances; a spawner script using `ctx.scene.spawnPrefab` for timed waves; menu/HUD reusing existing UI widgets; probe-derived playtests)
- Modify: whatever example-registry/test files list examples (match how Ember Horde was added — find its commit pattern via `git log --oneline -20 -- packages/examples`)
- Test: examples test suite (existing pattern: regenerate + determinism + playtests green)

**Interfaces:**
- Consumes: all four prefab commands + spawnPrefab; existing playtest steps + assertEntityCount-style assertions for spawn waves.
- Produces: `packages/examples/ember-warrens/` generated project; playtests prove wave spawning deterministically (probe first — run the sim, bake observed counts; NEVER hand-compute).

**Steps:**
- [ ] **Step 1:** Write the generator using the `run(session, ...)` helper; author prefabs through the command path (the generator IS the end-to-end proof).
- [ ] **Step 2:** Probe run → bake playtest expectations → regenerate ALL examples (`node packages/examples/generate.mjs`).
- [ ] **Step 3:** Examples tests + full suite + typecheck → PASS; `hearth screenshot` the example for the review.
- [ ] **Step 4:** Commit `feat: ember warrens example with prefab-driven spawn waves`.

### Task 12: Docs, truth pass, v0.9.0

**Files:**
- Create: `docs/prefabs.md` (data model, tracked-stamp semantics incl. sync-preserves list, all four commands with CLI/MCP names, spawnPrefab, editor flows)
- Modify: `docs/scripting.md` (spawnPrefab + destroy semantics note), `docs/components.md` (prefab marker), `docs/cli.md`, `packages/mcp-server/README.md`, `docs/architecture.md` (prefab data flow), the editor docs page that documents chrome/shortcuts (create a Shortcuts section from the keybind table — keep it in sync by stating the table is the source of truth), `README.md`, `docs/roadmap.md`, `packages/core/src/agentFiles.ts` (AGENTS.md generation mentions prefabs + spawnPrefab)
- Modify: all package.json + version constants → 0.9.0 (mirror the 0.8.0 bump commit pattern)
- Test: full suite + typecheck; regenerate examples at 0.9.0

**Steps:**
- [ ] **Step 1:** Write docs; verify EVERY count claim live (`hearth --help` verb list, registry size, MCP tool list, component count, example count) — expected 60 commands / 59 MCP tools but TRUST THE CODE not this plan.
- [ ] **Step 2:** Version bump + regenerate examples.
- [ ] **Step 3:** Full `npx vitest run` + `npm run typecheck` → PASS.
- [ ] **Step 4:** Commit `chore: release 0.9.0 with prefab and editor docs`.

---

## Wave close (controller, after Task 12)
Final whole-branch review (fable, live probes incl. dev-editor browser pass over keybinds/handles/chrome + an exported spawnPrefab game), fix round, then: tag v0.9.0 push → verify release workflow assets → website sync + deploy (feature copy only; NO example showcase per standing rule) → update SecondBrain index + run note.
