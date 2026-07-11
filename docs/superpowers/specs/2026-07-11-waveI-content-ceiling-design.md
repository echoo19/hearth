# Wave I — Content Ceiling (v0.12) Design

**Date:** 2026-07-11
**Status:** Approved
**Prior wave:** v0.11.0 "iteration loop" (hot-reload, live patching, format-on-save, tabs, find/replace)

## Goal

Raise the ceiling on what games Hearth can express: animation state machines,
tilemap autotiling, live particle preview in the editor, live-linked prefabs
with per-field overrides, atomic bulk asset import, and a real prefab showcase
example. Every capability lands for users (editor UI) and agents (CLI + MCP)
in the same task, and integrates with the Wave H live-patch loop.

## Locked decisions

1. **Animation state machines**: authored as a project asset with a
   structured list-based editor (params panel, states list, transitions
   table). No node-graph canvas this wave.
2. **Autotiling**: 47-tile blob, 8-neighbor bitmask. The char grid stays
   authoritative; autotile is a pure resolve step.
3. **Prefab live-linking**: implicit per-field overrides (editing an instance
   field silently records an override) with auto-sync (updating a prefab
   syncs all instances, merging around overrides).
4. **Particle preview**: live in the Scene view, in-place, for selected
   entities' emitters. No dedicated panel.

## Pillar 1 — Animation state machines

### Asset

New asset type `stateMachine`, stored at
`assets/statemachines/<slug>.asm.json`, registered in the asset index like
animations. Strict Zod `StateMachineDataSchema` in
`packages/core/src/schema/project.ts`:

```ts
{
  params: Record<string, {
    type: 'bool' | 'number' | 'trigger',
    default?: boolean | number   // ignored for trigger
  }>,                            // default {}
  states: Array<{
    name: string,                // unique, non-empty
    animation: string,           // animation asset id
    speed: number                // default 1, > 0 playback multiplier
  }>,                            // min 1
  initial: string,               // must name a state
  transitions: Array<{
    from: string,                // state name or 'any'
    to: string,                  // state name (never 'any')
    conditions: Array<{
      param: string,             // must exist in params
      op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte',
      value: boolean | number    // bool params: eq/neq only; trigger: no op/value, presence = fired
    }>,                          // default []; legality rules in cross-field validation below
    exitTime?: number            // 0..1 fraction of clip; transition eligible only after this point
  }>
}
```

Cross-field validation (superRefine): `initial` names a state; transition
`from`/`to` name states (or `from: 'any'`); condition `param`s exist with
op/value legal for the param type; trigger conditions are written as
`{param}` (no op/value); a transition must have at least one condition OR an
`exitTime` (a from-`any` transition must have at least one condition);
duplicate state names rejected. Animation asset ids are validated against the
asset index at command time (like prefab script validation), not in the
schema, with error code `ASM_ANIMATION_NOT_FOUND`.

### Component

New `AnimationStateMachine` component in `COMPONENT_SCHEMAS`:

```ts
{
  assetId: string (default ''),   // stateMachine asset id
  playing: boolean (default true)
}
```

Requires sibling SpriteRenderer (same posture as SpriteAnimator — documented,
not enforced). An entity should use SpriteAnimator OR AnimationStateMachine,
not both; if both exist the state machine wins and a runtime warning is
logged once. `COMPONENT_DOCS` entry included. A bare `{}` parses (all
defaults).

### Runtime

`packages/runtime/src/stateMachine.ts` — pure, deterministic, fixed-step
(mirrors `animator.ts` / `particles.ts`):

- `SmState` per entity: current state name, elapsed-in-state, param values
  (initialized from asset defaults), fired-trigger set.
- `stepStateMachine(smState, component, asset, animAssets, fixedDt)`:
  1. Evaluate transitions in declaration order — explicit `from: current`
     first, then `from: 'any'`; first eligible wins. Eligibility: all
     conditions true AND (`exitTime` absent or clip progress ≥ exitTime).
     Self-transitions allowed only from `'any'` restart the clip.
  2. On transition: switch state, reset clip to frame 0, consume ALL trigger
     params that appeared in the taken transition's conditions.
  3. Advance the current state's clip (reusing the frame-advance math of
     `stepAnimator`, scaled by `speed`) and write `{assetId, frame}` into
     the sibling SpriteRenderer.
