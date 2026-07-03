/**
 * Deterministic particle simulation: EmitterState stepping/burst, its
 * wiring into SceneRuntime's fixed-step loop, and ctx.particles from JS
 * and Lua scripts.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime, type RuntimeOptions } from '@hearth/runtime';
import type { Particle } from '../src/particles.js';
import { makeStore, ent } from './helpers.js';

/** One entity named 'Emitter' with a ParticleEmitter built from overrides. */
async function makeRuntimeWithEmitter(
  particleOverrides: Record<string, unknown>,
  runtimeOptions: RuntimeOptions = {},
): Promise<SceneRuntime> {
  const { store } = await makeStore({
    entities: [
      ent('Emitter', {
        Transform: { position: { x: 0, y: 0 } },
        ParticleEmitter: particleOverrides,
      }),
    ],
  });
  return SceneRuntime.create(store, 'Test', runtimeOptions);
}

describe('particle determinism', () => {
  it('particle streams are reproducible regardless of session seed', async () => {
    const a = await makeRuntimeWithEmitter(
      { seed: 7, rate: 20, lifetime: 0.5 },
      { seed: 1 },
    );
    const b = await makeRuntimeWithEmitter(
      { seed: 7, rate: 20, lifetime: 0.5 },
      { seed: 999 },
    );
    a.run(60);
    b.run(60);
    expect(a.getParticles('Emitter')).toEqual(b.getParticles('Emitter'));
    expect(a.getParticleCount('Emitter')).toBeGreaterThan(0);
  });
});

describe('EmitterState stepping', () => {
  it('burst spawns on scene start, rate accumulates fractionally', async () => {
    const runtime = await makeRuntimeWithEmitter({
      seed: 1,
      rate: 30, // 0.5 particles per fixed frame at 60fps
      burst: 3,
      emitting: true,
      lifetime: 10,
    });
    // Frame 0: onStart burst (3) already present before any step() runs the
    // particle stage, plus fractional rate accumulation begins.
    runtime.step();
    // 30/60 = 0.5 accumulated after 1 frame: not enough to spawn from rate yet.
    expect(runtime.getParticleCount('Emitter')).toBe(3);
    runtime.step();
    // accumulator reaches 1.0 on the 2nd frame: one rate-spawned particle.
    expect(runtime.getParticleCount('Emitter')).toBe(4);
  });

  it('particles expire after lifetime', async () => {
    const runtime = await makeRuntimeWithEmitter({
      seed: 1,
      rate: 0,
      burst: 1,
      lifetime: 3 / 60, // expires after 3 fixed frames of aging
    });
    // Burst happens on the same frame the EmitterState is created, and that
    // frame's own step() ages the just-spawned particle once already.
    runtime.step(); // age = 1/60
    expect(runtime.getParticleCount('Emitter')).toBe(1);
    runtime.step(); // age = 2/60, still alive
    expect(runtime.getParticleCount('Emitter')).toBe(1);
    runtime.step(); // age = 3/60 >= lifetime, expires
    expect(runtime.getParticleCount('Emitter')).toBe(0);
  });

  it('maxParticles caps with oldest-first eviction', async () => {
    const runtime = await makeRuntimeWithEmitter({
      seed: 1,
      rate: 0,
      burst: 5,
      maxParticles: 2,
      lifetime: 10,
    });
    runtime.step();
    expect(runtime.getParticleCount('Emitter')).toBe(2);
  });

  it('gravity integrates into velocity then position', async () => {
    const runtime = await makeRuntimeWithEmitter({
      seed: 1,
      rate: 0,
      burst: 1,
      speed: 0,
      gravity: { x: 0, y: 100 },
      lifetime: 10,
    });
    const dt = runtime.fixedDt;
    // Burst and the frame's own integration pass both happen in this step().
    runtime.step();
    const [p] = runtime.getParticles('Emitter') as readonly Particle[];
    expect(p.vy).toBeCloseTo(100 * dt, 6);
    expect(p.y).toBeCloseTo(100 * dt * dt, 6);
  });

  it('emitting=false stops rate spawning but existing particles live on', async () => {
    const runtime = await makeRuntimeWithEmitter({
      seed: 1,
      rate: 60, // one per frame
      burst: 1,
      emitting: false,
      lifetime: 10,
    });
    runtime.step();
    expect(runtime.getParticleCount('Emitter')).toBe(1); // burst only
    runtime.step();
    runtime.step();
    expect(runtime.getParticleCount('Emitter')).toBe(1); // no rate spawns
  });
});

