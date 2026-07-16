/**
 * Script modules through a real SceneRuntime (two-phase load): every source
 * is read up front (phase 1, async), hooks are obtained through the module
 * registry (phase 2, sync), and a library reached both eagerly (loadScripts
 * compiles every listed script) and by require runs its body exactly ONCE.
 * Also pins that a seeded run using a required helper hashes bit-identically
 * to the same logic inlined.
 */
import { describe, expect, it } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { runHash } from './determinism.js';
import { ent, makeStore } from './helpers.js';

function scripted(name: string, scriptPath: string) {
  return ent(name, { Transform: {}, Script: { scriptPath } });
}

const luaLines = (...lines: string[]) => lines.join('\n');

describe('script modules through SceneRuntime — Lua', () => {
  it('a behavior requires a library from scripts/lib/ and uses its value', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.lua')],
      scripts: {
        'lib/math.lua': 'return { two = function() return 2 end }',
        'player.lua': luaLines(
          "local m = require('lib/math')",
          'return { onStart = function(ctx) ctx.log(m.two()) end }',
        ),
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(runtime.logs.map((l) => l.message)).toContain('2');
    runtime.destroy();
  });

  it('a library reached both eagerly and by require runs its body exactly once', async () => {
    // print() at the library's top level routes to runtime.logs, so every
    // body execution is observable. listScripts() finds the library, so
    // loadScripts compiles it eagerly AND player requires it.
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.lua')],
      scripts: {
        'lib/counter.lua': luaLines(
          "print('lib body ran')",
          'return { n = function() return 1 end }',
        ),
        'player.lua': luaLines(
          "local c = require('lib/counter')",
          'return { onStart = function(ctx) ctx.log(c.n()) end }',
        ),
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(runtime.logs.filter((l) => l.message === 'lib body ran')).toHaveLength(1);
    expect(runtime.logs.map((l) => l.message)).toContain('1');
    runtime.destroy();
  });

  it('a require of a missing module records a load error naming the resolved path', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.lua'), scripted('Ok', 'scripts/ok.lua')],
      scripts: {
        'player.lua': luaLines("local m = require('lib/nope')", 'return {}'),
        'ok.lua': 'return { onStart = function(ctx) ctx.log("ok") end }',
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    const loadErrors = runtime.errors.filter((e) => e.phase === 'load');
    expect(loadErrors).toHaveLength(1);
    expect(loadErrors[0].script).toBe('scripts/player.lua');
    expect(loadErrors[0].message).toMatch(/lib\/nope/);
    // The healthy script keeps running — per-path failure isolation survives.
    expect(runtime.logs.map((l) => l.message)).toContain('ok');
    runtime.destroy();
  });
});

describe('script modules through SceneRuntime — JS', () => {
  it('a behavior requires a library from scripts/lib/ and uses its value', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.js')],
      scripts: {
        'lib/math.js': 'export default { two() { return 2; } };',
        'player.js': `const m = require('lib/math');
export default { onStart(ctx) { ctx.log(m.two()); } };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(runtime.logs.map((l) => l.message)).toContain('2');
    runtime.destroy();
  });

  it('two requirers share ONE module instance (body ran once)', async () => {
    // If the counter's body ran once, A and B share `n` and log 1 then 2.
    // If the library compiled twice (the determinism break the registry
    // exists to prevent), each requirer would get its own n and both log 1.
    const { store } = await makeStore({
      entities: [scripted('A', 'scripts/a.js'), scripted('B', 'scripts/b.js')],
      scripts: {
        'lib/counter.js': 'let n = 0; export default { next() { n += 1; return n; } };',
        'a.js': `const c = require('lib/counter');
export default { onStart(ctx) { ctx.log(c.next()); } };`,
        'b.js': `const c = require('lib/counter');
export default { onStart(ctx) { ctx.log(c.next()); } };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(runtime.logs.map((l) => l.message).sort()).toEqual(['1', '2']);
    runtime.destroy();
  });

  it('a compile failure in one script still loads the others (per-path isolation)', async () => {
    const { store } = await makeStore({
      entities: [scripted('Broken', 'scripts/broken.js'), scripted('Ok', 'scripts/ok.js')],
      scripts: {
        'broken.js': 'export default {',
        'ok.js': `export default { onStart(ctx) { ctx.log('ok'); } };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    const loadErrors = runtime.errors.filter((e) => e.phase === 'load');
    expect(loadErrors).toHaveLength(1);
    expect(loadErrors[0].script).toBe('scripts/broken.js');
    expect(loadErrors[0].message).toMatch(/Failed to load script scripts\/broken\.js/);
    expect(runtime.logs.map((l) => l.message)).toContain('ok');
    runtime.destroy();
  });
});

describe('script modules determinism', () => {
  const SEED = 424242;
  const FRAMES = 30;

  // The same seeded motion, once with the helper inlined and once required.
  const HELPER_BODY = `wave(t, r) {
    return Math.floor((t * 7 + r * 13) % 5) - 2;
  }`;

  it('a required helper hashes bit-identically to the inlined equivalent', async () => {
    const inlined = await makeStore({
      entities: [scripted('Mover', 'scripts/mover.js')],
      scripts: {
        'mover.js': `const lib = { ${HELPER_BODY} };
export default {
  onUpdate(ctx) {
    ctx.vars.t = (ctx.vars.t || 0) + 1;
    ctx.transform.position.x += lib.wave(ctx.vars.t, ctx.random.next());
    ctx.transform.position.y += lib.wave(ctx.vars.t * 3, ctx.random.next());
  },
};`,
      },
    });
    const required = await makeStore({
      entities: [scripted('Mover', 'scripts/mover.js')],
      scripts: {
        'lib/wave.js': `export default { ${HELPER_BODY} };`,
        'mover.js': `const lib = require('lib/wave');
export default {
  onUpdate(ctx) {
    ctx.vars.t = (ctx.vars.t || 0) + 1;
    ctx.transform.position.x += lib.wave(ctx.vars.t, ctx.random.next());
    ctx.transform.position.y += lib.wave(ctx.vars.t * 3, ctx.random.next());
  },
};`,
      },
    });
    const inlinedHash = await runHash(inlined.store, 'Test', FRAMES, SEED);
    const requiredHash = await runHash(required.store, 'Test', FRAMES, SEED);
    expect(requiredHash).toBe(inlinedHash);
    // And the required variant reproduces itself run-over-run.
    expect(await runHash(required.store, 'Test', FRAMES, SEED)).toBe(requiredHash);
  });
});
