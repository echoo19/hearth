# Script Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Hearth script can `require('lib/noise')` another script and use what it returns — in Lua and JS — with the same determinism, hot-reload, and export guarantees as everything else.

**Architecture:** All script sources are read up front into a map (phase 1, async), then compiled with a synchronous `require` resolving purely from that map (phase 2). A `ScriptModuleRegistry` owns sources, a memoized exports cache (a module body runs exactly once per session), a cycle-detection set, and a dependents graph that hot-reload consumes to recompile dependents.

**Tech Stack:** TypeScript ESM NodeNext (relative imports need `.js`), npm workspaces, vitest, wasmoon (Lua 5.4 in wasm).

Design spec: `docs/superpowers/specs/2026-07-15-script-modules-design.md`. Read it first.

---

## Binding rules for every task

- Do NOT `git push`. Commit per task.
- Do NOT edit generated files: `packages/examples/*` project JSON is produced by `packages/examples/generate.mjs`; `packages/templates/templates/*` by its generate.mjs. Edit the generator, rerun it.
- Run `npm run typecheck` alongside vitest — **vitest does not typecheck**.
- CLI/MCP suites consume `@hearth/core` via built dist: after core changes run `npm run build --workspace=@hearth/core` or they fail `UNKNOWN_COMMAND`.
- Stage only hunks you authored (`git add <explicit paths>`); other agents work in this tree concurrently.
- Existing behavior must stay bit-identical where untouched — golden determinism tests pin full-run state hashes.

## File Structure

- **Create** `packages/runtime/src/scriptModules.ts` — the registry: resolution, memo, cycles, dependents. One responsibility, no runtime/Pixi imports, unit-testable standalone.
- **Modify** `packages/runtime/src/scripts.ts` — `compileScript(source, require?)` gains an optional resolver param.
- **Modify** `packages/runtime/src/lua.ts` — `require` shim + `requireModule`; sandbox keeps a private `load`.
- **Modify** `packages/runtime/src/runtime.ts` — `loadScripts` two-phase; `reloadScript` invalidation.
- **Modify** `packages/core/src/project/store.ts` — `listScripts()` recursive.
- **Modify** `packages/core/src/validate.ts` + the `checkScript` command — broken-require diagnostics.
- **Modify** `apps/editor/src/` Code panel + Script picker — human surface.

---

### Task 1: Module registry — resolution, memo, cycles

**Files:**
- Create: `packages/runtime/src/scriptModules.ts`
- Test: `packages/runtime/tests/scriptModules.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { ScriptModuleRegistry } from '../src/scriptModules.js';

const sources = new Map([
  ['scripts/lib/noise.lua', 'return { n = 1 }'],
  ['scripts/player.lua', 'return {}'],
]);

describe('ScriptModuleRegistry.resolve', () => {
  it('resolves a spec against the scripts root, inferring the requirer extension', () => {
    const r = new ScriptModuleRegistry(sources);
    expect(r.resolve('lib/noise', 'scripts/player.lua')).toBe('scripts/lib/noise.lua');
  });

  it('accepts an explicit extension', () => {
    const r = new ScriptModuleRegistry(sources);
    expect(r.resolve('lib/noise.lua', 'scripts/player.lua')).toBe('scripts/lib/noise.lua');
  });

  it('rejects escaping the scripts root', () => {
    const r = new ScriptModuleRegistry(sources);
    expect(() => r.resolve('../../secrets', 'scripts/player.lua')).toThrow(/outside/i);
  });

  it('rejects a cross-language require', () => {
    const r = new ScriptModuleRegistry(new Map([...sources, ['scripts/util.js', 'export default {}']]));
    expect(() => r.resolve('util.js', 'scripts/player.lua')).toThrow(/same language|\.lua/i);
  });

  it('names the missing path when unresolvable', () => {
    const r = new ScriptModuleRegistry(sources);
    expect(() => r.resolve('lib/missing', 'scripts/player.lua')).toThrow(/scripts\/lib\/missing\.lua/);
  });
});

describe('ScriptModuleRegistry.load', () => {
  it('runs a module body exactly once and memoizes its exports', () => {
    let runs = 0;
    const r = new ScriptModuleRegistry(sources);
    const compile = (path: string): unknown => { runs++; return { path }; };
    expect(r.load('scripts/lib/noise.lua', compile)).toEqual({ path: 'scripts/lib/noise.lua' });
    expect(r.load('scripts/lib/noise.lua', compile)).toEqual({ path: 'scripts/lib/noise.lua' });
    expect(runs).toBe(1);
  });

  it('throws naming the full cycle path', () => {
    const r = new ScriptModuleRegistry(sources);
    const compile = (path: string): unknown => {
      if (path === 'scripts/player.lua') return r.load('scripts/lib/noise.lua', compile);
      return r.load('scripts/player.lua', compile);
    };
    expect(() => r.load('scripts/player.lua', compile)).toThrow(/cycle/i);
  });

  it('records dependents for hot reload', () => {
    const r = new ScriptModuleRegistry(sources);
    r.load('scripts/player.lua', (path) => {
      if (path === 'scripts/player.lua') r.load('scripts/lib/noise.lua', () => ({}), 'scripts/player.lua');
      return {};
    });
    expect([...r.dependentsOf('scripts/lib/noise.lua')]).toContain('scripts/player.lua');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/runtime/tests/scriptModules.test.ts`