describe('getParticles / getParticleCount', () => {
  it('returns [] and 0 for entities without a ParticleEmitter', async () => {
    const { store } = await makeStore({ entities: [ent('Plain', {})] });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(3);
    expect(runtime.getParticles('Plain')).toEqual([]);
    expect(runtime.getParticleCount('Plain')).toBe(0);
  });
});

describe('ctx.particles', () => {
  it('burst and count work from a JS script', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Emitter', {
          Transform: {},
          ParticleEmitter: { seed: 2, rate: 0, burst: 0, lifetime: 10 },
          Script: { scriptPath: 'scripts/emit.js' },
        }),
      ],
      scripts: {
        'emit.js': `export default {
          onStart(ctx) { ctx.particles.burst(5); },
          onUpdate(ctx) { ctx.vars.count = ctx.particles.count(); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(2);
    expect(runtime.getParticleCount('Emitter')).toBe(5);
  });

  it('warns and no-ops when the entity has no ParticleEmitter', async () => {
    const { store } = await makeStore({
      entities: [
        ent('NoEmitter', {
          Transform: {},
          Script: { scriptPath: 'scripts/emit.js' },
        }),
      ],
      scripts: {
        'emit.js': `export default {
          onStart(ctx) { ctx.particles.burst(5); ctx.vars.count = ctx.particles.count(); },
        };`,
      },
    });
    const logs: string[] = [];
    const runtime = await SceneRuntime.create(store, 'Test', {
      onLog: (e) => logs.push(e.message),
    });
    runtime.run(1);
    // Only burst() is documented to warn; count() just returns 0.
    expect(logs.some((m) => m.includes('particles.burst'))).toBe(true);
    expect(runtime.getParticleCount('NoEmitter')).toBe(0);
  });

  it('scene-start auto-burst still fires when onStart calls ctx.particles.burst', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Emitter', {
          Transform: {},
          ParticleEmitter: { seed: 4, rate: 0, burst: 5, lifetime: 10 },
          Script: { scriptPath: 'scripts/early.js' },
        }),
      ],
      scripts: {
        'early.js': `export default {
          onStart(ctx) { ctx.particles.burst(3); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    // The script burst (3) in onStart must not swallow the emitter's own
    // scene-start burst (5): both land in frame 0.
    expect(runtime.getParticleCount('Emitter')).toBe(8);
  });

  it('count works from a Lua script', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Emitter', {
          Transform: {},
          ParticleEmitter: { seed: 5, rate: 0, burst: 2, lifetime: 10 },
          Script: { scriptPath: 'scripts/count.lua' },
        }),
      ],
      scripts: {
        'count.lua': [
          'return {',
          '  onUpdate = function(ctx)',
          '    ctx.log("count:" .. ctx.particles.count())',
          '  end,',
          '}',
        ].join('\n'),
      },
    });
    const logs: string[] = [];
    const runtime = await SceneRuntime.create(store, 'Test', {
      onLog: (e) => logs.push(e.message),
    });
    runtime.run(2);
    // onUpdate runs before the particle stage: frame 0 sees 0, frame 1 sees
    // the frame-0 auto-burst.
    expect(logs).toEqual(['count:0', 'count:2']);
  });

  it('burst and count work from a Lua script (ctx crosses wholesale)', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Emitter', {
          Transform: {},
          ParticleEmitter: { seed: 3, rate: 0, burst: 0, lifetime: 10 },
          Script: { scriptPath: 'scripts/emit.lua' },
        }),
      ],
      scripts: {
        'emit.lua': [
          'return {',
          '  onStart = function(ctx)',
          '    ctx.particles.burst(4)',
          '  end,',
          '}',
        ].join('\n'),
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.getParticleCount('Emitter')).toBe(4);
  });
});
