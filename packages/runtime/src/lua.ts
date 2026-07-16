/**
 * Lua script engine — hosts Hearth behavior scripts written in Lua 5.4 via
 * wasmoon (Lua on WebAssembly). One engine instance hosts many compiled
 * script chunks; engine creation is async, but compiling and hook calls are
 * fully synchronous so the fixed-step loop stays deterministic.
 *
 * Marshaling: the JS `ctx` object crosses into Lua as a wasmoon proxy
 * userdata — a live reference, not a copy. Property reads and writes
 * (`ctx.transform.position.x = 4`) hit the real JS object, nested objects
 * proxy recursively, and JS functions are callable with DOT syntax
 * (`ctx.log("hi")`, never `ctx:log("hi")` — colon calls would pass ctx
 * twice). Lua tables passed the other way (e.g. into ctx.scene.spawn) are
 * converted to plain JS objects by value.
 *
 * Sandbox: `os`, `io`, `package`, `dofile`, `load`, `loadstring`, `debug`
 * and `collectgarbage` are nil'd at engine creation. `print(...)` routes to
 * the host log sink; `math.random` is backed by the host's seeded stream
 * (Lua integer semantics preserved) and `math.randomseed` is a warn-once
 * no-op, so no wall clock or Math.random can leak into game logic.
 *
 * Modules: when the engine has `resolveModule`/`readModule` callbacks —
 * given at creation or (re)bound later via `setModuleResolver()` —
 * `require(spec)` is a sandboxed shim: it resolves the spec via the host,
 * fetches source via the host, and compiles/runs the module INSIDE Lua with
 * a private pre-nil reference to `load` (held as an upvalue user chunks
 * cannot reach; `debug`, which could reach upvalues, is nil'd). Module
 * values are memoized per path in a Lua-side cache, so a module's top-level
 * body runs exactly once per compile generation whether it is reached by an
 * eager `compile()` or by `require` — and the module table never round-trips
 * through JS (avoiding the userdata-proxy pitfall for cross-boundary
 * payloads). Rebinding matters because GameSession shares ONE engine across
 * every scene the session runs, while module resolution closes over the
 * PER-SCENE registry: each SceneRuntime.loadScripts rebinds the shared
 * engine to its own registry. Until callbacks are bound, `require` stays nil
 * as before.
 */
import {
  LuaFactory,
  LuaTypeExtension,
  type Decoration,
  type LuaEngine,
  type LuaGlobal,
  type LuaThread,
} from 'wasmoon';
import type { EntityHandle, ScriptContext, ScriptHooks, UiEvent } from './scripts.js';

/** True when a script path should be compiled by the Lua engine. */
export function isLuaPath(path: string): boolean {
  return path.endsWith('.lua');
}

/** Module-level override for where wasmoon loads its glue.wasm from. */
let luaWasmUri: string | undefined;

/**
 * Override where wasmoon loads its WASM from (data: URI or URL). Bundlers
 * call this before the first LuaScriptEngine.create; Node needs no call
 * (wasmoon resolves its own glue.wasm next to its module).
 */
export function setLuaWasmUri(uri: string): void {
  luaWasmUri = uri;
}

/**
 * Host callbacks backing the sandbox's `require`. Bindable at creation
 * (LuaEngineOptions) or afterwards via setModuleResolver(); rebinding
 * replaces both callbacks atomically.
 */
export interface LuaModuleCallbacks {
  /**
   * Resolve a `require(spec)` from the script at `fromPath` to a script
   * path (e.g. 'lib/noise' from 'scripts/player.lua' →
   * 'scripts/lib/noise.lua'). Throw to reject the spec.
   */
  resolveModule(spec: string, fromPath: string): string;
  /**
   * Return the source text for a resolved module path. Called at most once
   * per path per compile generation — module values are memoized inside
   * Lua. Throw when the path has no source.
   */
  readModule(path: string): string;
}

export interface LuaEngineOptions {
  /** Seeded stream backing Lua's math.random. */
  random(): number;
  /** Sink for Lua print() and engine-level warnings. */
  log(level: 'info' | 'warn', message: string): void;
  /**
   * See LuaModuleCallbacks.resolveModule. When omitted (along with
   * readModule), `require` is nil in the sandbox until setModuleResolver
   * binds callbacks.
   */
  resolveModule?(spec: string, fromPath: string): string;
  /** See LuaModuleCallbacks.readModule. */
  readModule?(path: string): string;
}

/** A Lua function surfaced to JS by wasmoon; the call is synchronous. */
type LuaFunction = (...args: unknown[]) => unknown;