- Triggers not consumed by a transition this step persist (standard latch
  semantics) until consumed or cleared by script.
- State survives Wave H hot-reload like animator/particle state does (owned
  by the runtime entity state, not the script).

### Script API

On `ctx.animator` (new namespace; live-resolving across hot-reload like the
rest of ctx):

- `ctx.animator.setParam(entityRef, name, value)` — bool/number
- `ctx.animator.getParam(entityRef, name)`
- `ctx.animator.fire(entityRef, name)` — trigger
- `ctx.animator.state(entityRef)` — current state name (or nil/null)

`entityRef` follows the existing id-or-unique-name convention. Errors on
unknown param/wrong type are script errors with line info (Wave H error→line
applies). Both Lua and JS bindings, documented in hover docs
(`apps/editor/src/components/code/hoverDocs.ts`) and `docs/scripting.md`.

### Commands (core → CLI → MCP, same task)

- `createStateMachineAsset { name, data }` → validates, writes
  `.asm.json`, registers asset. Permission `asset-edit`.
- `updateStateMachineAsset { assetId, data }` → whole-document replace,
  validated. Permission `asset-edit`.
- Reading uses existing `inspectAsset`/asset read paths (extend to return
  parsed ASM data).
- Whole-document write is deliberate: the doc is small, strictly validated,
  and read-modify-write is the natural agent flow. No per-state/per-transition
  micro-commands (YAGNI).
- Journal detail: `{ assetId }` for update, `{ name }` for create. Live-patch
  classification: `updateStateMachineAsset` → **reload-like**: the running
  preview swaps the parsed asset in place and resets affected entities' SmState
  to `initial` (params re-defaulted); `createStateMachineAsset` → none.
- CLI: `hearth create asset statemachine <name> --data <json|@file>` and
  `hearth set statemachine <assetRef> --data <json|@file>` (exact ergonomics
  may follow existing CLI group conventions in `program.ts`; parity is the
  requirement, naming follows house style).

### Editor UI

"Animator" editor for `.asm.json` assets — opened from the Assets panel card
("Edit state machine") and from an "Edit" button on the
`AnimationStateMachine` Inspector row. Rendered as a modal-style overlay
panel (like existing heavyweight editors if any; otherwise a dedicated
dockview panel `animator` following the `layout.ts` + `Workspace.tsx`
registration pattern — implementer picks whichever matches existing patterns;
dockview panel preferred for dockability). Contents, all typed controls (no
raw JSON, per editor-UI uniformity rule):

- **Params** table: name, type select (bool/number/trigger), default.
- **States** list: name, animation asset dropdown (type === 'animation'),
  speed number field; radio/star marking `initial`.
- **Transitions** table: from (select incl. Any), to (select), exitTime
  (optional number 0..1), and condition rows (param select, op select scoped
  to param type, value input) with add/remove.
- Save writes through `updateStateMachineAsset` (single undo entry); invalid
  states surface the command's validation errors inline.
- Inspector: `AnimationStateMachine.assetId` renders as a dropdown of
  stateMachine assets (mirroring the SpriteAnimator special case).

### Showcase

`sky-courier` courier switches idle/walk via a state machine with a `moving`
bool param set from its movement script (replacing the current manual
frame-loop switching if present, else additive).

## Pillar 2 — Tilemap autotiling (47-blob)

### Data model

`Tilemap.tileAssets` values become a union (in `TilemapSchema`):

- `string` — plain sprite asset id (unchanged, fully backward compatible)
- `{ sheet: string, template: 'blob47', mapping?: Record<string, string> }`
  — autotile rule: `sheet` is a spritesheet asset id; `template: 'blob47'`
  maps the canonical 47 blob shapes to frame names using the standard blob
  template layout (row-major naming convention documented in
  `docs/editor.md`); `mapping` is an optional explicit override of
  shape-key → frameName for non-standard sheets. Shape keys are the 47
  canonical mask names (e.g. `iso`, `n`, `ne_corner`, … exact key list
  defined once in core and exported).

The char grid is untouched: painting, fill, resize, colliders, and the
grid-identity collider cache all work exactly as today.

### Resolver

`packages/core/src/tilemap/autotile.ts` (pure, shared by runtime and
editor):

