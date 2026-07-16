/**
 * Lua `require`: the sandbox-side module shim. A required module's table
 * stays inside Lua (no userdata round-trip), its body runs exactly once per
 * path no matter how it is reached (eager compile or require), required
 * modules see the same sandboxed globals as scripts, transitive requires
 * work, cycles error, and a throw inside a library carries the LIBRARY's
 * path:LINE.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { LuaScriptEngine, type LuaEngineOptions } from '../src/lua.js';
import type { ScriptContext } from '../src/scripts.js';

const engines: LuaScriptEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

async function makeEngine(
  modules: Record<string, string>,
  reads: string[] = []
): Promise<LuaScriptEngine> {
  const opts: LuaEngineOptions = {
    random: () => 0.5,
    log: () => {},
    resolveModule: (spec: string) => `scripts/${spec}.lua`,
    readModule: (path: string) => {
      reads.push(path);
      const source = modules[path];
      if (source === undefined) throw new Error(`no module source for ${path}`);
      return source;
    },
  };
  const engine = await LuaScriptEngine.create(opts);
  engines.push(engine);
  return engine;
}

function loggingCtx(logged: unknown[]): ScriptContext {
  return { log: (...args: unknown[]) => logged.push(...args) } as unknown as ScriptContext;
}

describe('Lua require', () => {
  it('returns a required module table and runs its body once across requirers', async () => {
    const reads: string[] = [];
    const engine = await makeEngine(
      { 'scripts/lib/math.lua': 'return { two = function() return 2 end }' },
      reads
    );
    const hooks = engine.compile(
      'scripts/player.lua',
      `local m = require('lib/math')
       return { onStart = function(ctx) ctx.log(m.two()) end }`
    );
    const logged: unknown[] = [];
    hooks.onStart?.(loggingCtx(logged));
    expect(logged).toEqual([2]);

    engine.compile('scripts/other.lua', `local m = require('lib/math') return {}`);
    expect(reads).toEqual(['scripts/lib/math.lua']);
  });

  it('runs the body once when a library is eagerly compiled AND required', async () => {
    const librarySource = `bodies = (bodies or 0) + 1
return { count = function() return bodies end }`;
    const reads: string[] = [];
    const engine = await makeEngine({ 'scripts/lib/counter.lua': librarySource }, reads);
    // Eager compile first, exactly like loadScripts() compiling every script
    // it finds; the library source arrives from JS, keyed by the same path.
    const libHooks = engine.compile('scripts/lib/counter.lua', librarySource);
    expect(libHooks).toEqual({}); // hookless table compiles to empty hooks
    const hooks = engine.compile(
      'scripts/player.lua',
      `local c = require('lib/counter')
       return { onStart = function(ctx) ctx.log(c.count()) end }`
    );
    const logged: unknown[] = [];
    hooks.onStart?.(loggingCtx(logged));
    expect(logged).toEqual([1]); // body ran exactly once, during the eager compile
    expect(reads).toEqual([]); // require was served from the memo, not readModule
  });

  it('a required module cannot reach the sandboxed globals', async () => {
    const engine = await makeEngine({
      'scripts/lib/bad.lua':
        'return { probe = function() return io == nil and os == nil and load == nil and dofile == nil end }',
    });
    const hooks = engine.compile(
      'scripts/p.lua',
      `local m = require('lib/bad') return { onStart = function(ctx) ctx.log(m.probe()) end }`
    );
    const logged: unknown[] = [];
    hooks.onStart?.(loggingCtx(logged));
    expect(logged).toEqual([true]);
  });

  it('resolves transitive requires and memoizes each module', async () => {
    const reads: string[] = [];
    const engine = await makeEngine(
      {
        'scripts/lib/a.lua': `local b = require('lib/b')
           return { ten = function() return b.five() * 2 end }`,
        'scripts/lib/b.lua': 'return { five = function() return 5 end }',
      },
      reads
    );
    const hooks = engine.compile(
      'scripts/player.lua',
      `local a = require('lib/a')
       local b = require('lib/b')
       return { onStart = function(ctx) ctx.log(a.ten() + b.five()) end }`
    );
    const logged: unknown[] = [];
    hooks.onStart?.(loggingCtx(logged));
    expect(logged).toEqual([15]);
    expect(reads.sort()).toEqual(['scripts/lib/a.lua', 'scripts/lib/b.lua']);
  });

  it('passes the requiring script path to resolveModule', async () => {
    const froms: Array<[string, string]> = [];
    const opts: LuaEngineOptions = {
      random: () => 0.5,
      log: () => {},
      resolveModule: (spec: string, fromPath: string) => {
        froms.push([spec, fromPath]);
        return `scripts/${spec}.lua`;
      },
      readModule: (path: string) =>
        path === 'scripts/lib/a.lua' ? `require('lib/b') return {}` : 'return {}',
    };
    const engine = await LuaScriptEngine.create(opts);
    engines.push(engine);
    engine.compile('scripts/player.lua', `require('lib/a') return {}`);
    expect(froms).toEqual([
      ['lib/a', 'scripts/player.lua'],
      ['lib/b', 'scripts/lib/a.lua'],
    ]);
  });

  it('an error thrown in a library body names the LIBRARY path and line', async () => {
    const engine = await makeEngine({
      'scripts/lib/boom.lua': `local x = 1
error('boom')
return {}`,
    });
    expect(() =>
      engine.compile('scripts/player.lua', `local m = require('lib/boom') return {}`)
    ).toThrow(/scripts\/lib\/boom\.lua:2/);
  });

  it('a cyclic require errors naming the cycle instead of hanging', async () => {
    const engine = await makeEngine({
      'scripts/lib/a.lua': `require('lib/b') return {}`,
      'scripts/lib/b.lua': `require('lib/a') return {}`,
    });
    expect(() =>
      engine.compile('scripts/player.lua', `require('lib/a') return {}`)
    ).toThrow(/scripts\/lib\/a\.lua.*scripts\/lib\/b\.lua.*scripts\/lib\/a\.lua/s);
  });

  it('require errors clearly when the engine has no module callbacks', async () => {
    const engine = await LuaScriptEngine.create({
      random: () => 0.5,
      log: () => {},
    });
    engines.push(engine);
    expect(() => engine.compile('scripts/p.lua', `require('lib/x') return {}`)).toThrow(
      /require/
    );
  });

  it('recompiling a path with CHANGED source re-runs the body (hot reload); a broken edit keeps the old module', async () => {
    const engine = await makeEngine({});
    engine.compile('scripts/lib/v.lua', 'return { n = function() return 1 end }');
    // A broken edit must fail loudly AND leave the previous module in place.
    expect(() => engine.compile('scripts/lib/v.lua', 'local = oops')).toThrow(
      /scripts\/lib\/v\.lua:1/
    );
    expect(engine.requireModule('scripts/lib/v.lua')).toMatchObject({ n: expect.any(Function) });
    // A good edit replaces it.
    engine.compile('scripts/lib/v.lua', 'return { n = function() return 2 end }');
    const hooks = engine.compile(
      'scripts/player.lua',
      `local v = require('lib/v')
       return { onStart = function(ctx) ctx.log(v.n()) end }`
    );
    const logged: unknown[] = [];
    hooks.onStart?.(loggingCtx(logged));
    expect(logged).toEqual([2]);
  });

  it('invalidateModule drops the memo so the next compile re-runs the body', async () => {
    const engine = await makeEngine({});
    engine.compile('scripts/lib/v.lua', 'return { n = function() return 1 end }');
    engine.invalidateModule('scripts/lib/v.lua');
    engine.compile('scripts/lib/v.lua', 'return { n = function() return 2 end }');
    const hooks = engine.compile(
      'scripts/player.lua',
      `local v = require('lib/v')
       return { onStart = function(ctx) ctx.log(v.n()) end }`
    );
    const logged: unknown[] = [];
    hooks.onStart?.(loggingCtx(logged));
    expect(logged).toEqual([2]);
  });

  it("rejects assignment to the require global — one script must not hijack another's require", async () => {
    const engine = await makeEngine({
      'scripts/lib/m.lua': 'return { two = function() return 2 end }',
    });
    // Sorts before zz-player.lua, so in a real project it would compile first.
    expect(() =>
      engine.compile(
        'scripts/aa-evil.lua',
        `require = function() return { two = function() return 999 end } end
return {}`
      )
    ).toThrow(/scripts\/aa-evil\.lua:1.*require/s);
    // A later script's require still resolves through the real shim.
    const hooks = engine.compile(
      'scripts/zz-player.lua',
      `local m = require('lib/m')
       return { onStart = function(ctx) ctx.log(m.two()) end }`
    );
    const logged: unknown[] = [];
    hooks.onStart?.(loggingCtx(logged));
    expect(logged).toEqual([2]);
  });

  it('reading require into a local and writing ordinary globals both still work', async () => {
    const engine = await makeEngine({
      'scripts/lib/m.lua': 'return { two = function() return 2 end }',
    });
    // `local require = require` shadows within one chunk — allowed — and
    // ordinary global writes (pre-existing cross-script sharing) still land.
    const hooks = engine.compile(
      'scripts/a.lua',
      `local require = require
       local m = require('lib/m')
       SHARED = 42
       return { onStart = function(ctx) ctx.log(m.two()) end }`
    );
    const logged: unknown[] = [];
    hooks.onStart?.(loggingCtx(logged));
    const probe = engine.compile(
      'scripts/b.lua',
      `return { onStart = function(ctx) ctx.log(SHARED) end }`
    );
    probe.onStart?.(loggingCtx(logged));
    expect(logged).toEqual([2, 42]);
  });

  it('user scripts cannot recover load through require internals', async () => {
    const engine = await makeEngine({});
    const hooks = engine.compile(
      'scripts/probe.lua',
      `return { onStart = function(ctx)
         ctx.log(type(require), load == nil, debug == nil, package == nil)
       end }`
    );
    const logged: unknown[] = [];
    hooks.onStart?.(loggingCtx(logged));
    expect(logged).toEqual(['function', true, true, true]);
  });
});