Expected: FAIL — cannot find module `../src/scriptModules.js`.

- [ ] **Step 3: Implement the registry**

Requirements the tests pin (write the implementation to satisfy them exactly):
- `constructor(sources: Map<string, string>)`.
- `resolve(spec, fromPath): string` — join `scripts/` + spec, normalize `.`/`..`, **reject** any result not starting with `scripts/` (message contains "outside"). Infer the extension from `fromPath` when the spec has none. If the resolved path's extension differs from `fromPath`'s, throw a same-language error. If not in `sources`, throw naming the resolved path.
- `load(path, compile, fromPath?): unknown` — memoized in an `exports` map; guard with a `compiling` set and throw `Error('require cycle: a -> b -> a')` naming the chain; record `fromPath` into `dependents`.
- `dependentsOf(path): Set<string>` — direct dependents.
- `transitiveDependentsOf(path): Set<string>` — for hot reload (Task 4). Must terminate on cycles.
- `invalidate(paths: Iterable<string>)` — drop those `exports` entries.

Keep this file free of runtime/Pixi imports — it must unit-test standalone.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/runtime/tests/scriptModules.test.ts` → PASS.
Then: `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/scriptModules.ts packages/runtime/tests/scriptModules.test.ts
git commit -m "Add script module registry: resolution, memoization, cycle detection"
```

---

### Task 2: JS `require`

**Files:**
- Modify: `packages/runtime/src/scripts.ts:264` (`compileScript`)
- Test: `packages/runtime/tests/scriptModules-js.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { compileScript } from '../src/scripts.js';