- `computeMask(grid, row, col, char)` → 8-neighbor bitmask where a neighbor
  counts as "same" iff it holds the same char. Out-of-bounds counts as same
  (maps don't grow borders at the map edge).
- `maskToShape(mask)` → one of the 47 canonical shapes (corner bits are
  masked out when their adjacent edges are absent — the standard blob
  reduction from 256 → 47).
- `resolveTileFrame(rule, mask)` → `{ sheet, frame }`.
- Golden table test covering all 47 shapes + corner-reduction cases.

Runtime tilemap rendering and editor `SceneView.renderTilemap` +
`renderPaintPreview` call the resolver when a char's rule is an autotile
object; neighbors repaint automatically because painting already rebuilds
the grid array (identity change → re-render). Paint preview shows resolved
frames for the hovered stroke where cheap, else falls back to the plain
tile-at-cursor preview (must not regress paint responsiveness).

### Command + UI + parity

- New command `setTileAutotile { entity, char, sheet, template?, mapping? }`
  (and `{ entity, char, clear: true }` to revert to plain). Validates sheet
  asset exists and is a spritesheet, frame names resolve. Permission
  `safe-edit` (matches paints). Setting a plain sprite id keeps using the
  existing `tileAssets` Inspector row / `setComponentProperty` path — the
  union's object arm is written ONLY via `setTileAutotile` to avoid the
  path-walker union limitation.
- Journal detail `{ scene, entity, char }`; live-patch: **patch** (re-read
  tilemap component and refresh, same lane as paints).
- Inspector `tileAssets` editor: each char row gains a mode toggle
  (sprite / autotile); autotile mode shows sheet dropdown + template
  (blob47) + optional advanced mapping editor (frame dropdowns per shape,
  collapsed by default).
- CLI `hearth set tilemap-autotile …` (house naming), MCP `set_tile_autotile`.
- Docs: blob template layout reference with a diagram/ASCII in
  `docs/editor.md`, agent recipe in `docs/agents.md`.

### Showcase

`glow-caves` (or `drift-cellar`) converts one terrain char to an autotile
rule with a generated blob sheet from `pixelart.mjs` (template layout),
regenerated in `generate.mjs`.

## Pillar 3 — Live-linked prefabs with per-field overrides

### Data model

Entity-level `prefab` marker (scene schema) grows, root-only as today:

```ts
prefab: {
  asset: string,
  ids: Record<string, string>,        // prefab local id (pfe_n) → scene entity id; written at instantiate
  overrides: Array<{
    entity: string,                    // prefab local id
    component: string,
    path: string,                      // dot-path as used by setComponentProperty
    value: unknown                     // JSON value
  }>                                   // default []
}
```

Both new fields default (`ids` `{}` / `overrides` `[]`) so existing scenes
parse unchanged; existing instances without `ids` are **legacy-detached**:
they behave as today (full-rebuild sync repopulates `ids`, after which they
are live-linked). Migration is therefore lazy and free.

### Override recording (implicit)

In `setComponentProperty` / `setProperties` / `moveEntity`(position): after a
successful write, if the target entity is inside a prefab instance subtree
(found via root markers' `ids` maps in the same scene), record/replace the
override `{entity: localId, component, path, value}` on the root marker.
Root `name`, root `Transform.position`, and `enabled` are per-instance by
definition (as in today's sync) and are NOT recorded as overrides.
Same-value writes still record (simple, predictable; revert exists).
`inspectEntity` output gains `prefab: { asset, root, localId, overridden: [{component, path}] }`
for entities inside instances — agents see exactly what the Inspector shows.

### Sync = merge

`syncPrefabInstances` (and the auto-sync below) becomes a merge:

1. Rebuild the subtree from prefab data (as today) BUT reuse existing scene
   entity ids via the `ids` map (new prefab entities get fresh ids; removed
   ones are deleted; `ids` updated).
2. Preserve instance root id/name/`Transform.position`/`enabled` (as today).
3. Re-apply every recorded override on top (dropping, with a warning
   `PREFAB_OVERRIDE_STALE`, overrides whose local id / component / path no
   longer exists in the prefab).

Reusing ids means hierarchy selection, scripts holding ids, and the Wave H
live-patch targets survive sync. `updatePrefab` now auto-syncs all instances
project-wide in the same command (single undo entry); its result reports
`{instancesSynced, overridesPreserved, overridesDropped}`.

### Structural edits detach

Adding/removing an entity or component inside an instance subtree (below the
root) detaches the instance: marker removed, warning `PREFAB_INSTANCE_DETACHED`
in the command result, Inspector banner explains. Field-level linking only,
this wave. (Root-level component add/remove also detaches — keep the rule
simple.)

### Revert + commands

- `revertPrefabOverride { entity, component?, path? }` — entity is any
  member of the instance; omitting path reverts the whole component,
  omitting both reverts all overrides on that entity's localId. Restores the
  prefab's value(s) immediately (write-through) and removes override
  records. Permission `safe-edit`.
- Journal detail `{ scene, entity, component?, path? }`; live-patch: patch.
- `setComponentProperty`/`setProperties` journal detail unchanged (already
  live-patches).
- CLI: `hearth prefab revert <entity> [component] [path]`; MCP
  `revert_prefab_override`. `hearth prefab update` inherits auto-sync.

### Editor UI

- Inspector: fields inside a live-linked instance that are overridden get an
  ember-colored dot before the label + a context "Revert to prefab" action
  (per-field); the instance banner gains override count ("3 overrides") and
  "Revert all".
- Hierarchy: instance roots keep their existing affordance; detached-by-edit
  shows a one-time toast.
- Sync-preflight copy in `prefabActions.ts` updated for merge semantics
  (no longer warns about wholesale replacement).

## Pillar 4 — Particle preview in Scene view (editor-only)

- `apps/editor/src/particlePreview.ts`: manages `EmitterState` instances
  (imported from `@hearth/runtime`'s pure `particles.ts`) for the currently
  selected entities that have a `ParticleEmitter`, stepping them with fixed
  dt on a rAF ticker gated by Scene-panel visibility (pattern:
  `GamePanelHost`'s visibility wiring, adapted for the SVG/Scene renderer).
- SceneView draws live particles (position/size/color interpolation) at the
  emitter's world position, replacing the static glyph for selected
  emitters; unselected emitters keep the existing cone gizmo.
- Any Inspector/live-patch change to the emitter's component (or its
  Transform) resets that emitter's state (deterministic seed → same preview
  every time).
- Scene toolbar toggle "Particles" (default ON, persisted in editor
  settings/localStorage) disables the sim entirely.
- Perf guard: preview caps at the component's `maxParticles` (≤2048) and
  only simulates selected emitters; ticker stops when none are selected.
- No core/runtime changes beyond exporting what's needed from
  `particles.ts` (already pure).

## Pillar 5 — Bulk asset import

- New command `importAssets { sourcePaths: string[], type?: string }`:
  - Validates every path up front (exists, extension known or `type`
    given, size). Per-file skip with reasons — not all-or-nothing —
    because that is friendlier for bulk drops: result is
    `{ imported: [{path, assetId, name, type}], skipped: [{path, code, message}] }`,
    but the WRITE side (files copied + index update + journal) is one atomic
    undo/journal entry covering everything imported.
  - Collision-safe naming: auto-suffix `-2`, `-3`… on name collisions
    (reported in result), matching single-import behavior if it exists, else
    establishing it.
  - Reuses `importAsset`'s copy/probe/register internals (refactor into a
    shared helper; `importAsset` stays).
  - Permission `asset-edit`. Journal detail `{ count, types }`; live-patch:
    none/structural (assets list refresh only — the Assets panel already
    refreshes via journal feed).
- Editor Assets panel: `importFiles()` collects the FileList (and folder
  drops via `webkitGetAsEntry` recursive traversal) into ONE `importAssets`
  call; summary toast "Imported 14, skipped 2 (unsupported type)". 25MB
  per-file cap stays client-side.
- CLI: `hearth create asset <paths...>` accepts multiple paths (or
  `hearth asset import <paths...> --recursive` for directories — follow
  house style); MCP `import_assets`.

## Pillar 6 — Prefab showcase example (ember-horde conversion)

In `generate.mjs`: replace ember-horde's disabled "Enemy Template" entity +
hand-mirrored spawn table in `horde-director.lua` with a real prefab:

- `createPrefab` from the enemy subtree → `assets/prefabs/enemy.prefab.json`.
- Director script spawns via `ctx.scene.spawnPrefab('enemy', …)`.
- Scene contains at least one placed instance with a per-field override
  (e.g. a tinted elite variant) to exercise live-linking end to end.
- Playtest assertions keep passing; examples regenerated + committed (CI
  clean-tree gate); `docs/prefabs.md` example section points at it.

## Cross-cutting requirements

1. **Parity in-task**: every new command lands in
   `packages/core/src/commands/registry.ts` + `packages/mcp-server/src/tools.ts`
   + `packages/cli/src/program.ts` in the same task. Expected counts after
   the wave: 65 + 5 new = **70 commands** (`createStateMachineAsset`,
   `updateStateMachineAsset`, `setTileAutotile`, `revertPrefabOverride`,
   `importAssets`); MCP 62 + 5 = **67 tools**.
2. **Live-patch wiring**: `session.ts extractJournalDetail` +
   `apps/editor/src/livePatch.ts` updated per-pillar as specified above, so
   external agent edits behave identically to editor edits during play.
3. **Docs**: `docs/scripting.md` (ctx.animator), `docs/editor.md` (animator
   editor, autotile, particle preview, bulk import, override UI),
   `docs/prefabs.md` (rewrite live-link section, remove the non-goals lines
   this wave delivers), `docs/cli.md`, `docs/mcp.md`, `docs/agents.md`
   (recipes: build an ASM, autotile a map, override an instance, bulk
   import), `docs/roadmap.md` (mark v0.12 shipped), READMEs + counts.
4. **On-theme ledger minors** (from Wave H tail), fixed in this wave:
   fatal baseline-project parse asymmetry (loadBaseline project parse must
   safeParse+fallback like scenes — it's a crash bug); CLI create script
   `--no-format` flag; CLI set-settings loose bool parse. The rest of the
   tail stays for Wave K.
5. **Polish task at wave end**: live browser verification of all six pillars
   (editor UX pass — palette: neutral charcoal + ember accents; no raw JSON
   anywhere; keyboard/discoverability check), plus packaging checks:
   standalone CLI run in a node_modules-free dir and Electron main-bundle
   check (the C-1 class).
6. **Release**: version bump to 0.12.0 with examples regenerated IN THE SAME
   COMMIT (embedded hearthVersion — the I-1 lesson), tag, CI release run,
   11-asset verification, website sync + deploy + live verification
   (counts 70/67, new bento/feature copy for content tools; no example
   showcase on the website per standing rule).

## Testing matrix

| Area | Tests |
|---|---|
| ASM schema | round-trip, cross-field validation rejects (bad initial, unknown param, trigger with op, dup states, empty transition) |
| ASM runtime | golden transition sequences (bool/number/trigger/exitTime/any-state, declaration-order priority, trigger consumption), determinism across two runs, hot-reload state survival |
| ASM commands | create/update happy + `ASM_ANIMATION_NOT_FOUND`, journal detail, undo |
| Autotile | 47-shape golden table, corner reduction, out-of-bounds-as-same, resolver purity; setTileAutotile validation; paint → resolved-frame integration |
| Prefabs | ids map on instantiate; override record on set/setProps/move; merge sync preserves ids + overrides, drops stale with warning; auto-sync on update; revert (field/component/entity); structural detach; legacy (no-ids) instance upgrade path; undo through all of it |
| Particle preview | ticker gating (visibility, selection, toggle), reset-on-edit, determinism (editor unit tests) |
| Bulk import | multi-file atomic journal entry, per-file skip reasons, name collisions, undo removes all |
| Examples | regen byte-identical, ember-horde playtest assertions pass |
| Packaging | standalone CLI smoke (no node_modules), Electron main bundle contains new core paths |
| Parity | CLI + MCP invocation test per new command (house pattern) |

## Non-goals (this wave)

- Node-graph canvas for the animator editor (list UI ships; graph later).
- Animation blending/crossfade (hard cuts only).
- Autotile modes other than blob47; per-tile rotation/flip.
- Prefab structural linking (add/remove inside instance = detach), nested
  prefab-in-prefab links, prefab variants.
- Folder watching / auto-reimport for assets.
- Editor asset-pipeline UI beyond the import flow.