/**
 * Runs once per engine, right after creation, before any user chunk. The
 * host sinks (`__hearth_*` globals) are captured as locals and then removed
 * from the global table so scripts can never reach them directly. Returns a
 * control table (held privately by the JS engine, never stored in a Lua
 * global) whose `run(path, source?)` is the single, memoized module
 * execution path shared by compile() and `require`.
 *
 * `resolve_module`/`read_module` are JS trampolines that delegate to the
 * engine's CURRENT module callbacks (rebindable via setModuleResolver), so
 * they are captured once here and never replaced. The global `require` stays
 * nil until the JS side calls control.set_require_enabled(true) — done
 * exactly when callbacks are bound — preserving "no callbacks → require is
 * nil". The shim itself is a local upvalue of set_require_enabled, so user
 * chunks can never reach it (or its raw_load upvalue) while it is disabled.
 */
const SANDBOX_CHUNK = `
local print_sink = __hearth_print
local warn_sink = __hearth_warn
local next_random = __hearth_random
local resolve_module = __hearth_resolve_module
local read_module = __hearth_read_module
__hearth_print, __hearth_warn, __hearth_random = nil, nil, nil
__hearth_resolve_module, __hearth_read_module = nil, nil

-- Captured before the sandbox nils the globals below; these live only as
-- upvalues of the module machinery, which user chunks cannot reach (the
-- debug library, the one route to a function's upvalues, is nil'd, and
-- chunks compiled later never share this chunk's locals).
local raw_load = load
local raw_pcall = pcall
local raw_error = error
local raw_tostring = tostring
local concat = table.concat

print = function(...)
  local n = select('#', ...)
  local parts = {}
  for i = 1, n do
    parts[i] = tostring(select(i, ...))
  end
  print_sink(table.concat(parts, '\\t'))
end

local floor = math.floor
math.random = function(m, n)
  if m == nil then
    return next_random()
  end
  m = floor(m)
  if n == nil then
    if m < 1 then
      error("bad argument #1 to 'random' (interval is empty)", 2)
    end
    return floor(next_random() * m) + 1
  end
  n = floor(n)
  if m > n then
    error("bad argument #2 to 'random' (interval is empty)", 2)
  end
  return floor(next_random() * (n - m + 1)) + m
end

local randomseed_warned = false
math.randomseed = function()
  if not randomseed_warned then
    randomseed_warned = true
    warn_sink("math.randomseed() is a no-op in Hearth; the seed comes from the session")
  end
end

os = nil
io = nil
package = nil
require = nil
dofile = nil
load = nil
loadstring = nil
debug = nil
collectgarbage = nil

-- Module system. One execution path for every module body: run_module is
-- memoized per path, so a library reached both by the runtime's eager
-- compile() and by require() runs its top-level body exactly ONCE per
-- session (running it twice would be a silent determinism break). Module
-- values stay inside Lua; JS is consulted only to resolve a spec and fetch
-- source text.
-- path -> { value = v, source = s }; wrapped so a nil value still memoizes.
-- The source is remembered so a recompile of the SAME text (loadScripts
-- eagerly compiling a library that require() already ran) is a memo hit,
-- while hot reload -- compile() with CHANGED text -- re-runs the body.
local module_cache = {}
local path_stack = {}    -- chain of module bodies currently executing

local function run_module(path, source)
  local cached = module_cache[path]
  if cached ~= nil and (source == nil or cached.source == source) then
    return cached.value
  end
  for i = 1, #path_stack do
    if path_stack[i] == path then
      local cycle = {}
      for j = i, #path_stack do
        cycle[#cycle + 1] = path_stack[j]
      end
      cycle[#cycle + 1] = path
      raw_error('cyclic require: ' .. concat(cycle, ' -> '), 0)
    end
  end
  if source == nil then
    -- read_module is a JS trampoline; it raises when no callbacks are bound.
    source = read_module(path)
  end
  local chunk, load_err = raw_load(source, '@' .. path, 't')
  if chunk == nil then
    -- Cache untouched: a broken edit leaves the previous module running.
    raw_error(load_err, 0)
  end
  path_stack[#path_stack + 1] = path
  local ok, value = raw_pcall(chunk)
  path_stack[#path_stack] = nil
  if not ok then
    -- Re-raise unchanged (cache untouched): the chunk name above already
    -- stamped the LIBRARY's path:LINE into the message.
    raw_error(value, 0)
  end
  module_cache[path] = { value = value, source = source }
  return value
end

-- Held as a local so a DISABLED require is truly unreachable from user
-- chunks (require is nil in globals until set_require_enabled installs it).
local require_shim = function(spec)
  local from = path_stack[#path_stack]
  if from == nil then
    raw_error(
      "require('" .. raw_tostring(spec) .. "') is only available while a script is " ..
      'loading; require at the top of the file and keep the result in a local',
      2
    )
  end
  return run_module(resolve_module(spec, from))
end

return {
  run = run_module,
  invalidate = function(path)
    module_cache[path] = nil
  end,
  set_require_enabled = function(enabled)
    if enabled then
      require = require_shim
    else
      require = nil
    end
  end,
}
`;

