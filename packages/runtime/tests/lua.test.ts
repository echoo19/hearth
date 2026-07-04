/**
 * Lua script engine: sync compile + hook calls through wasmoon, live-proxy
 * ctx marshaling (nested reads/writes, JS function calls), the sandbox
 * (nil'd stdlib, print -> log, seeded math.random), error reporting with
 * script path + line, and engine lifecycle.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { isLuaPath, setLuaWasmUri, LuaScriptEngine } from '../src/lua.js';
import { createCtxMath } from '../src/ctxMath.js';
import type { ScriptContext, EntityHandle, UiEvent } from '../src/scripts.js';

type LogEntry = { level: 'info' | 'warn'; message: string };

/** mulberry32 — deterministic stream for tests (mirrors what sessions use). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const engines: LuaScriptEngine[] = [];

async function makeEngine(seed = 1) {
  const logs: LogEntry[] = [];
  const engine = await LuaScriptEngine.create({
    random: mulberry32(seed),
    log: (level, message) => logs.push({ level, message }),
  });
  engines.push(engine);
  return { engine, logs };
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

/** Loose stub ctx; hooks only touch what each test wires up. */
function stubCtx(extra: Record<string, unknown> = {}): ScriptContext {
  const logArgs: unknown[][] = [];
  const ctx = {
    entity: { id: 'e1', name: 'Player', tags: ['hero'] },
    transform: {
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: { x: 1, y: 1 },
    },
    vars: {} as Record<string, unknown>,
    log: (...args: unknown[]) => logArgs.push(args),
    logArgs,
    ...extra,
  };
  return ctx as unknown as ScriptContext;
}

describe('isLuaPath', () => {
  it('matches only .lua paths', () => {
    expect(isLuaPath('scripts/foo.lua')).toBe(true);
    expect(isLuaPath('scripts/foo.js')).toBe(false);
    expect(isLuaPath('scripts/foo.lua.js')).toBe(false);
  });
});

describe('compile and hooks', () => {
  it('exposes all four hooks and calls them synchronously', async () => {
    const { engine } = await makeEngine();
    const hooks = engine.compile(
      'scripts/all.lua',
      `
      local script = {}
      function script.onStart(ctx) ctx.log("start") end
      function script.onUpdate(ctx, dt) ctx.log("update", dt) end
      function script.onCollision(ctx, other) ctx.log("collision", other.name) end
      function script.onUiEvent(ctx, event) ctx.log("ui", event.type, event.x, event.y) end
      return script
      `
    );
    expect(hooks.onStart).toBeTypeOf('function');
    expect(hooks.onUpdate).toBeTypeOf('function');
    expect(hooks.onCollision).toBeTypeOf('function');
    expect(hooks.onUiEvent).toBeTypeOf('function');

    const ctx = stubCtx();
    hooks.onStart!(ctx);
    hooks.onUpdate!(ctx, 0.25);
    hooks.onCollision!(ctx, { name: 'Spike' } as unknown as EntityHandle);
    hooks.onUiEvent!(ctx, { type: 'click', x: 10, y: 20 } as UiEvent);

    const logArgs = (ctx as unknown as { logArgs: unknown[][] }).logArgs;
    expect(logArgs).toEqual([
      ['start'],
      ['update', 0.25],
      ['collision', 'Spike'],
      ['ui', 'click', 10, 20],
    ]);
  });

  it('omits hooks the script does not define', async () => {
    const { engine } = await makeEngine();
    const hooks = engine.compile(
      'scripts/partial.lua',
      `
      local script = {}
      function script.onUpdate(ctx, dt) end
      return script
      `
    );
    expect(hooks.onUpdate).toBeTypeOf('function');
    expect(hooks.onStart).toBeUndefined();
    expect(hooks.onCollision).toBeUndefined();
    expect(hooks.onUiEvent).toBeUndefined();
  });
});

