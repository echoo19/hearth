/**
 * Hot-reload invalidation across the require graph: editing a library
 * recompiles every transitive dependent (in BOTH languages), a compile
 * failure anywhere leaves the ENTIRE prior module graph running (no
 * half-swapped graph), a require removed by an edit drops its dependents
 * edge, and the v0.11 hot-reload contract survives intact for dependents —
 * ctx.vars/timers survive, onStart does not re-run, an error-disabled
 * script re-enables.
 */
import { describe, expect, it } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { ent, makeStore } from './helpers.js';

function scripted(name: string, scriptPath: string) {
  return ent(name, { Transform: {}, Script: { scriptPath } });
}

const luaLines = (...lines: string[]) => lines.join('\n');

const LUA_LIB_2 = 'return { two = function() return 2 end }';
const LUA_LIB_3 = 'return { two = function() return 3 end }';
const LUA_PLAYER = luaLines(
  "local m = require('lib/math')",
  'return {',
  "  onStart = function(ctx) ctx.vars.n = 0 ctx.log('start') end,",
  '  onUpdate = function(ctx, dt)',
  '    ctx.vars.n = ctx.vars.n + 1',
  "    ctx.log(m.two() .. ':' .. ctx.vars.n)",
  '  end,',
  '}',
);

const JS_LIB_2 = 'export default { two() { return 2; } };';
const JS_LIB_3 = 'export default { two() { return 3; } };';
const JS_PLAYER = `const m = require('lib/math');
export default {
  onStart(ctx) { ctx.vars.n = 0; ctx.log('start'); },
  onUpdate(ctx) {
    ctx.vars.n += 1;
    ctx.log(m.two() + ':' + ctx.vars.n);
  },
};`;

describe('hot reload across the require graph — Lua', () => {
  it('editing a library recompiles its dependents; vars survive and onStart does not re-run', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.lua')],
      scripts: { 'lib/math.lua': LUA_LIB_2, 'player.lua': LUA_PLAYER },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(runtime.logs.map((l) => l.message)).toContain('2:1');

    const result = await runtime.reloadScript('scripts/lib/math.lua', LUA_LIB_3);
    expect(result).toEqual({ ok: true, entities: 1 });

    runtime.run(1);
    // New library value observed AND ctx.vars.n continued from 1 → the
    // dependent recompiled without losing state.
    expect(runtime.logs.map((l) => l.message)).toContain('3:2');
    // onStart did not re-run for the recompiled dependent.
    expect(runtime.logs.filter((l) => l.message === 'start')).toHaveLength(1);
    expect(runtime.errors).toEqual([]);
    runtime.destroy();
  });

  it('recompiles TRANSITIVE dependents (lib <- mid <- player)', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.lua')],
      scripts: {
        'lib/base.lua': LUA_LIB_2,
        'lib/mid.lua': luaLines(
          "local base = require('lib/base')",
          'return { four = function() return base.two() * 2 end }',
        ),
        'player.lua': luaLines(
          "local mid = require('lib/mid')",
          'return { onUpdate = function(ctx, dt) ctx.log(mid.four()) end }',
        ),
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.logs.map((l) => l.message)).toContain('4');

    const result = await runtime.reloadScript('scripts/lib/base.lua', LUA_LIB_3);
    expect(result).toEqual({ ok: true, entities: 1 });
    runtime.run(1);
    expect(runtime.logs.map((l) => l.message)).toContain('6');
    expect(runtime.errors).toEqual([]);
    runtime.destroy();
  });

  it('a library compile ERROR leaves the entire prior graph running', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.lua')],
      scripts: { 'lib/math.lua': LUA_LIB_2, 'player.lua': LUA_PLAYER },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);

    const result = await runtime.reloadScript('scripts/lib/math.lua', 'local = broken');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/lib\/math\.lua:1/);
      expect(result.line).toBe(1);
    }
    const last = runtime.errors[runtime.errors.length - 1];
    expect(last).toMatchObject({ phase: 'reload', script: 'scripts/lib/math.lua', line: 1 });

    // Player keeps running the OLD graph: still 2, vars still advancing.
    runtime.run(1);
    expect(runtime.logs.map((l) => l.message)).toContain('2:2');
    runtime.destroy();
  });

  it('a require REMOVED by an edit drops its dependents edge', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.lua')],
      scripts: { 'lib/math.lua': LUA_LIB_2, 'player.lua': LUA_PLAYER },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);

    // While player requires the lib, editing the lib re-points the player.
    expect(await runtime.reloadScript('scripts/lib/math.lua', LUA_LIB_3)).toEqual({
      ok: true,
      entities: 1,
    });

    // Drop the require from player.
    const noRequire = luaLines(
      'return { onUpdate = function(ctx, dt) ctx.log(7) end }',
    );
    expect(await runtime.reloadScript('scripts/player.lua', noRequire)).toEqual({
      ok: true,
      entities: 1,
    });

    // Editing the lib now re-points NOBODY — the stale edge is gone.
    expect(await runtime.reloadScript('scripts/lib/math.lua', LUA_LIB_2)).toEqual({
      ok: true,
      entities: 0,
    });
    runtime.run(1);
    expect(runtime.logs.map((l) => l.message)).toContain('7');
    expect(runtime.errors).toEqual([]);
    runtime.destroy();
  });
});

