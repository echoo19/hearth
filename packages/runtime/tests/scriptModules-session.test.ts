/**
 * Script modules through GameSession — the integration every real host uses
 * (exported player, playtests, editor preview all drive a GameSession, never
 * a bare SceneRuntime). GameSession creates ONE shared Lua engine per session
 * and hands it to every scene's SceneRuntime, so `require` must work on that
 * provided engine, not only on the engine SceneRuntime creates for itself —
 * and every scene load must rebind module resolution to THAT scene's
 * registry, or hot reload loses the dependents graph after a scene switch.
 */
import { describe, expect, it } from 'vitest';
import { GameSession } from '@hearth/runtime';
import { ent, makeStore } from './helpers.js';

function scripted(name: string, scriptPath: string) {
  return ent(name, { Transform: {}, Script: { scriptPath } });
}

const luaLines = (...lines: string[]) => lines.join('\n');
const messages = (logs: { message: string }[]) => logs.map((l) => l.message);

describe('script modules through GameSession — Lua', () => {
  it('a behavior requires a library and the required code actually executes', async () => {
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
    const session = await GameSession.create(store);
    await session.stepAsync();
    expect(session.errors).toEqual([]);
    expect(messages(session.logs)).toContain('2');
    session.destroy();
  });

  it('require keeps working in a scene entered via ctx.scenes.load (shared engine, second scene load)', async () => {
    const { store } = await makeStore({
      entities: [scripted('Menu', 'scripts/menu.lua')],
      scripts: {
        'lib/math.lua': 'return { two = function() return 2 end }',
        'menu.lua': luaLines(
          "local m = require('lib/math')",
          'return { onUpdate = function(ctx, dt)',
          '  if ctx.time.frame == 1 then ctx.scenes.load("Level") end',
          'end }',
        ),
        'hero.lua': luaLines(
          "local m = require('lib/math')",
          "return { onStart = function(ctx) ctx.log('hero:' .. m.two()) end }",
        ),
      },
      extraScenes: [
        {
          id: 'scn_level',
          name: 'Level',
          entities: [scripted('Hero', 'scripts/hero.lua')],
        },
      ],
    });
    const session = await GameSession.create(store);
    for (let i = 0; i < 4; i++) await session.stepAsync();
    expect(session.errors).toEqual([]);
    expect(session.currentSceneId).toBe('scn_level');
    expect(messages(session.logs)).toContain('hero:2');
    session.destroy();
  });

  it('hot-reloading a library AFTER a scene switch still recompiles the new scene\'s dependents', async () => {
    // The cross-scene dependents-graph trap: scene A's load runs player.lua's
    // body (its require records an edge into scene A's registry, then dies
    // with the scene). If scene B's load were a pure VM memo hit, its require
    // would never fire, scene B's registry would hold no edge, and editing
    // the library on scene B would recompile NOBODY — stale code, the exact
    // bug class hot-reload invalidation exists to prevent.
    const { store } = await makeStore({
      entities: [scripted('Menu', 'scripts/menu.lua')],
      scripts: {
        'lib/math.lua': 'return { two = function() return 2 end }',
        'menu.lua': luaLines(
          "local m = require('lib/math')",
          'return { onUpdate = function(ctx, dt)',
          '  if ctx.time.frame == 1 then ctx.scenes.load("Level") end',
          'end }',
        ),
        'hero.lua': luaLines(
          "local m = require('lib/math')",
          "return { onUpdate = function(ctx, dt) ctx.log('hero:' .. m.two()) end }",
        ),
      },
      extraScenes: [
        {
          id: 'scn_level',
          name: 'Level',
          entities: [scripted('Hero', 'scripts/hero.lua')],
        },
      ],
    });
    const session = await GameSession.create(store);
    for (let i = 0; i < 4; i++) await session.stepAsync();
    expect(session.errors).toEqual([]);
    expect(session.currentSceneId).toBe('scn_level');
    expect(messages(session.logs)).toContain('hero:2');

    const result = await session.runtime.reloadScript(
      'scripts/lib/math.lua',
      'return { two = function() return 3 end }',
    );
    expect(result).toEqual({ ok: true, entities: 1 });

    await session.stepAsync();
    expect(messages(session.logs)).toContain('hero:3');
    expect(session.errors).toEqual([]);
    session.destroy();
  });
});

describe('script modules through GameSession — JS', () => {
  it('a behavior requires a library and the required code actually executes', async () => {
    const { store } = await makeStore({
      entities: [scripted('Player', 'scripts/player.js')],
      scripts: {
        'lib/math.js': 'export default { two() { return 2; } };',
        'player.js': `const m = require('lib/math');
export default { onStart(ctx) { ctx.log(m.two()); } };`,
      },
    });
    const session = await GameSession.create(store);
    await session.stepAsync();
    expect(session.errors).toEqual([]);
    expect(messages(session.logs)).toContain('2');
    session.destroy();
  });

  it('hot-reloading a library after a scene switch recompiles the new scene\'s dependents', async () => {
    const { store } = await makeStore({
      entities: [scripted('Menu', 'scripts/menu.js')],
      scripts: {
        'lib/math.js': 'export default { two() { return 2; } };',
        'menu.js': `export default { onUpdate(ctx) {
  if (ctx.time.frame === 1) ctx.scenes.load('Level');
} };`,
        'hero.js': `const m = require('lib/math');
export default { onUpdate(ctx) { ctx.log('hero:' + m.two()); } };`,
      },
      extraScenes: [
        {
          id: 'scn_level',
          name: 'Level',
          entities: [scripted('Hero', 'scripts/hero.js')],
        },
      ],
    });
    const session = await GameSession.create(store);
    for (let i = 0; i < 4; i++) await session.stepAsync();
    expect(session.errors).toEqual([]);
    expect(session.currentSceneId).toBe('scn_level');
    expect(messages(session.logs)).toContain('hero:2');

    const result = await session.runtime.reloadScript(
      'scripts/lib/math.js',
      'export default { two() { return 3; } };',
    );
    expect(result).toEqual({ ok: true, entities: 1 });

    await session.stepAsync();
    expect(messages(session.logs)).toContain('hero:3');
    expect(session.errors).toEqual([]);
    session.destroy();
  });
});