describe('ctx marshaling (live JS object proxy)', () => {
  it('reads and writes nested properties on the live ctx object', async () => {
    const { engine } = await makeEngine();
    const hooks = engine.compile(
      'scripts/mover.lua',
      `
      local script = {}
      function script.onUpdate(ctx, dt)
        ctx.transform.position.x = ctx.transform.position.x + dt * 10
        ctx.transform.rotation = 90
        ctx.vars.mode = "runner"
      end
      return script
      `
    );
    const ctx = stubCtx();
    hooks.onUpdate!(ctx, 0.5);
    expect(ctx.transform.position.x).toBe(5);
    expect(ctx.transform.rotation).toBe(90);
    expect(ctx.vars.mode).toBe('runner');
    // Second call sees the mutation from the first — same live object.
    hooks.onUpdate!(ctx, 0.5);
    expect(ctx.transform.position.x).toBe(10);
  });

  it('calls nested JS functions with dot syntax and round-trips values', async () => {
    const { engine } = await makeEngine();
    const loadCalls: string[] = [];
    const player = { name: 'Player', transform: { position: { x: 3, y: 7 } } };
    const ctx = stubCtx({
      scenes: {
        current: { id: 's1', name: 'Menu' },
        load: (idOrName: string) => {
          loadCalls.push(idOrName);
          return idOrName === 'Level';
        },
      },
      scene: {
        find: (idOrName: string) => (idOrName === 'Player' ? player : null),
      },
    });
    const hooks = engine.compile(
      'scripts/menu.lua',
      `
      local script = {}
      function script.onStart(ctx)
        ctx.log("current", ctx.scenes.current.name)
        ctx.log("ok", ctx.scenes.load("Level"))
        ctx.log("bad", ctx.scenes.load("Nowhere"))
        local found = ctx.scene.find("Player")
        ctx.log("found", found.name, found.transform.position.y)
      end
      return script
      `
    );
    hooks.onStart!(ctx);
    expect(loadCalls).toEqual(['Level', 'Nowhere']);
    const logArgs = (ctx as unknown as { logArgs: unknown[][] }).logArgs;
    expect(logArgs).toEqual([
      ['current', 'Menu'],
      ['ok', true],
      ['bad', false],
      ['found', 'Player', 7],
    ]);
  });

  it('indexes JS arrays 1-based from Lua (wasmoon proxy convention)', async () => {
    const { engine } = await makeEngine();
    const hooks = engine.compile(
      'scripts/tags.lua',
      `
      local script = {}
      function script.onCollision(ctx, other)
        ctx.log(other.name, other.tags[1], #other.tags)
      end
      return script
      `
    );
    const ctx = stubCtx();
    const other = { name: 'Spike', tags: ['hazard', 'metal'] } as unknown as EntityHandle;
    hooks.onCollision!(ctx, other);
    const logArgs = (ctx as unknown as { logArgs: unknown[][] }).logArgs;
    expect(logArgs).toEqual([['Spike', 'hazard', 2]]);
  });

  it('converts Lua tables passed into JS functions to plain objects', async () => {
    const { engine } = await makeEngine();
    const spawned: unknown[] = [];
    const ctx = stubCtx({
      scene: { spawn: (def: unknown) => spawned.push(def) },
    });
    const hooks = engine.compile(
      'scripts/spawner.lua',
      `
      local script = {}
      function script.onStart(ctx)
        ctx.scene.spawn({ name = "Coin", position = { x = 4, y = 8 }, tags = { "pickup" } })
      end
      return script
      `
    );
    hooks.onStart!(ctx);
    expect(spawned).toEqual([{ name: 'Coin', position: { x: 4, y: 8 }, tags: ['pickup'] }]);
  });
});

describe('sandbox', () => {
  it('nils out os/io/package/require/dofile/load/loadstring/debug/collectgarbage', async () => {
    const { engine } = await makeEngine();
    const reported: unknown[] = [];
    const ctx = stubCtx({ report: (t: unknown) => reported.push(t) });
    const hooks = engine.compile(
      'scripts/probe.lua',
      `
      local script = {}
      function script.onStart(ctx)
        ctx.report({
          os = os == nil,
          io = io == nil,
          package = package == nil,
          require = require == nil,
          dofile = dofile == nil,
          load = load == nil,
          loadstring = loadstring == nil,
          debug = debug == nil,
          collectgarbage = collectgarbage == nil,
        })
      end
      return script
      `
    );
    hooks.onStart!(ctx);
    expect(reported).toEqual([
      {
        os: true,
        io: true,
        package: true,
        require: true,
        dofile: true,
        load: true,
        loadstring: true,
        debug: true,
        collectgarbage: true,
      },
    ]);
  });

  it('routes print(...) to opts.log as info, tab-joined and tostring-ed', async () => {
    const { engine, logs } = await makeEngine();
    const hooks = engine.compile(
      'scripts/printer.lua',
      `
      local script = {}
      function script.onStart(ctx)
        print("hello", 42, true, nil)
      end
      return script
      `
    );
    hooks.onStart!(stubCtx());
    expect(logs).toEqual([{ level: 'info', message: 'hello\t42\ttrue\tnil' }]);
  });

  it('leaves the rest of math intact', async () => {
    const { engine } = await makeEngine();
    const ctx = stubCtx();
    const hooks = engine.compile(
      'scripts/mathy.lua',
      `
      local script = {}
      function script.onStart(ctx)
        ctx.log(math.floor(2.7), math.max(1, 9), math.pi > 3.14)
      end
      return script
      `
    );
    hooks.onStart!(ctx);
    const logArgs = (ctx as unknown as { logArgs: unknown[][] }).logArgs;
    expect(logArgs).toEqual([[2, 9, true]]);
  });
});