/**
 * Load and run a chunk synchronously on the engine's main thread with an
 * explicit chunk name, restoring the stack afterwards (compile is called
 * many times on one long-lived engine; the stack must not grow).
 *
 * `chunkName` uses Lua source-name conventions: '@scripts/foo.lua' makes
 * errors read "scripts/foo.lua:LINE: message".
 */
function runChunkSync(engine: LuaEngine, chunkName: string, source: string): unknown {
  const thread = engine.global;
  const top = thread.getTop();
  try {
    thread.loadString(source, chunkName);
    const results = thread.runSync(0);
    return results[0];
  } finally {
    thread.setTop(top);
  }
}

function describeLuaValue(value: unknown): string {
  if (value === undefined || value === null) return 'nil';
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'object') return 'a table';
  return `${typeof value} (${String(value)})`;
}

/**
 * Marshal JS `null` to Lua `nil`. With `injectObjects: false` wasmoon skips
 * its own null extension, and a bare `null` (ctx.load miss, ctx.scene.find
 * miss, ctx.audio.play failure, null property reads through the proxy) falls
 * into the Promise extension, which reads `.then` off it and crashes.
 * Registered at priority 10 so it wins before any other extension sees null.
 */
class NullToNilTypeExtension extends LuaTypeExtension<null> {
  constructor(thread: LuaGlobal) {
    super(thread, 'hearth_null');
  }

  pushValue(thread: LuaThread, decoratedValue: Decoration<null>): boolean {
    if (decoratedValue.target !== null) return false;
    thread.lua.lua_pushnil(thread.address);
    return true;
  }

  close(): void {
    // Nothing allocated.
  }
}

/** Private handles into the sandbox chunk's module machinery. */
interface SandboxControl {
  run(path: string, source?: string): unknown;
  invalidate(path: string): unknown;
  set_require_enabled(enabled: boolean): unknown;
}

export class LuaScriptEngine {
  private engine: LuaEngine;
  private control: SandboxControl;
  private disposed = false;
  /**
   * The CURRENT module callbacks; the sandbox's trampolines read through
   * this holder on every call, which is what makes setModuleResolver a pure
   * JS-side swap (the Lua-side shim never changes). Null until bound;
   * `require` is only installed in the sandbox while callbacks exist.
   */
  private readonly moduleCallbacks: { current: LuaModuleCallbacks | null };

  private constructor(
    engine: LuaEngine,
    control: SandboxControl,
    moduleCallbacks: { current: LuaModuleCallbacks | null },
  ) {
    this.engine = engine;
    this.control = control;
    this.moduleCallbacks = moduleCallbacks;
  }

  /** Boot a wasmoon VM, install the sandbox, and return a ready engine. */
  static async create(opts: LuaEngineOptions): Promise<LuaScriptEngine> {
    const factory = new LuaFactory(luaWasmUri);
    const engine = await factory.createEngine({
      openStandardLibs: true,
      injectObjects: false,
      enableProxy: true,
    });
    const moduleCallbacks: { current: LuaModuleCallbacks | null } = {
      current:
        opts.resolveModule && opts.readModule
          ? { resolveModule: opts.resolveModule, readModule: opts.readModule }
          : null,
    };
    let control: SandboxControl;
    try {
      engine.global.registerTypeExtension(10, new NullToNilTypeExtension(engine.global));
      engine.global.set('__hearth_print', (message: string) => opts.log('info', message));
      engine.global.set('__hearth_warn', (message: string) => opts.log('warn', message));
      engine.global.set('__hearth_random', () => opts.random());
      // Trampolines to the CURRENT callbacks: captured once by the sandbox
      // chunk, they survive setModuleResolver rebinds unchanged. They throw
      // (→ a Lua error) if reached while unbound — normally unreachable,
      // since `require` is only installed while callbacks exist.
      engine.global.set('__hearth_resolve_module', (spec: string, fromPath: string) => {
        const callbacks = moduleCallbacks.current;
        if (!callbacks) throw new Error('script modules are not available in this engine');
        return callbacks.resolveModule(spec, fromPath);
      });
      engine.global.set('__hearth_read_module', (path: string) => {
        const callbacks = moduleCallbacks.current;
        if (!callbacks) {
          throw new Error(
            `require('${path}'): script modules are not available in this engine`,
          );
        }
        return callbacks.readModule(path);
      });
      control = runChunkSync(engine, '=[hearth sandbox]', SANDBOX_CHUNK) as SandboxControl;
      if (
        typeof control?.run !== 'function' ||
        typeof control?.invalidate !== 'function' ||
        typeof control?.set_require_enabled !== 'function'
      ) {
        throw new Error('Lua sandbox did not yield its module control table');
      }
      if (moduleCallbacks.current) control.set_require_enabled(true);
    } catch (err) {
      engine.global.close();
      throw err;
    }
    return new LuaScriptEngine(engine, control, moduleCallbacks);
  }

