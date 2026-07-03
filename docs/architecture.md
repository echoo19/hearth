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
| `packages/core` | Zod schemas for every file format; `ProjectStore` (load/save); the **command registry** (~45 operations, including web export and the `ctx` API reference); validation; structural diff; permission model; procedural asset generation (SVG sprites/tiles, WAV sounds); AGENTS.md/CLAUDE.md generation. Browser-safe: Node fs access is isolated in `@hearth/core/node`. |
| `packages/runtime` | 2D runtime: scene instantiation, fixed-timestep loop, input actions, box/circle/convex-polygon physics (SAT), screen-space UI with pointer hit-testing, audio (recorded headlessly, Web Audio in the browser), camera, and the script engine — **Lua 5.4 (sandboxed wasmoon VM) by default, JavaScript equally supported, one identical `ctx` API** with scene switching, timers, tweens, seeded RNG, and persistent save data. `SceneRuntime` runs a single scene; `GameSession` wraps it for cross-scene games (`ctx.scenes.load` swaps runtimes while the RNG stream, save storage, frame counter, and logs carry across). The main entry is **headless** (runs in Node for playtests); the PixiJS renderer is the separate `@hearth/runtime/pixi` subpath used by the editor's game preview, and the web-export player bundle is built from the same code. |
| `packages/playtest` | Headless playtest execution: scripted input + assertions over a `GameSession` (seeded, scene-switch aware), exposed as `RuntimeHooks` injected into core commands (`runPlaytest`, `runScene`). |
| `packages/cli` | `hearth`, the command-line surface. Every subcommand dispatches into the core command system; `--json` emits the raw `CommandResult` envelope for agents. |
| `packages/mcp-server` | `hearth-mcp`, a stdio MCP server exposing the same commands as typed MCP tools, with permission modes. |
| `packages/examples` | Four sample projects **generated through the command system itself** (`generate.mjs`); they double as integration tests and agent references. Three are JavaScript-scripted; `ember-trail` is all-Lua and exercises the scene/stdlib surface end to end. |
| `apps/editor` | Vite + React editor. A Vite-plugin project server (Node) opens `HearthSession`s and exposes `/api/command` etc.; the browser UI renders panels and dispatches commands. Tauri shell config included for desktop packaging. |

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

## Filesystem abstraction

Core never imports `node:fs`. Everything goes through the `FsLike` interface
(`NodeFileSystem` in Node, `MemoryFileSystem` in tests/browser demos, an
HTTP adapter in the editor's browser preview). This keeps core usable in the
browser and makes the whole engine trivially testable in memory.

## Permission model

Escalating grants checked at the command layer (see `permissions.ts`):
`read-only` (always implied) → `safe-edit` (scene/entity/component CRUD) →
`code-edit` (scripts) → `asset-edit` (assets) → `build`. The CLI takes
`--allow`, the MCP server `--mode`. Deletion of asset files and any arbitrary
shell execution are deliberately not exposed to agents in v0.1.

## Extension paths (documented, not built)

- Multi-instance components per entity (array form behind a `formatVersion` bump).
- Screenshot capture for agents (needs headless GPU or DOM snapshot strategy).
- Tauri-native project server (sidecar) for the packaged desktop app.
- TypeScript scripts (compile step in the script engine).
