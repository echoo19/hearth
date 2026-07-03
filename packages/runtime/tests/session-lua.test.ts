/**
 * Lua script dispatch through SceneRuntime and GameSession: .lua sources
 * compile via the shared LuaScriptEngine, mixed-language scenes work, and
 * the engine's math.random stream is the session's seeded RNG.
 */
import { describe, it, expect } from 'vitest';
import { GameSession, SceneRuntime, createRng } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

const messages = (logs: { message: string }[]) => logs.map((l) => l.message);

describe('Lua script dispatch (SceneRuntime)', () => {
  it('runs .lua hooks through the runtime loop', async () => {
    const { store } = await makeStore({
      entities: [ent('Mover', { Transform: {}, Script: { scriptPath: 'scripts/mover.lua' } })],
      scripts: {
        'mover.lua': [
          'local script = {}',
          'function script.onStart(ctx)',
          '  ctx.log("lua-start " .. ctx.entity.name)',
          'end',
          'function script.onUpdate(ctx, dt)',
          '  ctx.transform.position.x = ctx.transform.position.x + 10',
          'end',
          'return script',
        ].join('\n'),
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(3);
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).toContain('lua-start Mover');
    expect(runtime.find('Mover')!.transform.position.x).toBe(30);
    runtime.destroy();
  });

  it('supports mixed .js and .lua scripts in one scene', async () => {
    const { store } = await makeStore({
      entities: [
        ent('JsOne', { Transform: {}, Script: { scriptPath: 'scripts/one.js' } }),
        ent('LuaTwo', { Transform: {}, Script: { scriptPath: 'scripts/two.lua' } }),
      ],
      scripts: {
        'one.js': `export default { onStart(ctx) { ctx.log('js:' + ctx.entity.name); } };`,
        'two.lua': [
          'local script = {}',
          'function script.onStart(ctx)',
          '  ctx.log("lua:" .. ctx.entity.name)',
          'end',
          'return script',
        ].join('\n'),
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).toEqual(expect.arrayContaining(['js:JsOne', 'lua:LuaTwo']));
    runtime.destroy();
  });
});

describe('Lua through GameSession', () => {
  it('shares the engine across a ctx.scenes.load switch and stays deterministic', async () => {
    const makeLuaStore = () =>
      makeStore({
        entities: [ent('Menu', { Transform: {}, Script: { scriptPath: 'scripts/menu.lua' } })],
        scripts: {
          'menu.lua': [
            'local script = {}',
            'function script.onUpdate(ctx, dt)',
            '  if ctx.time.frame == 1 then',
            '    ctx.scenes.load("Level")',
            '  end',
            'end',
            'return script',
          ].join('\n'),
          'hero.lua': [
            'local script = {}',
            'function script.onStart(ctx)',
            '  ctx.log("roll:" .. math.random())',
            'end',
            'return script',
          ].join('\n'),
        },
        extraScenes: [
          {
            id: 'scn_level',
            name: 'Level',
            entities: [ent('Hero', { Transform: {}, Script: { scriptPath: 'scripts/hero.lua' } })],
          },
        ],
      });

    const rolls = async (seed: number) => {
      const { store } = await makeLuaStore();
      const session = await GameSession.create(store, { seed });
      for (let i = 0; i < 4; i++) await session.stepAsync();
      expect(session.errors).toEqual([]);
      expect(session.currentSceneId).toBe('scn_level');
      const roll = messages(session.logs).find((m) => m.startsWith('roll:'));
      session.destroy();
      return roll;
    };

    const a = await rolls(9);
    const b = await rolls(9);
    const c = await rolls(10);
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // Lua math.random() draws from the session's seeded stream (Lua's
    // tostring prints %.14g, so compare numerically).
    expect(Number(a!.slice('roll:'.length))).toBeCloseTo(createRng(9)(), 12);
  });
});