describe('hot reload across the require graph — JS', () => {
  it('editing a library recompiles its dependents; vars survive and onStart does not re-run', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.js')],
      scripts: { 'lib/math.js': JS_LIB_2, 'player.js': JS_PLAYER },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(runtime.logs.map((l) => l.message)).toContain('2:1');

    const result = await runtime.reloadScript('scripts/lib/math.js', JS_LIB_3);
    expect(result).toEqual({ ok: true, entities: 1 });

    runtime.run(1);
    expect(runtime.logs.map((l) => l.message)).toContain('3:2');
    expect(runtime.logs.filter((l) => l.message === 'start')).toHaveLength(1);
    expect(runtime.errors).toEqual([]);
    runtime.destroy();
  });

  it('a library compile ERROR leaves the entire prior graph running', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.js')],
      scripts: { 'lib/math.js': JS_LIB_2, 'player.js': JS_PLAYER },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);

    const result = await runtime.reloadScript('scripts/lib/math.js', 'export default {');
    expect(result.ok).toBe(false);
    const last = runtime.errors[runtime.errors.length - 1];
    expect(last).toMatchObject({ phase: 'reload', script: 'scripts/lib/math.js' });

    runtime.run(1);
    expect(runtime.logs.map((l) => l.message)).toContain('2:2');
    runtime.destroy();
  });

  it('an unaffected shared library keeps ONE live instance across a dependent reload', async () => {
    // Player requires counter (stateful) and math. Editing math recompiles
    // player — but counter must NOT re-run its body: A (untouched) and the
    // recompiled Player must still share the same counter instance.
    const { store } = await makeStore({
      entities: [scripted('A', 'scripts/a.js'), scripted('Player', 'scripts/player.js')],
      scripts: {
        'lib/counter.js': 'let n = 0; export default { next() { n += 1; return n; } };',
        'lib/math.js': JS_LIB_2,
        'a.js': `const c = require('lib/counter');
export default { onEvent(ctx, name) { if (name === 'tick') ctx.log('a=' + c.next()); } };`,
        'player.js': `const c = require('lib/counter');
const m = require('lib/math');
export default { onEvent(ctx, name) { if (name === 'tick') ctx.log('p=' + (c.next() + m.two())); } };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);

    const result = await runtime.reloadScript('scripts/lib/math.js', JS_LIB_3);
    expect(result).toEqual({ ok: true, entities: 1 });

    runtime.emitEvent('tick');
    runtime.run(1);
    // One shared counter: values 1 and 2 in entity order (A then Player),
    // with Player seeing the NEW math (2 + 3 = 5). If counter had been
    // recompiled, Player would restart it at 1 (logging 4).
    expect(runtime.logs.map((l) => l.message)).toEqual(
      expect.arrayContaining(['a=1', 'p=5']),
    );
    expect(runtime.errors).toEqual([]);
    runtime.destroy();
  });

  it('a require REMOVED by an edit drops its dependents edge', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.js')],
      scripts: { 'lib/math.js': JS_LIB_2, 'player.js': JS_PLAYER },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);

    expect(await runtime.reloadScript('scripts/lib/math.js', JS_LIB_3)).toEqual({
      ok: true,
      entities: 1,
    });
    expect(
      await runtime.reloadScript(
        'scripts/player.js',
        'export default { onUpdate(ctx) { ctx.log(7); } };',
      ),
    ).toEqual({ ok: true, entities: 1 });
    expect(await runtime.reloadScript('scripts/lib/math.js', JS_LIB_2)).toEqual({
      ok: true,
      entities: 0,
    });
    runtime.run(1);
    expect(runtime.logs.map((l) => l.message)).toContain('7');
    expect(runtime.errors).toEqual([]);
    runtime.destroy();
  });

  it('reloading a plain leaf behavior (no requires) behaves exactly as before', async () => {
    const { store } = await makeStore({
      entities: [scripted('Counter', 'scripts/counter.js')],
      scripts: {
        'counter.js': `export default {
          onStart(ctx) { ctx.log('started'); ctx.vars.n = 0; },
          onUpdate(ctx) { ctx.vars.n += 1; ctx.transform.position.x = ctx.vars.n; },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(3);
    expect(runtime.find('Counter')!.transform.position.x).toBe(3);

    const result = await runtime.reloadScript(
      'scripts/counter.js',
      `export default {
        onStart(ctx) { ctx.log('started'); ctx.vars.n = 999; },
        onUpdate(ctx) { ctx.vars.n += 10; ctx.transform.position.x = ctx.vars.n; },
      };`,
    );
    expect(result).toEqual({ ok: true, entities: 1 });
    runtime.run(1);
    expect(runtime.find('Counter')!.transform.position.x).toBe(13);
    expect(runtime.logs.filter((l) => l.message === 'started')).toHaveLength(1);
    runtime.destroy();
  });
});
