# Wave 0 — Lua first-class scripting, shared ctx v2, scene management, no-chrome export

Frozen contract for the v0.3 Wave 0 build (see
`2026-07-02-v0.3-engine-systems-backlog.md`, sections 8 and the second
standing rule). Agents implement against the interfaces here; do not change
a frozen interface without coordinator sign-off. Coordinator has already
landed the schema edits (BuildSettings.loading, Playtest.seed, playtest
`click` + `assertScene` steps) in `packages/core/src/schema/project.ts`.

## Goals

1. **Lua is the first-class scripting language.** wasmoon (Lua 5.4 on WASM,
   ~250KB) runs the same `ctx` API as JS in every host: editor preview,
   headless playtests (Node), and the exported web player. JS scripts keep
   working unchanged. `hearth create script` emits `.lua` by default.
2. **ctx v2 — the stdlib that makes real games possible**: scene management
   (`ctx.scenes.load` — user-built menus/start screens), timers, tweens,
   seeded RNG, persistence (`ctx.save`/`ctx.load`), camera control. One
   surface, identical in both languages, documented via `hearth inspect api`.
3. **No engine chrome in shipped games.** The exported player boots straight
   into the initial scene: no Hearth start screen, no branding. Loading
   visuals come from `buildSettings.loading` (neutral defaults). Audio
   unlocks silently on the first natural user input.
4. **Structured script diagnostics**: `validateProject` reports script syntax
   errors with file + line for both languages so agents self-fix without
   booting the game.

## Non-goals (later waves)

ctx.math / ctx.events (Wave B), pathfinding (Wave B), Luau-style type
annotations, Lua editor completions/highlighting, music streaming, the
embedded agent panel (Wave D). Visual logic editor.

---

## Architecture

### GameSession (new, packages/runtime/src/session.ts — Agent R)

`SceneRuntime` stays single-scene and keeps its exact current API (plus the
additions below). Cross-scene orchestration lives in a new wrapper that all
hosts adopt:

```ts
export interface SessionStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
export class MemorySessionStorage implements SessionStorage { /* Map-backed */ }

export interface SceneEvent { frame: number; from: string | null; to: string }

export interface GameSessionOptions {
  scene?: string;               // default: project.initialScene ?? first scene
  seed?: number;                // default 0; one RNG stream across scenes
  storage?: SessionStorage;     // default MemorySessionStorage
  onLog?(e: RuntimeLog): void;
  onError?(e: RuntimeError): void;
  onAudio?(e: AudioPlaybackEvent): void;
  /** Fired after a scene switch completes (new runtime is live). */
  onSceneChange?(e: SceneEvent): void;
  maxLogs?: number;
}

export class GameSession {
  static create(store: ProjectStore, opts?: GameSessionOptions): Promise<GameSession>;
  /** The live runtime for the current scene. Replaced on scene switch. */
  readonly runtime: SceneRuntime;
  readonly currentSceneId: string;
  /** Monotonic across scene switches. */
  readonly frame: number;
  readonly elapsed: number;
  /** Aggregated across all scenes this session has run. */
  readonly logs: RuntimeLog[];
  readonly errors: RuntimeError[];
  readonly audioEvents: AudioEvent[];
  readonly sceneEvents: SceneEvent[];
  /** True while an async scene switch is in flight (hosts skip stepping). */
  readonly switching: boolean;
  /**
   * Step one fixed frame. If the scripts requested a scene change this
   * frame, kicks off the async swap; while `switching` is true further
   * step() calls are no-ops. Await stepAsync() instead when determinism
   * matters (playtests): it steps and awaits any pending swap.
   */
  step(): void;
  stepAsync(): Promise<void>;
  destroy(): void;
}
```

Scene switch semantics: old runtime is destroyed; the new scene's runtime is
created fresh (scripts recompiled; entities re-instantiated from authored
state). The RNG stream, storage, frame counter, and aggregated logs carry
across. Audio: all active playbacks of the old scene stop (session emits
stop AudioPlaybackEvents for them). The Lua engine instance is shared across
scenes (created once per session, script chunks recompiled per scene).

