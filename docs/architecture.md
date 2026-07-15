# Hearth Architecture

Hearth is a monorepo of small, focused packages sharing one core. The design
goal: **every operation a human can do in the editor is a structured command
an agent can call**, through the same code path, with the same validation and
results.

```
                ┌─────────────────────────────────────────────┐
                │                @hearth/core                 │
                │  schemas · project store · command system   │
                │  validation · diff engine · permissions     │
                │  procedural assets · agent-file generation  │
                └──────┬──────────┬───────────┬───────────────┘
                       │          │           │
        ┌──────────────┴──┐  ┌────┴─────┐  ┌──┴─────────────┐
        │ @hearth/runtime │  │ @hearth/ │  │  apps/editor   │
        │ headless core + │  │   cli    │  │ React UI +     │
        │ pixi renderer   │  │ (hearth) │  │ project server │
        └──────┬──────────┘  └────┬─────┘  └──┬─────────────┘
               │                  │           │
        ┌──────┴──────────┐  ┌────┴─────────┐ │
        │ @hearth/playtest│  │ @hearth/     │ │
        │ headless tests  │  │ mcp-server   │ │
        └─────────────────┘  └──────────────┘ │
                     (all consume core; none bypass it)
```

## Packages

| Package | Role |
| --- | --- |
| `packages/core` | Zod schemas for every file format; `ProjectStore` (load/save); the **command registry** (71 operations, including web + desktop export, pathfinding, spritesheet slicing, undo/redo/history, the command journal, tilemap editing/autotiling, prefab authoring, animation state machines, and the `ctx` API reference); validation; structural diff; permission model; procedural asset generation (SVG sprites/tiles, WAV sounds); AGENTS.md/CLAUDE.md generation; the deterministic grid A\* pathfinding module shared by the runtime and the CLI/MCP; prefab serialization/instantiation, live-link merge/detach (see [Prefabs](#prefabs) below). `exportDesktop` reuses `exportWeb`'s in-memory build assembly and delegates native packaging to a host-supplied `ctx.resources.packageDesktop` resource, so core itself never touches Electron or Node-only packaging APIs. Browser-safe: Node fs access is isolated in `@hearth/core/node`. |
| `packages/runtime` | 2D runtime: scene instantiation, fixed-timestep loop, input actions, box/circle/convex-polygon physics (SAT, with mass/restitution/friction and named collision layers), a synchronous deterministic event bus, screen-space UI with pointer hit-testing, audio (recorded headlessly, Web Audio in the browser), camera, and the script engine: **Lua 5.4 (sandboxed wasmoon VM) by default, JavaScript equally supported, one identical `ctx` API** with scene switching, timers, tweens, seeded RNG, and persistent save data. `SceneRuntime` runs a single scene; `GameSession` wraps it for cross-scene games (`ctx.scenes.load` swaps runtimes while the RNG stream, save storage, frame counter, and logs carry across). The main entry is **headless** (runs in Node for playtests); the PixiJS renderer is the separate `@hearth/runtime/pixi` subpath used by the editor's game preview, and the web-export player bundle is built from the same code. |
| `packages/playtest` | Headless playtest execution: scripted input + assertions over a `GameSession` (seeded, scene-switch aware), exposed as `RuntimeHooks` injected into core commands (`runPlaytest`, `runScene`). |
| `packages/cli` | `hearth`, the command-line surface. Every subcommand dispatches into the core command system; `--json` emits the raw `CommandResult` envelope for agents. |
| `packages/mcp-server` | `hearth-mcp`, a stdio MCP server exposing the same commands as typed MCP tools, with permission modes. |
| `packages/shipping` | `@hearth/shipping`: Node-only native packaging, consumed by the CLI, MCP server, and editor server (never by `@hearth/core` or any browser bundle). Generates a hardened, minimal Electron `main.js` per export (`contextIsolation`, no preload, navigation locked to the loaded file), drives `@electron/packager` per platform (`darwin-arm64`/`darwin-x64`/`win32-x64`/`linux-x64`), converts a project's sprite-asset icon to `.icns`/`.ico` with `png2icons` (falling back to a bundled default), runs the macOS ad-hoc/identity/notarize signing ladder, and zips the result (`<slug>-<platform>.zip`; also the single zip implementation `exportWeb --zip` reuses for `<slug>-web.zip`). |
| `packages/templates` | `@hearth/templates`: the three genre starter projects (`platformer`, `topdown`, `arcade`) `hearth init --template` and the editor Launcher scaffold from, checked in under `templates/` and produced by `generate.mjs` the same way `packages/examples` generates its examples (deterministic; regenerating twice yields a clean working tree). `listTemplates()`/`getTemplatePath()`/`applyTemplate()` are the small Node-only runtime entry the CLI and editor server consume; templates embed `hearthVersion` and are regenerated in the same commit as every version bump, alongside the examples. |
| `packages/examples` | Ten sample projects **generated through the command system itself** (`generate.mjs`); they double as integration tests and agent references. Three are JavaScript-scripted; `ember-trail`, `glow-caves`, `bounce-patrol`, `sky-courier`, `drift-cellar`, `ember-horde`, and `ember-arcade` are all-Lua: `ember-trail` exercises the scene/stdlib surface end to end, `glow-caves` exercises rendering v2 (lighting, particles, sprite animation) plus blob47-autotiled cave terrain, `bounce-patrol` exercises physics v2 (mass/restitution/friction, layered and one-way colliders), `ctx.events`/`onEvent`, and `ctx.scene.findPath`, `sky-courier` exercises asset pipeline v2, the first example built from **imported binary assets** (a sliced PNG spritesheet, a streamed WAV music loop, an imported font) rather than procedural SVGs, plus an animation state machine driving its idle/walk cycle, `drift-cellar` exercises game feel v1: analog virtual axes with gamepad bindings (`ctx.input.axis`), camera effects (`ctx.camera.shake/flash/fade/zoomPunch`), the UI widget set (`UILayout`/`UISlider`/`UIToggle`), and `ctx.ui` focus navigation, `ember-horde` demonstrates the scale ceiling plus a live-linked `Enemy` prefab with an overridden "Elite Enemy" instance, and `ember-arcade` exercises the post-processing/`SpriteEffects` surface. |
| `apps/editor` | Vite + React editor. A Vite-plugin project server (Node) opens `HearthSession`s and exposes `/api/command` etc.; the browser UI renders panels and dispatches commands. An Electron shell packages the desktop app, running the same project server in-process; an experimental Tauri shell config is also included. |

## The command system (the load-bearing wall)

`packages/core/src/commands/` defines every operation as:

```ts
defineCommand({
  name: 'createEntity',
  description: '…',            // shown in CLI help & MCP tool listings
  permission: 'safe-edit',     // minimum permission mode
  mutates: true,               // auto-saves the project after success
  paramsSchema: z.object({…}), // validated before run
  run(ctx, params) {…},
})
```

`HearthSession.execute(name, params)` is the single entry point: it validates
params, checks permissions, runs the command, auto-saves on mutation, and
returns a uniform envelope:

```jsonc
{
  "success": true,
  "command": "createEntity",
  "data": { "entityId": "ent_x4k2p9aa", … },
  "errors": [],                 // [{code, message}]
  "warnings": [],
  "changed": [{ "kind": "entity", "id": "…", "scene": "…", "action": "created" }],
  "files": ["scenes/level_1.scene.json", …],   // files written
  "suggestions": ["inspectEntity …"]           // hints for agents
}
```

CLI subcommands, MCP tools, and editor UI actions are all thin adapters over
this. Adding a new engine operation = adding one command definition; every
surface picks it up.

## Data flow

1. **Load**: `ProjectStore.load(fs, root)` parses `hearth.json`, scenes,
   assets index, playtests through Zod schemas (fail fast, precise errors).
2. **Mutate**: commands operate on the in-memory store; successful mutating
   commands persist the whole model via `store.save()` (files are small JSON;
   simplicity beats partial writes at this scale).
3. **Diff**: `snapshotProject` writes `.hearth/baseline.json`;
   `diffProject` structurally compares baseline vs current (scenes →
   entities → components → property paths, plus scripts/assets/playtests).
   `revertProject` restores the baseline. This powers the human review loop.
4. **Run**: the runtime deep-copies entities into live instances; it never
   mutates authored data. Playtests drive the runtime with scripted inputs
   at a fixed timestep, so results are deterministic.

## Rendering

`@hearth/runtime/pixi`'s `PixiSceneView` (used by the editor's game preview,
the exported web player, and `hearth screenshot`) stacks four layers on the
PixiJS stage, bottom to top:

1. **`world`**: one container per entity (sprites, text, tilemaps,
   `LineRenderer` polylines), plus a nested `particleLayer` holding one
   `Graphics` per live `ParticleEmitter`, keyed by emitter entity id rather
   than parented to the emitter's own node. Particles are already
   simulated in world space by the runtime, so they must not inherit the
   emitter entity's rotation/scale.
2. **`lightmapSprite`**: a multiply-blended sprite over the whole world,
   filled each tick from an offscreen render target: an ambient-gray fill
   from `Camera.ambientLight` plus one additive radial sprite per enabled
   `Light2D`. When `ambientLight` is fully bright (`1`) and no lights are
   enabled, the sprite stays hidden and none of this work runs. A project
   with no lighting renders byte-identical to before this feature existed.
3. **`debugLayer`**: collider outlines, `PhysicsBody` velocity vectors, and
   `Light2D` radii, drawn in world coordinates above the lightmap (so debug
   lines read at full brightness regardless of scene darkness). One
   `Graphics`, redrawn only while `debugDraw` is on; `false` by default and
   never set by the export template. See
   [export.md](./export.md#debug-overlay).
4. **`ui`**: screen-space `UIElement` entities, always on top, unaffected
   by camera position/zoom or the lightmap.

## Physics response

`packages/runtime/src/physics.ts` is a **positional resolver, not an
impulse solver**: each contact pair produces a minimal-translation-vector
(MTV) push (axis-of-least-penetration for box-vs-box, true closest-point/
SAT math for anything touching a circle or convex polygon) and only then
derives a velocity response from that push's normal, rather than
integrating forces. Restitution reflects the inbound normal-velocity
component (scaled by `restitution`, suppressed below a 20 px/s incoming
speed to avoid endless micro-bounce jitter as a body settles); friction
damps the tangential component proportionally to `dt`. Both are combined
per pair by taking the **max** of each side's value, never an average or a
material lookup table, and a solid `Tilemap`'s cells (having no
`PhysicsBody` of their own) are always an effective `(restitution: 0,
friction: 0)` contact partner. Mass only matters between two `dynamic`
bodies pushing on each other (the correction splits proportionally);
`static`/`kinematic` obstacles are effectively infinite mass regardless of
a mover's own. See [components.md](./components.md#physicsbody) for the
full field reference.

## Events

`ctx.events` is a synchronous, deterministic pub/sub bus scoped to one
running scene (`SceneRuntime.emitEvent`, `packages/runtime/src/events.ts`
for subscription bookkeeping): an `emit` delivers immediately and in a
fixed order: every `ctx.events.on` subscriber for that name first
(subscription order), then every entity's `onEvent(ctx, name, data)`
script hook (creation order, unfiltered by name), rather than queuing
anything to a later frame, so event-driven logic stays exactly as
deterministic as the rest of a fixed-timestep run. Recursion is bounded
(an emit fired from inside another emit's delivery can nest up to 8 deep
before being dropped with a console warning) and subscriptions are owned
by the entity that created them, torn down automatically when that entity
is destroyed. Playtests record every emit and a running count per name,
asserted with the `assertEventCount` step. See
[scripting.md](./scripting.md#events).

## Pathfinding

`ctx.scene.findPath`, `hearth inspect path`, and the `inspect_path` MCP
tool all resolve to the same core module, `packages/core/src/pathfinding.ts`:
a deterministic grid A\* with cardinal (default) or 8-directional
movement, over a nav grid built from every solid `Tilemap` and every
non-trigger `static` `Collider` (a `dynamic`/`kinematic` body, or no
`PhysicsBody`, is never an obstacle). The runtime and the offline
command build that grid from different sources: the runtime scans the
*live* running scene each frame (cached per frame, since geometry rarely
changes mid-frame), the CLI/MCP command scans the *authored* scene file,
but both funnel into the same `buildNavGrid`/`findPath` functions, so a
route computed offline in an editor tool matches what a script would get
at runtime. A path is an array of grid-cell centers, not the raw
endpoints; a query that starts or ends in a solid cell finds no path on
either surface. Oversized grids (over 512×512 cells) differ by surface:
`ctx.scene.findPath` logs a warning and returns no path (a script keeps
running), while the `hearth inspect path` / `inspect_path` command fails
with an `INVALID_INPUT` error rather than reporting `found: false`.

## Asset pipeline

`Asset.metadata` (`z.record(z.string(), z.unknown())`, deliberately
untyped at the schema level, since every asset kind stuffs different
data into it) is where spritesheet slicing, image probing, and animation
frame counts all live; nothing about an asset's *kind* changes, only what
ends up in this bag. `sliceSpritesheet` writes a typed frame list
(`metadata.frames: SpritesheetFrame[]`) plus the grid params that
produced it (`metadata.grid`) straight onto the sheet asset. No new
asset is created, and re-slicing replaces the list wholesale rather than
merging.

**Accessor rule**: nothing reads `asset.metadata.frames` directly.
Every consumer (the Pixi renderer's sub-texture cache, `SpriteAnimator`
playback, `hearth validate`'s `FRAME_NOT_FOUND`/`ANIMATION_FRAME_NOT_FOUND`
checks, and the slice/anim-from-sheet commands themselves) goes through
`getSheetFrames(asset)`/`findSheetFrame(asset, name)`
(`packages/core/src/assets/sheetFrames.ts`), which parses the raw
`unknown` value through `SpritesheetFrameSchema` and returns `[]`/`null`
on anything malformed. A hand-edited or corrupt frame list degrades to
"no frames" everywhere at once, rather than each surface needing its own
defensive parsing (or, worse, throwing).

Animation assets reuse the same `.anim.json` file shape
(`AnimationDataSchema`) whether their `frames` are plain sprite-asset ids
(`createAnimationAsset`) or sheet refs (`createAnimationFromSheet`,
`"<sheetAssetId>#<frameName>"`). The animator and the validator both
split on the first `#` to tell the two apart, so nothing downstream
needs a second animation asset type.

**Bundle metadata**: `hearth export web`'s `WebExportBundle` carries each
asset's `metadata` field through verbatim (`exportCommands.ts`), for both
the multi-file build and the single-file (`data:` URI) build. A shipped
game's player reconstructs an in-memory `ProjectStore` from the bundle
(`packages/runtime/src/player/index.ts`), and that store's assets need
real `metadata.frames`/`metadata.grid` for sliced sheets to render
correctly, exactly as they do from the authored `assets.json`. See
[assets.md](./assets.md) for the full import → slice → animate → play
walkthrough.

## Prefabs

`packages/core/src/project/prefabData.ts` is the pure, file-I/O-free layer
`createPrefab`/`instantiatePrefab`/`updatePrefab`/`syncPrefabInstances`/
`revertPrefabOverride` (`packages/core/src/commands/prefabCommands.ts`)
all build on: `collectSubtree` (root-first BFS over a scene's flat entity
list, following `parentId`), `serializePrefab` (subtree →
normalized-local-id `PrefabData`, stripping any `prefab` marker so
nested-prefab instances flatten into plain entities), and
`instantiatePrefabData` (payload → fresh scene entities with new `ent_*`
ids) for a brand-new placement. `updatePrefab`/`syncPrefabInstances` use a
separate function, `buildMergedInstance`, instead of a plain instantiate:
a merge reuses each existing local's scene id (from the marker's `ids`
map), mints ids only for genuinely new locals, drops entities for removed
locals, and re-applies the marker's recorded `overrides` on top of the
rebuilt components (dropping and reporting any that no longer resolve).
`recordInstanceOverride`/`findInstanceMembership`/
`detachInstanceContaining` are the other three load-bearing helpers here:
the first records an implicit override whenever `setComponentProperty`/
`setProperties` touches a live instance member, the second resolves any
member entity back to its instance root by reverse-scanning `ids` maps,
and the third removes a marker outright when a structural edit (add/
remove entity or component) breaks the merge link. The runtime's
`spawnPrefab` (`packages/runtime/src/runtime.ts`) calls the plain
`instantiatePrefabData` at play time, same as `instantiatePrefab` the
command: one instantiation code path for both "author time" and "play
time," so behavior can't drift between the two; runtime-spawned entities
never carry a `prefab` marker; there's no asset to merge-sync back to. See
[prefabs.md](./prefabs.md) for the full data model, command reference, and
live-link merge/detach semantics.

## Filesystem abstraction

Core never imports `node:fs`. Everything goes through the `FsLike` interface
(`NodeFileSystem` in Node, `MemoryFileSystem` in tests/browser demos, an
HTTP adapter in the editor's browser preview). This keeps core usable in the
browser and makes the whole engine trivially testable in memory.

## Permission model

Escalating grants checked at the command layer (see `permissions.ts`):
`read-only` (always implied) → `safe-edit` (scene/entity/component CRUD) →
`code-edit` (scripts) → `asset-edit` (assets) → `build`. The CLI takes
`--allow`, the MCP server `--mode`. Arbitrary shell execution is deliberately
not exposed to agents; asset removal (`removeAsset`) refuses while references
exist and keeps the file on disk unless `deleteFile: true`.

## Extension paths (documented, not built)

- Multi-instance components per entity (array form behind a `formatVersion` bump).
- Tauri-native project server (sidecar) as an alternative to the Electron desktop shell.
- TypeScript scripts (compile step in the script engine).