describe('compileScript with a resolver', () => {
  it('passes require through to the script body', () => {
    const hooks = compileScript(
      `const lib = require('lib/math'); export default { onStart(ctx) { ctx.log(lib.two()); } }`,
      () => ({ two: () => 2 }),
    );
    const logged: unknown[] = [];
    hooks.onStart?.({ log: (v: unknown) => logged.push(v) } as never);
    expect(logged).toEqual([2]);
  });

  it('still compiles without a resolver (unchanged behavior)', () => {
    const hooks = compileScript(`export default { onStart() {} }`);
    expect(typeof hooks.onStart).toBe('function');
  });

  it('throws a clear error when a script requires without a resolver', () => {
    expect(() => compileScript(`const x = require('a'); export default {}`)).toThrow(/require/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/runtime/tests/scriptModules-js.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
export function compileScript(
  source: string,
  require?: (spec: string) => unknown,
): ScriptHooks {
  const body = source.replace(/export\s+default/, 'module.exports =');
  const factory = new Function('module', 'exports', 'require', body);
  const module = { exports: {} as unknown };
  const resolver =
    require ??
    ((spec: string): never => {
      throw new Error(`require('${spec}') is unavailable in this context`);
    });
  factory(module, module.exports, resolver);
  const hooks = module.exports;
  if (hooks === null || typeof hooks !== 'object') {
    throw new Error('script must `export default` an object with lifecycle hooks');
  }
  return hooks as ScriptHooks;
}
```

- [ ] **Step 4: Verify the error→line offset did not shift**

`runtime.ts:235` documents a line offset for the `new Function` wrapper. Adding a param on the **same line** must not change it. Run the existing error-line tests:

Run: `npx vitest run packages/runtime/tests --reporter=dot` → all PASS (2 tests reference `extractScriptErrorLine`).
If any line assertion moved, fix the offset constant and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/scripts.ts packages/runtime/tests/scriptModules-js.test.ts
git commit -m "Add optional require resolver to JS script compilation"
```

---

### Task 3: Lua `require` (the intricate one)

**Files:**
- Modify: `packages/runtime/src/lua.ts:108-109` (sandbox), `:202` (`compile`)
- Test: `packages/runtime/tests/scriptModules-lua.test.ts`

**Context you must know:**
- The sandbox chunk nils `os`, `io`, `package`, `require`, `dofile`, `load`. A Lua-side `require` needs to compile a chunk, which needs `load` — so the sandbox must **capture a private reference before nil'ing it** (e.g. `local __hearth_load = load` at the top of the sandbox chunk, kept in a local/upvalue so scripts cannot reach it).
- `compile(path, source)` already runs the chunk via `runChunkSync(this.engine, '@'+path, source)` and returns the *returned table*, then picks hook fields off it and **discards the rest**. So `requireModule` and `compile` share one execution — refactor `compile` to `pickHooks(runModule(path, source))` so a library that is both eagerly compiled and required runs its body **once**.
- Keep the module table **inside Lua**. Do not round-trip it through JS (that risks proxy/copy semantics; see the known "JS payloads cross as userdata" pitfall in docs/scripting.md). `require` should be a Lua function consulting a Lua-side cache table, calling out to JS only to resolve a spec → path and fetch source.
- Lua `ctx` calls use DOT syntax, never colon.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { LuaScriptEngine } from '../src/lua.js';

describe('Lua require', () => {
  it('returns a required module table and runs its body once', async () => {
    let bodies = 0;
    const engine = await LuaScriptEngine.create({
      random: () => 0.5,
      log: () => {},
      resolveModule: (spec: string) => `scripts/lib/${spec.replace(/^lib\//, '')}.lua`,
      readModule: (path: string) => { bodies++; return 'return { two = function() return 2 end }'; },
    } as never);
    const hooks = engine.compile(
      'scripts/player.lua',
      `local m = require('lib/math')
       return { onStart = function(ctx) ctx.log(m.two()) end }`,
    );
    const logged: unknown[] = [];
    hooks.onStart?.({ log: (v: unknown) => logged.push(v) } as never);
    expect(logged).toEqual([2]);
    // second requirer reuses the memoized module
    engine.compile('scripts/other.lua', `local m = require('lib/math') return {}`);
    expect(bodies).toBe(1);
    engine.dispose();
  });

  it('a required module cannot reach the sandboxed globals', async () => {
    const engine = await LuaScriptEngine.create({
      random: () => 0.5,
      log: () => {},
      resolveModule: () => 'scripts/lib/bad.lua',
      readModule: () => 'return { probe = function() return io == nil and os == nil and load == nil end }',
    } as never);
    const hooks = engine.compile('scripts/p.lua', `local m = require('lib/bad') return { onStart = function(ctx) ctx.log(m.probe()) end }`);
    const logged: unknown[] = [];
    hooks.onStart?.({ log: (v: unknown) => logged.push(v) } as never);
    expect(logged).toEqual([true]);
    engine.dispose();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/runtime/tests/scriptModules-lua.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Extend `LuaEngineOptions` with `resolveModule(spec, fromPath): string` and `readModule(path): string`. Install a `require` global in the sandbox backed by a Lua-side cache table and the captured `__hearth_load`. Refactor `compile` into `runModule` (returns the raw table, memoized per path) + `pickHooks`. Errors from a required module must carry the **library's** `path:LINE`, not the requirer's — `runChunkSync(engine, '@'+libPath, libSource)` already gives that via the chunk name; keep it.

**Security requirement (test 2 pins it):** a required module must run under the same sandbox — it must NOT see `io`/`os`/`load`. Do not implement `require` by evaluating source in a fresh unsandboxed environment.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/runtime/tests/scriptModules-lua.test.ts` → PASS.
Then the full Lua suite: `npx vitest run packages/runtime/tests` → PASS.
Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/lua.ts packages/runtime/tests/scriptModules-lua.test.ts
git commit -m "Add sandboxed require to the Lua script engine"
```

---

### Task 4: Recursive script discovery

**Files:**
- Modify: `packages/core/src/project/store.ts:210-218` (`listScripts`)
- Test: `packages/core/tests/listScripts.test.ts` (create if absent; otherwise extend the existing store test)

**Why:** `listScripts()` reads `scripts/` non-recursively, so `scripts/lib/noise.lua` is invisible to BOTH `loadScripts()` and `exportCommands.ts:256` (which enumerates it to bundle scripts). Without this, modules in a `lib/` folder silently fail to load and silently fail to ship. Both callers get subdirectory support for free once this recurses.

- [ ] **Step 1: Write the failing test**

```ts
it('finds scripts in subdirectories, sorted, project-relative', async () => {
  // build a store fixture with scripts/player.lua and scripts/lib/noise.lua
  // (follow the fixture pattern in the existing packages/core/tests store tests)
  expect(await store.listScripts()).toEqual(['scripts/lib/noise.lua', 'scripts/player.lua']);
});

it('ignores non-script files in subdirectories', async () => {
  // scripts/lib/README.md must not appear
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/tests/listScripts.test.ts` → FAIL (nested script missing).

- [ ] **Step 3: Implement**

Walk `scripts/` recursively (the `FsLike` interface in `packages/core/src/fs.ts` is what you have — check whether it exposes a stat/isDirectory; if not, detect a directory by `readdir` succeeding, matching how other recursive walks in this repo do it — grep `readPrefabFile`/prefab listing for the established pattern). Keep returning project-relative paths, still `.sort()`ed, still filtering `.lua`/`.js`/`.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core` → PASS.
Rebuild core (CLI/MCP suites need dist): `npm run build --workspace=@hearth/core`
Then: `npx vitest run` (full) → PASS. `npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/project/store.ts packages/core/tests/listScripts.test.ts
git commit -m "Discover scripts recursively so subdirectories load and ship"
```

---

### Task 5: Wire the registry into the runtime (two-phase load)

**Files:**
- Modify: `packages/runtime/src/runtime.ts:1578-1625` (`loadScripts`)
- Test: `packages/runtime/tests/scriptModules-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

A two-script fixture (`scripts/lib/math.lua` returning `{two=...}`, `scripts/player.lua` requiring it and logging in `onStart`), run through a real `SceneRuntime`, asserting the log. Mirror the fixture patterns in the existing runtime tests. Add the JS twin.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/runtime/tests/scriptModules-runtime.test.ts` → FAIL.

**CRITICAL integration detail (Task 3 landed differently than assumed).** The
Lua engine resolves requires *inside Lua* — its `require` closure calls the
host's `resolveModule(spec, fromPath)` / `readModule(path)` callbacks and
memoizes in a Lua-side cache. It never calls `ScriptModuleRegistry.load()`.
So **the registry's dependents graph will be EMPTY for Lua unless you record
the edge yourself inside the `resolveModule` callback** — which receives both
`spec` and `fromPath` precisely so you can. If you skip this, Task 6's
`transitiveDependentsOf` returns nothing for Lua, dependents never recompile
on hot reload, and the feature silently ships the exact stale-code bug this
design exists to prevent. Wire it as:

```ts
resolveModule: (spec, fromPath) => {
  const resolved = registry.resolve(spec, fromPath);
  registry.recordEdge(resolved, fromPath); // dependents graph
  return resolved;
},
readModule: (path) => sources.get(path)!,
```

Add `recordEdge(path, fromPath)` to the registry if `load`'s `fromPath` param
is the only way to record today — the Lua path needs edge recording
*without* going through `load`. Keep JS going through `registry.load`.

Also note the Lua engine memoizes on **path+source**, so its cache self-heals
when text changes; it also exposes `requireModule(path)` and
`invalidateModule(path)` for Task 6.

- [ ] **Step 3: Implement**

Restructure `loadScripts()`:
1. Collect `paths` exactly as today (from `listScripts()` + every entity's `Script.scriptPath`).
2. **Phase 1:** `await` every `store.readScript(path)` into a `Map<path, source>`. A read failure records the same load error as today and maps to `null`.
3. Construct `ScriptModuleRegistry` with that map; hold it on the runtime.
4. **Phase 2:** for each path, obtain hooks **through the registry** (`registry.load(path, compileFn)`) so the body runs once whether reached eagerly or by require — do NOT call `compileScript`/`luaEngine.compile` directly here (see the spec's "One compile path, or the body runs twice").
5. Per-path compile failures keep today's behavior: `scriptModules.set(path, null)` + `recordError({phase:'load'})`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/runtime/tests` → PASS (golden determinism tests included — a required helper must produce a bit-identical hash to the inlined equivalent).
Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/runtime.ts packages/runtime/tests/scriptModules-runtime.test.ts
git commit -m "Load scripts in two phases so require resolves synchronously"
```

---

### Task 6: Hot-reload invalidation

**Files:**
- Modify: `packages/runtime/src/runtime.ts:497-520` (`reloadScript`)
- Test: `packages/runtime/tests/scriptModules-reload.test.ts`

**Why this is the risky task:** hot-reload-during-play is v0.11's flagship feature. Its contract — a compile failure leaves the old code running, `ctx.vars`/timers/tweens survive, `onStart` does not re-run — must survive intact.

- [ ] **Step 1: Write the failing tests**

```
1. Editing a library recompiles its dependents: player requires lib.two()=2,
   logs 2; reload lib with two()=3; player's next onUpdate logs 3.
2. A library compile ERROR leaves the ENTIRE prior graph running: reload lib
   with a syntax error → returns ok:false, and player still logs 2 (not a
   half-swapped graph).
3. Reloading a leaf behavior still behaves exactly as before (no regression):
   ctx.vars survive, onStart does not re-run.
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/runtime/tests/scriptModules-reload.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`reloadScript(path, source)`:
1. Compute `affected = [path, ...registry.transitiveDependentsOf(path)]`.
2. Compile **all** affected into a staging map FIRST. If any throws → return `{ok:false, message, line}` and mutate nothing (contract 2).
3. Only on full success: update `sources`, `registry.invalidate(affected)`, commit the staged hooks into `scriptModules`, and re-point live entities for every affected behavior path (today's re-point logic, applied per affected path).
4. Dependents must be recorded fresh on recompile (a removed require must drop the edge) — clear the affected paths' outgoing edges before recompiling.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/runtime/tests` → PASS.
Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/runtime.ts packages/runtime/tests/scriptModules-reload.test.ts
git commit -m "Recompile dependents when a required module is hot-reloaded"
```

---

### Task 7: Diagnostics — checkScript + validate

**Files:**
- Modify: `packages/core/src/validate.ts`, the `checkScript` command (grep `checkScript` in `packages/core/src/commands/`)
- Test: alongside the existing validate/checkScript tests

- [ ] **Step 1: Write the failing tests**

```
- checkScript on a script requiring a nonexistent module → an issue with the
  attempted path and a line number.
- checkScript on a require cycle → an issue naming the cycle.
- hearth validate on a project with a broken require → a new SCRIPT_REQUIRE_*
  validation code (follow the existing code naming/shape in validate.ts, e.g.
  POLYGON_TOO_FEW_POINTS at validate.ts:43).
- A valid require → no issues.
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

Static analysis only — do NOT execute scripts to validate (validate is read-only and must stay side-effect free). Scan for `require('...')` / `require("...")` literal specs and resolve against the project's script list. A non-literal (computed) spec is not an error — skip it, and say so in the report.

Note: JS `checkScript` diagnostics are `line:null` by design (V8's `new Function` limit; `node:vm` is barred). Lua always carries a line. Match that existing contract.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core` → PASS. `npm run build --workspace=@hearth/core`. `npx vitest run` → PASS. `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git commit -m "Report unresolvable and cyclic requires in checkScript and validate"
```

---

### Task 8: Human surface — the editor

**Files:**
- Modify: `apps/editor/src/` — Code panel script list, Script component picker (grep `scriptPath` for the picker)
- Test: alongside existing editor tests

**Why:** a human opening the editor must see one coherent system, not an agent-only hook.

- [ ] **Step 1: Write the failing tests**

```
- The script list renders nested paths as a tree (scripts/lib/noise.lua nests
  under lib/), not 25 flat rows.
- A script with no lifecycle hooks is labeled a library.
- The Script component picker EXCLUDES hookless library scripts — attaching one
  silently does nothing today, which is a trap.
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

Follow the existing panel/primitive patterns. Binding house rules: **no raw-JSON fields**; use the shared Tooltip/Menu/Button primitives and `--text-*` tokens; the editor is single-theme dark; reveal idiom per the "Reveal idiom" block in `primitives.css` (`display:none` for action clusters in a roving-tabindex container, `opacity:0` for standalone tab-reachable controls).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/editor` → PASS. `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git commit -m "Show script libraries as a tree and keep them out of the behavior picker"
```

---

### Task 8b: `createScript` must be able to make a library (CLI/MCP-first)

**Files:**
- Modify: `packages/core/src/commands/scriptCommands.ts:150-177` (`createScript`)
- Modify: the CLI `create script` verb (`packages/cli/src`) and the MCP
  `create_script` tool (`packages/mcp-server/src`)
- Test: alongside the existing script-command tests

**Why (blocking):** `createScript` builds `slugify(name) + '.' + language` joined
to `SCRIPTS_DIR`. There is NO way to create `scripts/lib/noise.lua`. Without
this, an agent cannot author a library through the CLI/MCP surface at all —
the standing repo rule is that every system ships CLI/MCP-first — and
`packages/examples/generate.mjs` (which dogfoods the command system) cannot
build Task 9's example.

- [ ] **Step 1: Write the failing tests**

```
- createScript({ name: 'noise', dir: 'lib', language: 'lua' })
    → path 'scripts/lib/noise.lua', file exists on disk.
- dir is optional: createScript({ name: 'player' }) → 'scripts/player.lua'
    (unchanged behavior — existing tests must stay green).
- dir segments are slugified the same way names are: dir 'My Libs' → 'my-libs'.
- A traversal payload is rejected: dir '../..' → INVALID_INPUT.
- Creating over an existing nested path → CONFLICT (same as flat today).
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

Add an optional `dir: z.string().optional()` to `createScript`'s
`paramsSchema`. Build the path as `SCRIPTS_DIR` + slugified dir segments +
filename, then run the result through the **existing**
`resolveScriptsPath()` (scriptCommands.ts:186) — do NOT hand-roll a
traversal check; that helper exists precisely because a raw
`startsWith('scripts/')` passes payloads like `scripts/../hearth.json`.
Create parent directories as needed. Note `slugify` converts hyphens to
underscores in this repo, and `createScript` then maps `_` back to `-`;
apply the same treatment per dir segment so `lib` stays `lib`.

Surface it on both adapters: CLI `hearth create script noise --dir lib`, MCP
`create_script` gains `dir`. Update the command's `description` string (it
says "in scripts/") and its `ctx.suggest(...)` line if affected.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core` → PASS.
`npm run build --workspace=@hearth/core` (CLI/MCP suites read core's dist).
Run: `npx vitest run` → PASS. `npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "Let createScript author scripts in a subdirectory"
```

---

### Task 9: The proof — a procgen example on modules

**Files:**
- Modify: `packages/examples/generate.mjs` (examples are GENERATED — never hand-edit the project JSON)
- Rerun: `node packages/examples/generate.mjs`

- [ ] **Step 1: Build the example**

An 11th example whose generator lives in `scripts/lib/` — seeded cave or dungeon generation, the library shared by two behaviors. It must exercise: `require`, seeded `ctx.random`, whole-array `tilemap.grid` replacement (in-place mutation is NOT detected — see docs/scripting.md:100), and `ctx.scene.findPath` to prove connectivity.

`ctx.math` has no noise primitive — the library hand-writes value noise. That is the point: it is the argument for modules.

- [ ] **Step 2: Add a headless playtest**

Assert at a fixed seed that the generated level is connected (findPath from spawn to exit returns a path). **Never hand-compute particle/frame counts** — bake expectations from a probe run, the way the Glow Caves generator does.

- [ ] **Step 3: Regenerate and verify**

Run: `node packages/examples/generate.mjs && npx vitest run` → PASS. CI checks the tree is clean after a fresh regen, so commit the regenerated JSON in the same commit.

- [ ] **Step 4: Commit**

```bash
git add packages/examples/
git commit -m "Add a procgen example built on a shared script library"
```

---

### Task 10: Docs + the agent skills

**Files:**
- Modify: `docs/scripting.md` (the "v1 limitation: scripts cannot use import" claim is now FALSE — it appears in `packages/runtime/src/scripts.ts:10` too), `docs/project-format.md` (scripts/ is now a tree), `docs/roadmap.md`
- Modify: `packages/core/src/agentSkillContent.ts` (the canonical `hearth` skill) and the `hearth-craft` skill — both are drift-gated by `scripts/sync-agent-skill.mjs`; run it.

- [ ] **Step 1: Write the docs**

`docs/scripting.md` gains a **Script modules** section: `require('lib/noise')`, resolution rules, a library is just a script returning a table/object, same-language only, cycles error, the module-state-resets-on-reload caveat, and both a Lua and a JS example. Voice: plain and honest, no marketing. House tell to avoid: **em-dash overuse** — vary to periods/commas/parens.

- [ ] **Step 1b: Update the agent-facing command surface docs**

`docs/cli.md` (the `create script --dir` flag) and `docs/mcp.md` (the
`create_script` `dir` param) must reflect Task 8b. An agent reads these to
learn the surface exists; if `--dir` is undocumented, libraries are
effectively invisible to it.

- [ ] **Step 2: Teach the agents**

The `hearth-craft` skill should teach the module idiom as a recipe, since that is what agents read before writing game code. While here, fix the related documented bug: `docs/scripting.md:100` says an in-place `grid` edit uses stale boxes *"until the next frame"*, implying it self-corrects. It does not — the cache keys on **reference identity** (`runtime.ts:2099`), so a same-length in-place write is stale permanently. Correct that sentence.

- [ ] **Step 3: Verify no drift**

Run: `node scripts/sync-agent-skill.mjs` (or the repo's drift check) → clean. `npx vitest run` → PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "Document script modules and teach the idiom in the agent skills"
```

---

## Self-Review

**Spec coverage:** decision 1 (require/resolution) → T1,T2,T3; decision 2 (cycles) → T1,T7; decision 3 (same-language) → T1; decision 4 (hot reload) → T6; decision 5 (recursion) → T4; decision 6 (no asset type) → T8 (labeling only, no schema). Architecture: sync constraint → T5; registry → T1; JS → T2; Lua → T3; hot reload → T6. Human surface → T8. Testing → per-task + T9. Proof → T9. Docs → T10. No gaps.

**Type consistency:** `ScriptModuleRegistry` members used identically across T1/T5/T6: `resolve`, `load`, `dependentsOf`, `transitiveDependentsOf`, `invalidate`. `compileScript(source, require?)` matches T2 and T5. `LuaEngineOptions.resolveModule/readModule` matches T3 and T5.

**Known risk:** T6 touches the hot-reload path (v0.11 flagship). It carries the heaviest test burden and should go to a strong model, not a cheap one.