### SceneRuntime additions (Agent R, packages/runtime/src/runtime.ts)

```ts
export interface RuntimeOptions {
  // ...existing...
  seed?: number;                       // default 0 (standalone use)
  rng?: () => number;                  // session-provided stream (wins over seed)
  storage?: SessionStorage;            // default MemorySessionStorage
  luaEngine?: LuaScriptEngine;         // session-shared; created on demand if
                                       // absent and a .lua script is present
  frameOffset?: number;                // session frame base for logs/reports
}
// New members:
runtime.pendingScene: string | null    // validated scene id, set by ctx.scenes.load
```

`ctx.scenes.load(idOrName)` validates against the store: unknown scene →
warn log + return false, runtime keeps going. Known scene → sets
`pendingScene` to the scene id, returns true. The runtime itself never
swaps; hosts/GameSession react after `step()`.

### ctx v2 (Agent R; identical surface in Lua via Agent L)

Additions to `ScriptContext` in packages/runtime/src/scripts.ts (R owns the
file; exact shape):

```ts
scenes: {
  /** Current scene {id, name}. */
  current: { id: string; name: string };
  list(): { id: string; name: string }[];
  /** Request a scene switch at end of frame. False if unknown. */
  load(idOrName: string): boolean;
};
timers: {
  /** Run fn once after `seconds`. Returns a cancel id. */
  after(seconds: number, fn: () => void): string;
  /** Run fn every `seconds`. Returns a cancel id. */
  every(seconds: number, fn: () => void): string;
  cancel(id: string): void;
};
tweens: {
  /**
   * Tween a numeric component property on this entity, e.g.
   * to('Transform.position.x', 400, 0.5, { easing: 'easeOut' }).
   * Returns a cancel id. Unknown/non-numeric path → warn log + '' id.
   */
  to(path: string, target: number, seconds: number,
     opts?: { easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
              onComplete?: () => void }): string;
  cancel(id: string): void;
};
random: {
  /** Seeded, deterministic [0, 1). Same seed → same sequence. */
  next(): number;
  range(min: number, max: number): number;   // float
  int(min: number, max: number): number;     // inclusive
};
/** Persistent save data (JSON values), survives scene switches; in the
 *  browser it persists across sessions via localStorage. */
save(key: string, value: unknown): void;
load(key: string): unknown;                  // null when absent
clearSave(key?: string): void;               // no key = clear all
camera: {
  getPosition(): Vec2;
  setPosition(x: number, y: number): void;
  getZoom(): number;
  setZoom(zoom: number): void;
  /** Follow an entity each frame (null stops). Warn log if not found. */
  follow(idOrName: string | null): void;
};
```

Timing semantics (deterministic): each `step()`, timers fire (creation
order) and tweens advance right before that entity's `onUpdate`; camera
follow applies at end of frame after physics. Timers/tweens belong to the
entity whose ctx created them and die with it. RNG: mulberry32 (new
`packages/runtime/src/stdlib.ts`, R owns: `createRng(seed)`, timers, tweens,
easing fns). `ctx.camera` mutates the main Camera entity's live components
(no camera entity → warn once, no-op).

### Lua engine (Agent L, packages/runtime/src/lua.ts — new file)

wasmoon dependency added to packages/runtime/package.json (regular
dependency; it must ship in the player bundle and the CLI).

```ts
export function isLuaPath(path: string): boolean;   // path.endsWith('.lua')

export interface LuaEngineOptions {
  /** Seeded stream backing Lua's math.random. */
  random(): number;
  /** Sink for Lua print() and engine-level warnings. */
  log(level: 'info' | 'warn', message: string): void;
}

export class LuaScriptEngine {
  static create(opts: LuaEngineOptions): Promise<LuaScriptEngine>;
  /**
   * Compile a Lua script (must `return` a table of hook functions) into
   * the same ScriptHooks shape JS scripts produce. Hook calls are sync.
   * Throws Error (message includes the Lua line) on syntax/eval failure.
   */
  compile(path: string, source: string): ScriptHooks;
  dispose(): void;
}

/** Override where wasmoon loads its WASM from (data: URI or URL).
 *  Bundlers call this; Node default resolution needs no call. */
export function setLuaWasmUri(uri: string): void;
```

