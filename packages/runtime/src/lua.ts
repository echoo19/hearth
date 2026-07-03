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
 * Sandbox: `os`, `io`, `package`, `require`, `dofile`, `load`,
 * `loadstring`, `debug` and `collectgarbage` are nil'd at engine creation.
 * `print(...)` routes to the host log sink; `math.random` is backed by the
 * host's seeded stream (Lua integer semantics preserved) and
 * `math.randomseed` is a warn-once no-op, so no wall clock or Math.random
 * can leak into game logic.
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

export interface LuaEngineOptions {
  /** Seeded stream backing Lua's math.random. */
  random(): number;
  /** Sink for Lua print() and engine-level warnings. */
  log(level: 'info' | 'warn', message: string): void;
}

/** A Lua function surfaced to JS by wasmoon; the call is synchronous. */
type LuaFunction = (...args: unknown[]) => unknown;

/**
 * Runs once per engine, right after creation, before any user chunk. The
 * host sinks (`__hearth_*` globals) are captured as locals and then removed
 * from the global table so scripts can never reach them directly.
 */
const SANDBOX_CHUNK = `
local print_sink = __hearth_print
local warn_sink = __hearth_warn
local next_random = __hearth_random
__hearth_print, __hearth_warn, __hearth_random = nil, nil, nil

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

export class LuaScriptEngine {
  private engine: LuaEngine;
  private disposed = false;

  private constructor(engine: LuaEngine) {
    this.engine = engine;
  }

  /** Boot a wasmoon VM, install the sandbox, and return a ready engine. */
  static async create(opts: LuaEngineOptions): Promise<LuaScriptEngine> {
    const factory = new LuaFactory(luaWasmUri);
    const engine = await factory.createEngine({
      openStandardLibs: true,
      injectObjects: false,
      enableProxy: true,
    });
    try {
      engine.global.registerTypeExtension(10, new NullToNilTypeExtension(engine.global));
      engine.global.set('__hearth_print', (message: string) => opts.log('info', message));
      engine.global.set('__hearth_warn', (message: string) => opts.log('warn', message));
      engine.global.set('__hearth_random', () => opts.random());
      runChunkSync(engine, '=[hearth sandbox]', SANDBOX_CHUNK);
    } catch (err) {
      engine.global.close();
      throw err;
    }
    return new LuaScriptEngine(engine);
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
    let exported: unknown;
    try {
      exported = runChunkSync(this.engine, `@${path}`, source);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Lua errors already read "scripts/foo.lua:LINE: message" thanks to
      // the chunk name; only prefix the path when it is missing.
      throw new Error(message.includes(path) ? message : `${path}: ${message}`);
    }
    if (exported === null || exported === undefined || typeof exported !== 'object') {
      throw new Error(
        `${path}: Lua script must \`return\` a table of lifecycle hooks ` +
          `(onStart/onUpdate/onCollision/onUiEvent); got ${describeLuaValue(exported)}`
      );
    }
    const table = exported as Record<string, unknown>;
    const pick = (name: string): LuaFunction | undefined =>
      typeof table[name] === 'function' ? (table[name] as LuaFunction) : undefined;

    const onStart = pick('onStart');
    const onUpdate = pick('onUpdate');
    const onCollision = pick('onCollision');
    const onUiEvent = pick('onUiEvent');

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
    return hooks;
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