describe('math.random determinism', () => {
  const SAMPLER = `
    local script = {}
    function script.onUpdate(ctx, dt)
      ctx.push(math.random(), math.random(10), math.random(1, 6))
    end
    return script
  `;

  it('two engines with identically seeded streams produce identical sequences', async () => {
    const a = await makeEngine(1234);
    const b = await makeEngine(1234);
    const collect = (engine: LuaScriptEngine): unknown[][] => {
      const rows: unknown[][] = [];
      const ctx = stubCtx({ push: (...args: unknown[]) => rows.push(args) });
      const hooks = engine.compile('scripts/sampler.lua', SAMPLER);
      for (let i = 0; i < 50; i++) hooks.onUpdate!(ctx, 1 / 60);
      return rows;
    };
    const rowsA = collect(a.engine);
    const rowsB = collect(b.engine);
    expect(rowsA).toEqual(rowsB);
    // And a differently seeded stream diverges.
    const c = await makeEngine(999);
    expect(collect(c.engine)).not.toEqual(rowsA);
  });

  it('math.random(1, 6) yields Lua integers in [1, 6] inclusive', async () => {
    const { engine } = await makeEngine(42);
    const rows: unknown[][] = [];
    const ctx = stubCtx({ push: (...args: unknown[]) => rows.push(args) });
    const hooks = engine.compile(
      'scripts/dice.lua',
      `
      local script = {}
      function script.onUpdate(ctx, dt)
        local v = math.random(1, 6)
        ctx.push(v, math.type(v))
      end
      return script
      `
    );
    for (let i = 0; i < 200; i++) hooks.onUpdate!(ctx, 1 / 60);
    for (const [v, luaType] of rows) {
      expect(luaType).toBe('integer');
      expect(Number.isInteger(v)).toBe(true);
      expect(v as number).toBeGreaterThanOrEqual(1);
      expect(v as number).toBeLessThanOrEqual(6);
    }
    // A fair rng over 200 rolls hits both endpoints.
    const values = rows.map((r) => r[0]);
    expect(values).toContain(1);
    expect(values).toContain(6);
  });

  it('math.random() stays in [0, 1) and math.random(m) in [1, m]', async () => {
    const { engine } = await makeEngine(7);
    const rows: unknown[][] = [];
    const ctx = stubCtx({ push: (...args: unknown[]) => rows.push(args) });
    const hooks = engine.compile(
      'scripts/ranges.lua',
      `
      local script = {}
      function script.onUpdate(ctx, dt)
        ctx.push(math.random(), math.random(3))
      end
      return script
      `
    );
    for (let i = 0; i < 100; i++) hooks.onUpdate!(ctx, 1 / 60);
    for (const [f, m] of rows as [number, number][]) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(3);
    }
  });

  it('math.randomseed is a no-op that warns exactly once', async () => {
    const { engine, logs } = await makeEngine();
    const hooks = engine.compile(
      'scripts/seeder.lua',
      `
      local script = {}
      function script.onStart(ctx)
        math.randomseed(123)
        math.randomseed(456)
      end
      return script
      `
    );
    hooks.onStart!(stubCtx());
    const warns = logs.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toMatch(/math\.randomseed/);
  });
});

describe('errors', () => {
  it('throws on syntax errors with the script path and line', async () => {
    const { engine } = await makeEngine();
    const source = ['local script = {}', 'function script.onStart(ctx)', '  local = 5', 'end'].join(
      '\n'
    );
    expect(() => engine.compile('scripts/broken.lua', source)).toThrowError(
      /scripts\/broken\.lua:3/
    );
  });

  it('throws when the chunk errors while evaluating, with path and line', async () => {
    const { engine } = await makeEngine();
    const source = ['local script = {}', 'error("boom during load")', 'return script'].join('\n');
    expect(() => engine.compile('scripts/explode.lua', source)).toThrowError(
      /scripts\/explode\.lua:2.*boom during load/
    );
  });

  it('throws a clear error when the script does not return a table', async () => {
    const { engine } = await makeEngine();
    expect(() => engine.compile('scripts/number.lua', 'return 42')).toThrowError(
      /scripts\/number\.lua.*return.*table/
    );
    expect(() => engine.compile('scripts/nothing.lua', 'local x = 1')).toThrowError(
      /scripts\/nothing\.lua.*return.*table/
    );
  });

  it('propagates hook runtime errors as JS exceptions with path and line', async () => {
    const { engine } = await makeEngine();
    const hooks = engine.compile(
      'scripts/angry.lua',
      ['local script = {}', 'function script.onUpdate(ctx, dt)', '  error("kaboom")', 'end', 'return script'].join(
        '\n'
      )
    );
    expect(() => hooks.onUpdate!(stubCtx(), 1 / 60)).toThrowError(/scripts\/angry\.lua:3.*kaboom/);
  });
});