Lua script shape (the template C emits):

```lua
local script = {}
function script.onStart(ctx) end
function script.onUpdate(ctx, dt) end
function script.onCollision(ctx, other) end
function script.onUiEvent(ctx, event) end
return script
```

Binding rules:
- ctx is the *same JS object* proxied into Lua by wasmoon. Calls use dot
  syntax (`ctx.log("hi")`, `ctx.scenes.load("level")`) — NOT colon syntax.
  Template and docs must teach this explicitly.
- Sandbox: after engine create, remove/nil `os`, `io`, `package`, `require`,
  `dofile`, `load`, `loadstring`, `debug`, `collectgarbage`. `print(...)` →
  opts.log('info', ...). `math.random`/`math.randomseed` → opts.random
  (preserve Lua's `math.random(m)`, `math.random(m,n)` integer forms).
- Each compile evaluates the chunk with the script path as the chunk name so
  error messages carry `scripts/foo.lua:LINE`.
- Hook errors propagate as JS exceptions (SceneRuntime.callHook already
  catches, records, and disables after 3 consecutive errors).
- Determinism: no wall clock, no Math.random — only opts.random.

Agent L tests (packages/runtime/tests/lua.test.ts): compile + hooks fire
with a stub ctx; dot-call marshaling of nested objects/functions; sandbox
(os/io/require are nil, print routes to log); math.random determinism for a
fixed stream; syntax error carries the line; consecutive-error disable works
through the Lua path (via a tiny SceneRuntime scene — allowed to touch
runtime read-only).

### Script loading dispatch (Agent R)

`loadScripts()` compiles by extension: `.lua` → `luaEngine.compile(path,
source)` (engine created on demand via `LuaScriptEngine.create` if options
did not pass one), everything else → existing `compileScript`. Mixed
projects (some .js, some .lua) are supported and tested.

### Playtest runner (Agent R, packages/playtest/src/index.ts)

- Switch from `SceneRuntime.create` to `GameSession.create` with
  `seed: playtest.seed`, using `stepAsync()`-based frame advancement so
  scene switches complete deterministically between frames.
- New steps: `click` → `runtime.sendPointer(x, y, 'move')` then `'down'`
  then `'up'` (same frame), then run 1 frame; `assertScene` → passes when
  session.currentSceneId or the current scene's name equals `step.scene`.
- `PlaytestResult` and `SmokeResult` gain `sceneEvents: SceneEvent[]` and
  `finalScene: string`. Frames/logs/errors/audioEvents come from the session
  aggregates (monotonic across switches).
- `runSceneSmoke` also moves to GameSession (a smoke run that switches
  scenes should keep running).

### Pixi host + web player (Agent P)

- `PixiSceneView` (packages/runtime/src/pixi/index.ts) drives a GameSession:
  `opts.scene` becomes optional (default initialScene), add `opts.seed`,
  `opts.storage`, `opts.onSceneChange`. On scene switch: rebuild display
  nodes for the new runtime, keep the canvas/app, re-resolve textures
  (preload textures for ALL scenes' sprite assets up front — the bundle is
  local, this is cheap and avoids async pops). Keyboard/pointer wiring must
  target the *current* runtime after swaps. `view.runtime` stays as a
  getter for the session's current runtime (editor Inspector uses it).
- Storage adapter: new `localStorageAdapter(projectId)` in pixi land —
  keys `hearth:<projectId>:<key>` — used by the player and editor preview.
- **Silent audio unlock** (packages/runtime/src/pixi/audio.ts): create the
  AudioContext up front; if suspended, resume on the first pointerdown /
  keydown / touchstart anywhere in the window (once). Plays issued while
  suspended are queued and started on resume (looping music starts from 0;
  one-shot SFX older than ~0.5s are dropped instead of bursting). No UI.
- **Player rework** (packages/runtime/src/player/index.ts): DELETE the
  themed start screen entirely (DARK/EMBER constants included). Boot
  sequence: mount styled with `buildSettings.loading.backgroundColor`
  (fallback `#000000`) → optional centered loading image (resolve the
  `loading.image` asset id through the bundle assets) → optional neutral
  spinner (small monochrome CSS ring, no text, no logo) → load store +
  preload → mount pixi view → remove loading layer. Nothing Hearth-branded
  can appear at any point. Player passes `localStorageAdapter(projectId)`
  and seed 0.
- **Player bundle must include the Lua engine**: packages/runtime/scripts/
  build-player.mjs inlines wasmoon's glue.wasm (esbuild `loader: { '.wasm':
  'binary' }` or base64 define) and the entry calls `setLuaWasmUri` with a
  data: URI before any boot. Verify the bundle boots a .lua project in a
  headless-ish check if feasible; otherwise assert the wasm bytes are
  embedded (bundle contains the wasm magic) in a test.
- **exportWeb** (packages/core/src/commands/exportCommands.ts): generated
  index.html gets `<title>` from buildSettings.title (fallback project
  name), page background = loading.backgroundColor, and the loading image
  asset (if set) must be included in the bundle even when no scene
  references it. No other core files.

### Core commands, validation, docs generation (Agent C)

- `createScript` (packages/core/src/commands/scriptCommands.ts): new param
  `language: z.enum(['lua','js']).default('lua')`; emits `.lua` (new
  LUA_SCRIPT_TEMPLATE documenting the full ctx surface incl. v2, dot-call
  rule) or `.js` (existing template, updated with the ctx v2 lines).
  `editScript`/`attachScript` already path-based — verify `.lua` flows
  through; adjust any `.js`-hardcoded assumptions anywhere in core/CLI/MCP.
- **Settings command**: check the registry for an existing way to update
  buildSettings / initialScene / inputMappings via command. If (as
  suspected) none exists, add `updateSettings` (permission `safe-edit`,
  partial deep-merge of buildSettings incl. `loading`, plus optional
  `initialScene`, plus inputMappings actions) in sceneCommands.ts or a new
  settingsCommands.ts + registry entry. The no-chrome loading settings MUST
  be reachable by agents (standing rule).
- **Validation** (packages/core/src/validate.ts): per-script syntax check.
  JS: `new Function` compile in try/catch → `SCRIPT_SYNTAX_ERROR` (error)
  with script path and, when extractable, line. Lua: add `luaparse` dep to
  packages/core (pure JS, browser-safe; luaVersion '5.3' is fine) →
  `SCRIPT_SYNTAX_ERROR` with path + line + message. Also
  `SCRIPT_UNKNOWN_EXTENSION` warning for scripts that are neither .js nor
  .lua. ValidationIssue gains optional `line?: number`.
- **`inspectApi` command** (registry name `inspectApi`, CLI
  `hearth inspect api --json`): returns the machine-readable ctx API. Source
  of truth: new `packages/core/src/ctxApi.ts` — a plain data structure
  `CTX_API: { path, kind: 'method'|'property', signature, description,
  example: { js, lua } }[]` covering the ENTIRE ctx surface (v1 + v2, per
  this spec). Keep it in exact sync with the runtime interfaces above.
- **agentFiles.ts**: AGENTS.md scripting section now generated from
  CTX_API, Lua-first (Lua example first, JS variant noted), documents the
  dot-call rule, scene switching pattern for menus, save/load, seeding, and
  `hearth inspect api`. Golden rules updated: "scripts are Lua by default
  (.js also supported)".
- CLI (packages/cli): wire `create script --language`, `inspect api`, and
  any updateSettings flags following existing program.ts patterns. MCP
  (packages/mcp-server): confirm new/changed commands surface as tools
  (follow how exportWeb was wired in v0.2).
- Tests in packages/core/tests (+ cli tests if that suite exists): lua/js
  template creation, syntax validation both languages (line numbers
  asserted), updateSettings round-trip incl. loading, inspectApi shape.

### Editor, examples, docs (Agent E)

- Editor (apps/editor): call `setLuaWasmUri` before any preview boots —
  vite: `import wasmUrl from 'wasmoon/dist/glue.wasm?url'` (add
  `assetsInclude` if needed); confirm the Electron build path also resolves
  (esbuild bundling in scripts/build-electron.mjs may need the same
  binary-inline treatment as the player). GamePreview: adopt the new
  PixiSceneView session behavior (scene switches just work; show the
  current scene name in the preview header if trivially easy). Editor
  must not break when a project has .lua scripts.
- Examples (packages/examples/generate.mjs — GENERATED, edit the generator):
  add a new example `menu-quest` (working title, pick better): **all-Lua**,
  two scenes — a menu scene that is a user-built start screen (Text title +
  interactive UIElement "Start" button whose onUiEvent does
  `ctx.scenes.load("Level")`) and a level scene using `ctx.timers`,
  `ctx.random`, `ctx.camera.follow`, and `ctx.save/load` (e.g. best score
  persists). Playtests: `click` the Start button → `assertScene` Level →
  play a bit → `assertNoErrors`; plus a determinism-flavored assert using
  the seeded RNG. Keep existing JS examples as-is (they prove JS support).
- Docs: `docs/scripting.md` rewritten Lua-first (full ctx v2 reference,
  dot-call rule, JS section after), `docs/export.md` updated (no start
  screen; loading settings; audio unlock note), README + docs/architecture
  touch-ups where they mention JS scripting or the start screen,
  docs/roadmap.md: mark Wave 0 items done.
- Tests: packages/examples/tests must pass with the new example (its
  playtests run through the real Lua path — this is the end-to-end proof).

---

## File ownership (hard boundaries)

| Agent | Owns (only these) |
|---|---|
| R | packages/runtime/src/{runtime,scripts,stdlib,session,index}.ts, packages/runtime/tests/{runtime,scripts,session,stdlib}*.test.ts, packages/playtest/** |
| L | packages/runtime/src/lua.ts, packages/runtime/tests/lua.test.ts, packages/runtime/package.json (wasmoon dep line only) |
| C | packages/core/src/{commands/scriptCommands.ts,commands/sceneCommands.ts or new settingsCommands.ts,commands/inspectCommands.ts,commands/registry.ts,validate.ts,ctxApi.ts,agentFiles.ts,index.ts}, packages/core/package.json (luaparse), packages/core/tests/**, packages/cli/**, packages/mcp-server/** |
| P | packages/runtime/src/pixi/**, packages/runtime/src/player/**, packages/runtime/scripts/build-player.mjs, packages/core/src/commands/exportCommands.ts, packages/core/tests/export*.test.ts (new file only) |
| E | apps/editor/**, packages/examples/**, docs/** (except this spec), README.md |

Coordinator owns: packages/core/src/schema/**, package-lock.json (post-wave
`npm install` resync — this bit us in v0.2), version bumps, release.

Cross-boundary needs go through the frozen interfaces above. If an agent
finds the contract impossible as written, it reports back instead of editing
another agent's files.

## Testing bar

Full suite (`npx vitest run` at root) green; every agent adds tests for its
own surface. The end-to-end proof is E's all-Lua example playtest passing
headlessly (Lua VM + scenes.load + click + save + seeded RNG in one run).
Determinism: two GameSession runs with the same seed produce identical
transforms after N frames (R tests this; L tests the math.random stream).

## Out of scope guardrails

- Do not rename or break any existing command, schema field, or export.
- JS scripts and all v0.2 examples keep passing untouched.
- No new UI panels; no Lua editor tooling; no music streaming.
- Zero Hearth branding anywhere a player can see.