  /**
   * (Re)bind the host callbacks behind `require`. Safe to call repeatedly;
   * each call replaces both callbacks atomically and (first time) installs
   * the sandbox's require shim. GameSession shares one engine across every
   * scene of a session while module resolution must close over the
   * PER-SCENE registry — so every SceneRuntime.loadScripts rebinds the
   * engine it was handed to its own registry. The Lua-side module memo is
   * intentionally untouched here; loadScripts invalidates the paths it is
   * (re)loading so bodies re-run against the new registry.
   */
  setModuleResolver(callbacks: LuaModuleCallbacks): void {
    if (this.disposed) {
      throw new Error('cannot bind module callbacks: Lua engine has been disposed');
    }
    const firstBind = this.moduleCallbacks.current === null;
    this.moduleCallbacks.current = callbacks;
    if (firstBind) this.control.set_require_enabled(true);
  }

  /**
   * Run a module body through the sandbox's single memoized execution path
   * and return the chunk's returned value. `source` must be supplied on the
   * first run of a path (compile()'s case); require()-driven runs fetch it
   * via opts.readModule. Wraps errors so the message carries a script path.
   */
  private runModule(path: string, source?: string): unknown {
    try {
      // Two arities on purpose: wasmoon has no lossless push for undefined.
      return source === undefined ? this.control.run(path) : this.control.run(path, source);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Lua errors already read "scripts/foo.lua:LINE: message" thanks to
      // the chunk name (a required library's error names the LIBRARY's
      // path); only prefix this path when none is present.
      throw new Error(message.includes(path) ? message : `${path}: ${message}`);
    }
  }

  /**
   * Compile a Lua script (must `return` a table of hook functions) into the
   * same ScriptHooks shape JS scripts produce. Hook calls are synchronous;
   * hook errors surface as JS exceptions whose message carries
   * "path:LINE". Throws on syntax/eval failure or a non-table return.
   */
  compile(path: string, source: string): ScriptHooks {
    if (this.disposed) {
      throw new Error(`cannot compile ${path}: Lua engine has been disposed`);
    }
    const exported = this.runModule(path, source);
    if (exported === null || exported === undefined || typeof exported !== 'object') {
      throw new Error(
        `${path}: Lua script must \`return\` a table of lifecycle hooks ` +
          `(onStart/onUpdate/onCollision/onUiEvent/onEvent); got ${describeLuaValue(exported)}`
      );
    }
    const table = exported as Record<string, unknown>;
    const pick = (name: string): LuaFunction | undefined =>
      typeof table[name] === 'function' ? (table[name] as LuaFunction) : undefined;

    const onStart = pick('onStart');
    const onUpdate = pick('onUpdate');
    const onCollision = pick('onCollision');
    const onUiEvent = pick('onUiEvent');
    const onEvent = pick('onEvent');

    const hooks: ScriptHooks = {};
    if (onStart) hooks.onStart = (ctx: ScriptContext): void => void onStart(ctx);
    if (onUpdate) hooks.onUpdate = (ctx: ScriptContext, dt: number): void => void onUpdate(ctx, dt);
    if (onCollision) {
      hooks.onCollision = (ctx: ScriptContext, other: EntityHandle): void =>
        void onCollision(ctx, other);
    }
    if (onUiEvent) {
      hooks.onUiEvent = (ctx: ScriptContext, event: UiEvent): void => void onUiEvent(ctx, event);
    }
    if (onEvent) {
      hooks.onEvent = (ctx: ScriptContext, name: string, data: unknown): void =>
        void onEvent(ctx, name, data);
    }
    return hooks;
  }

  /**
   * Run a module by path (source fetched via opts.readModule) and return its
   * value, memoized like every other module body. The value crosses to JS by
   * wasmoon's usual conversion; scripts requiring the same path still get
   * the original Lua table.
   */
  requireModule(path: string): unknown {
    if (this.disposed) {
      throw new Error(`cannot require ${path}: Lua engine has been disposed`);
    }
    return this.runModule(path);
  }

  /**
   * Drop the memoized value for a path so its next compile()/require runs
   * the (presumably edited) body again. Hot reload calls this for an edited
   * module and each transitive dependent before recompiling them.
   */
  invalidateModule(path: string): void {
    if (this.disposed) return;
    this.control.invalidate(path);
  }

  /**
   * Close the wasmoon VM. Every hook previously produced by compile()
   * becomes inert (wasmoon guards calls into a closed state); Lua function
   * references are reclaimed with the state, so no per-hook unref is needed.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.global.close();
  }
}