describe('engine lifecycle and behavior over time', () => {
  const COUNTER = `
    local count = 0
    local script = {}
    function script.onStart(ctx)
      count = 0
    end
    function script.onUpdate(ctx, dt)
      count = count + 1
      ctx.vars.count = count
    end
    return script
  `;

  it('keeps a local upvalue counter across many onUpdate calls', async () => {
    const { engine } = await makeEngine();
    const hooks = engine.compile('scripts/counter.lua', COUNTER);
    const ctx = stubCtx();
    hooks.onStart!(ctx);
    for (let i = 0; i < 100; i++) hooks.onUpdate!(ctx, 1 / 60);
    expect(ctx.vars.count).toBe(100);
  });

  it('hosts many chunks on one engine with independent upvalues', async () => {
    const { engine } = await makeEngine();
    const a = engine.compile('scripts/counter-a.lua', COUNTER);
    const b = engine.compile('scripts/counter-b.lua', COUNTER);
    const ctxA = stubCtx();
    const ctxB = stubCtx();
    for (let i = 0; i < 5; i++) a.onUpdate!(ctxA, 1 / 60);
    b.onUpdate!(ctxB, 1 / 60);
    expect(ctxA.vars.count).toBe(5);
    expect(ctxB.vars.count).toBe(1);
  });

  it('refuses to compile after dispose', async () => {
    const { engine } = await makeEngine();
    engine.dispose();
    engine.dispose(); // idempotent
    expect(() => engine.compile('scripts/late.lua', 'return {}')).toThrowError(/disposed/);
  });
});

describe('null marshaling', () => {
  it('JS null return values and properties reach Lua as nil', async () => {
    const { engine } = await makeEngine();
    const hooks = engine.compile(
      'scripts/nulls.lua',
      `
      local script = {}
      function script.onStart(ctx)
        -- function returning null (ctx.load miss, ctx.scene.find miss, ...)
        local missing = ctx.load("nope")
        ctx.vars.loadIsNil = missing == nil
        ctx.vars.bestOrZero = (ctx.load("nope") or 0) + 1
        -- null property read through the proxy
        ctx.vars.propIsNil = ctx.holder.nothing == nil
      end
      return script
      `
    );
    const ctx = stubCtx({
      load: () => null,
      holder: { nothing: null },
    });
    hooks.onStart!(ctx);
    expect((ctx as unknown as { vars: Record<string, unknown> }).vars).toEqual({
      loadIsNil: true,
      bestOrZero: 1,
      propIsNil: true,
    });
  });
});

describe('ctx.math (Lua round-trip)', () => {
  it('provides math helpers through ctx.math', async () => {
    const { engine } = await makeEngine();
    const ctx = stubCtx({ math: createCtxMath(() => {}) });
    const hooks = engine.compile(
      'scripts/math.lua',
      `
      local script = {}
      function script.onStart(ctx)
        local v = ctx.math.normalize(ctx.math.vec2(3, 4))
        ctx.log(v.x, v.y, ctx.math.colorLerp("#000000", "#ffffff", 0.5))
      end
      return script
      `
    );
    hooks.onStart!(ctx);
    const logArgs = (ctx as unknown as { logArgs: unknown[][] }).logArgs;
    expect(logArgs).toHaveLength(1);
    expect(logArgs[0][0]).toBeCloseTo(0.6);
    expect(logArgs[0][1]).toBeCloseTo(0.8);
    expect(logArgs[0][2]).toBe('#808080');
  });
});

describe('setLuaWasmUri', () => {
  // Runs last: the override is module-level state. We point it at the real
  // glue.wasm path, which is what a bundler would do with a data: URI.
  it('creates engines from an explicitly provided wasm location', async () => {
    const require = createRequire(import.meta.url);
    setLuaWasmUri(require.resolve('wasmoon/dist/glue.wasm'));
    const { engine, logs } = await makeEngine();
    const hooks = engine.compile(
      'scripts/hello.lua',
      `
      local script = {}
      function script.onStart(ctx) print("from explicit wasm") end
      return script
      `
    );
    hooks.onStart!(stubCtx());
    expect(logs).toEqual([{ level: 'info', message: 'from explicit wasm' }]);
  });
});
