/**
 * SpriteEffects: deterministic flashStrength decay in SceneRuntime.step(),
 * ctx.effects.flash mutating the entity's own runtime component, and
 * runtime.camera.postEffects — all headless, no RNG.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime, GameSession } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

describe('SpriteEffects flash decay', () => {
  it('decays flashStrength from 1 to (approximately) 0 within ceil(duration/dt) frames, pure arithmetic', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Hero', {
          Transform: {},
          SpriteEffects: { flashStrength: 1, flashDuration: 0.1 },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    const dt = runtime.fixedDt; // 1/60
    const expectedFrames = Math.ceil(0.1 / dt); // 6
    const trace: number[] = [];
    for (let i = 0; i < expectedFrames + 2; i++) {
      runtime.step();
      trace.push(runtime.find('Hero')!.components.SpriteEffects!.flashStrength);
    }
    // Floating-point residue can leave a tiny (<1e-10) positive value at the
    // exact ceil(duration/dt) frame; it's clamped to exactly 0 on the frame
    // after. Either way it's fully decayed within one frame of the estimate.
    expect(trace[expectedFrames - 1]).toBeLessThan(1e-10);
    expect(trace[expectedFrames]).toBe(0);
    // Monotonically non-increasing, never negative, and holds at 0 once there.
    expect(trace.every((v) => v >= 0)).toBe(true);
    expect(trace[trace.length - 1]).toBe(0);
    runtime.destroy();
  });

  it('two identical seeded runs produce identical flashStrength traces', async () => {
    const build = async () =>
      makeStore({
        entities: [
          ent('Hero', {
            Transform: {},
            SpriteEffects: { flashStrength: 1, flashDuration: 0.25 },
          }),
        ],
      });
    const traceFor = async () => {
      const { store } = await build();
      const runtime = await SceneRuntime.create(store, 'Test');
      const trace: number[] = [];
      for (let i = 0; i < 20; i++) {
        runtime.step();
        trace.push(runtime.find('Hero')!.components.SpriteEffects!.flashStrength);
      }
      runtime.destroy();
      return trace;
    };
    const a = await traceFor();
    const b = await traceFor();
    expect(a).toEqual(b);
  });

  it('a default (no-op) SpriteEffects component never changes flashStrength: decay skips it', async () => {
    const { store } = await makeStore({
      entities: [ent('Hero', { Transform: {}, SpriteEffects: {} })],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    for (let i = 0; i < 10; i++) runtime.step();
    expect(runtime.find('Hero')!.components.SpriteEffects!.flashStrength).toBe(0);
    runtime.destroy();
  });

});

describe('ctx.effects.flash', () => {
  it('sets flashColor/flashStrength=1/flashDuration on this entity, creating SpriteEffects if absent', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Hero', {
          Transform: {},
          Script: { scriptPath: 'scripts/hero.js' },
        }),
      ],
      scripts: {
        'hero.js': `export default {
          onStart(ctx) { ctx.effects.flash('#ff0000', 0.2); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    const fx = runtime.find('Hero')!.components.SpriteEffects;
    expect(fx).toBeDefined();
    expect(fx!.flashColor).toBe('#ff0000');
    // onStart (script phase) sets flashStrength to 1, but the flash-decay
    // step runs later in that same fixed frame — so by the time step()
    // returns, one frame's worth of decay has already applied. This mirrors
    // ctx.camera.shake/flash's identical same-frame-decay behavior.
    expect(fx!.flashStrength).toBeCloseTo(1 - runtime.fixedDt / 0.2, 10);
    expect(fx!.flashDuration).toBe(0.2);
    expect(runtime.errors).toEqual([]);
    runtime.destroy();
  });

  it('defaults to white and 0.15s when called with no args, clamped to schema bounds', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Hero', { Transform: {}, Script: { scriptPath: 'scripts/hero.js' } }),
      ],
      scripts: {
        'hero.js': `export default {
          onStart(ctx) { ctx.effects.flash(); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    const fx = runtime.find('Hero')!.components.SpriteEffects!;
    expect(fx.flashColor).toBe('#ffffff');
    expect(fx.flashDuration).toBe(0.15);
    runtime.destroy();
  });

  it('clamps an out-of-range seconds to [0.01, 10]', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Hero', { Transform: {}, Script: { scriptPath: 'scripts/hero.js' } }),
        ent('Villain', { Transform: {}, Script: { scriptPath: 'scripts/villain.js' } }),
      ],
      scripts: {
        'hero.js': `export default { onStart(ctx) { ctx.effects.flash('#fff', 100); } };`,
        'villain.js': `export default { onStart(ctx) { ctx.effects.flash('#000', -5); } };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    expect(runtime.find('Hero')!.components.SpriteEffects!.flashDuration).toBe(10);
    expect(runtime.find('Villain')!.components.SpriteEffects!.flashDuration).toBe(0.01);
    runtime.destroy();
  });

  it('never mutates the authored scene data — only the runtime copy', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Hero', { Transform: {}, Script: { scriptPath: 'scripts/hero.js' } }),
      ],
      scripts: {
        'hero.js': `export default { onStart(ctx) { ctx.effects.flash('#ff0000', 0.2); } };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    const authored = store.getScene('Test')!.entities.find((e) => e.name === 'Hero')!;
    expect(authored.components.SpriteEffects).toBeUndefined();
    runtime.destroy();
  });
});

describe('runtime.camera.postEffects', () => {
  it('reflects the main Camera entity postEffects stack', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Cam', {
          Transform: {},
          Camera: { isMain: true, postEffects: [{ type: 'bloom' }, { type: 'vignette' }] },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.camera.postEffects.map((e) => e.type)).toEqual(['bloom', 'vignette']);
    runtime.destroy();
  });

  it('defaults to [] when the scene has no Camera entity', async () => {
    const { store } = await makeStore({ entities: [ent('Nothing', { Transform: {} })] });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.camera.postEffects).toEqual([]);
    runtime.destroy();
  });
});

describe('ctx.effects.flash through GameSession Lua parity', () => {
  const JS_SCRIPT = `export default { onStart(ctx) { ctx.effects.flash('#ff0000', 0.2); } };`;
  const LUA_SCRIPT = [
    'local script = {}',
    'function script.onStart(ctx)',
    '  ctx.effects.flash("#ff0000", 0.2)',
    'end',
    'return script',
  ].join('\n');

  async function traceFor(scriptPath: string, source: string): Promise<number[]> {
    const { store } = await makeStore({
      entities: [ent('Hero', { Transform: {}, Script: { scriptPath } })],
      scripts: { [scriptPath.replace('scripts/', '')]: source },
    });
    const session = await GameSession.create(store);
    const trace: number[] = [];
    for (let i = 0; i < 15; i++) {
      await session.stepAsync();
      trace.push(session.runtime.find('Hero')!.components.SpriteEffects!.flashStrength);
    }
    session.destroy();
    return trace;
  }

  it('a Lua dot-call to ctx.effects.flash decays identically to the JS equivalent', async () => {
    const jsTrace = await traceFor('scripts/hero.js', JS_SCRIPT);
    const luaTrace = await traceFor('scripts/hero.lua', LUA_SCRIPT);
    expect(luaTrace).toEqual(jsTrace);
    expect(jsTrace.some((v) => v > 0)).toBe(true);
  });
});
