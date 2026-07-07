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

  it('disabling and re-enabling an emitter neither re-bursts nor drops particles', async () => {
    const runtime = await makeRuntimeWithEmitter({
      seed: 1,
      rate: 0,
      burst: 2,
      lifetime: 10,
    });
    runtime.step(); // auto-burst fires, particles age to 1/60
    const emitterEntity = runtime.find('Emitter')!;
    emitterEntity.enabled = false;
    runtime.step(); // frozen while disabled; state must not be reaped
    emitterEntity.enabled = true;
    runtime.step(); // resumes aging; must not re-burst
    const particles = runtime.getParticles('Emitter');
    expect(particles.length).toBe(2);
    // Preserved particles have aged two enabled frames; a re-burst would
    // show fresh ones at age 1/60.
    expect(particles[0].age).toBeCloseTo(2 / 60, 6);
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

/**
 * Exact per-particle position/velocity/age snapshots, recorded against
 * unmodified (pre-Task-11) particles.ts by running these two scenarios once
 * and copying EmitterState's output verbatim into EXPECTED_CAP/EXPECTED_EXPIRY
 * below (same golden discipline as goldenDeterminism.test.ts's Tasks 9-10
 * hashes). Task 11's pooling change (free-list reuse in spawnOne, objects
 * recycled on splice-expiry and shift-eviction) must reproduce these
 * snapshots bit-for-bit — it's only allowed to change *how* particle objects
 * are allocated, never any arithmetic (rng draws, integration, spawn/expiry
 * order). If a hash-style change ever legitimately alters particle behavior,
 * these must be regenerated against the new code and the reason documented;
 * they must never be updated just to make a diverging run pass silently.
 *
 * CAP: maxParticles(4) is well under the steady-state particle count a
 * 60/s rate + 10-frame lifetime would produce (10), so every eviction here
 * is a maxParticles-cap shift(), exercising pool reuse via that path.
 * EXPIRY: maxParticles(50) is well above the steady-state count (10), so
 * cap-eviction never triggers and every eviction here is an age>=lifetime
 * splice(), exercising pool reuse via that path instead.
 *
 * PLATFORM SCOPE: particles.ts seeds each particle's velocity with
 * Math.cos/Math.sin (spread around `direction`), and trig is NOT bit-identical
 * across V8/libm builds — an arm64-macOS run and an x64-Linux run differ by a
 * floating-point ULP at spawn, which compounds through integration into the
 * exact x/y/vx/vy recorded below. Hearth's determinism contract is same-seed
 * SAME-PLATFORM reproducibility (docs/scripting.md → Determinism), never
 * cross-platform bit-equality. So the pooling safety net is expressed
 * platform-independently — two independently-seeded runs of the same emitter
 * config must snapshot identically (pooling must not make a run diverge from
 * itself) — and the absolute EXPECTED_* pin is additionally asserted only on
 * the recording platform (arm64 macOS) where it was captured.
 */
const EXPECTED_CAP: Record<number, unknown> = {
  30: [
    { x: 2.3732471737297662, y: 0.9192708959829864, vx: 47.46494347459532, vy: 19.718751252993062, age: 0.05, lifetime: 0.16666666666666666 },
    { x: 1.6010703425697632, y: 0.5296478065863384, vx: 48.0321102770929, vy: 16.55610086425682, age: 0.03333333333333333, lifetime: 0.16666666666666666 },
    { x: 0.8181794730350674, y: -0.13597636926488266, vx: 49.090768382104045, vy: -8.15858215589296, age: 0.016666666666666666, lifetime: 0.16666666666666666 },
    { x: 0, y: 0, vx: 49.585079574351674, vy: 6.42805441834559, age: 0, lifetime: 0.16666666666666666 },
  ],
  60: [
    { x: 2.4957846808999418, y: -0.011783263185384852, vx: 49.91569361799883, vy: 1.0976680696256362, age: 0.05, lifetime: 0.16666666666666666 },
    { x: 1.6500903892881449, y: 0.3011437123591526, vx: 49.502711678644346, vy: 9.700978037441244, age: 0.03333333333333333, lifetime: 0.16666666666666666 },
    { x: 0.7284093644808107, y: 0.42702370712699106, vx: 43.70456186884864, vy: 25.621422427619464, age: 0.016666666666666666, lifetime: 0.16666666666666666 },
    { x: 0, y: 0, vx: 49.85869734618454, vy: -3.7563677857167783, age: 0, lifetime: 0.16666666666666666 },
  ],
  90: [
    { x: 2.1762251151207703, y: -1.097131720342548, vx: 43.52450230241541, vy: -20.609301073517628, age: 0.05, lifetime: 0.16666666666666666 },
    { x: 1.535958408271277, y: 0.7136670884892055, vx: 46.07875224813831, vy: 22.07667932134283, age: 0.03333333333333333, lifetime: 0.16666666666666666 },
    { x: 0.8154114271398537, y: -0.14967498233384816, vx: 48.924685628391224, vy: -8.98049894003089, age: 0.016666666666666666, lifetime: 0.16666666666666666 },
    { x: 0, y: 0, vx: 49.76884624181971, vy: -4.802285264132936, age: 0, lifetime: 0.16666666666666666 },
  ],
};

const EXPECTED_EXPIRY: Record<number, unknown> = {
  30: [
    { x: 7.096261486802813, y: 8.79590914177234, vx: 47.641743245352096, vy: 63.9727276118156, age: 0.15, lifetime: 0.16666666666666666 },
    { x: 7.899483442889311, y: -4.249427768660297, vx: 59.53779248833651, vy: -27.204041598285563, age: 0.13333333333333333, lifetime: 0.16666666666666666 },
    { x: 6.758228778544244, y: 5.263872348172134, vx: 58.17767524466496, vy: 49.118905841475446, age: 0.11666666666666665, lifetime: 0.16666666666666666 },
    { x: 6.994724820605887, y: 1.1602080166169189, vx: 70.15558153939219, vy: 14.935413499502523, age: 0.09999999999999999, lifetime: 0.16666666666666666 },
    { x: 4.185198450446086, y: -3.751497256685336, vx: 50.389048072019705, vy: -42.35130041355736, age: 0.08333333333333333, lifetime: 0.16666666666666666 },
    { x: 3.625595208129562, y: -2.73300285234228, vx: 54.50892812194344, vy: -38.99504278513419, age: 0.06666666666666667, lifetime: 0.16666666666666666 },
    { x: 3.023445603522771, y: 1.9107184908479045, vx: 60.55224540378876, vy: 39.547703150291426, age: 0.05, lifetime: 0.16666666666666666 },
    { x: 2.297054530600211, y: 0.4992284401403648, vx: 68.953302584673, vy: 15.643519870877611, age: 0.03333333333333333, lifetime: 0.16666666666666666 },
    { x: 1.0636888137059004, y: -0.4600950808520954, vx: 63.82132882235402, vy: -27.605704851125722, age: 0.016666666666666666, lifetime: 0.16666666666666666 },
    { x: 0, y: 0, vx: 68.08879562225802, vy: -16.24548893417421, age: 0, lifetime: 0.16666666666666666 },
  ],
  60: [
    { x: 9.86433601451651, y: -2.7648387408396458, vx: 66.09557343011004, vy: -13.098924938930972, age: 0.15, lifetime: 0.16666666666666666 },
    { x: 9.347513459084672, y: 1.616917737137837, vx: 70.3980176098017, vy: 16.793549695200447, age: 0.13333333333333333, lifetime: 0.16666666666666666 },
    { x: 6.697625159145486, y: 5.350401124042006, vx: 57.65821564981845, vy: 49.860581063217204, age: 0.11666666666666665, lifetime: 0.16666666666666666 },
    { x: 6.930602203929244, y: 1.6372167617113793, vx: 69.51435537262576, vy: 19.705500950447124, age: 0.09999999999999999, lifetime: 0.16666666666666666 },
    { x: 2.6969630869333856, y: 5.516585914452095, vx: 32.5302237098673, vy: 68.8656976400918, age: 0.08333333333333333, lifetime: 0.16666666666666666 },
    { x: 4.660358897164636, y: 0.6559205505239831, vx: 70.03038345746954, vy: 11.838808257859746, age: 0.06666666666666667, lifetime: 0.16666666666666666 },
    { x: 3.260481378507201, y: -1.1603177371921725, vx: 65.29296090347735, vy: -21.873021410510116, age: 0.05, lifetime: 0.16666666666666666 },
    { x: 2.285382633034497, y: -0.42373944996824076, vx: 68.60314565770157, vy: -12.045516832380557, age: 0.03333333333333333, lifetime: 0.16666666666666666 },
    { x: 1.1607366722298877, y: 0.15269761596917875, vx: 69.64420033379326, vy: 9.161856958150725, age: 0.016666666666666666, lifetime: 0.16666666666666666 },
    { x: 0, y: 0, vx: 52.425858832754905, vy: 46.38458068850094, age: 0, lifetime: 0.16666666666666666 },
  ],
  90: [
    { x: 9.32399425594197, y: -3.9471935627337182, vx: 62.493295039613145, vy: -20.98129041822479, age: 0.15, lifetime: 0.16666666666666666 },
    { x: 5.459705919242618, y: 8.405668476762743, vx: 41.23946106098631, vy: 67.70918024238725, age: 0.13333333333333333, lifetime: 0.16666666666666666 },
    { x: 7.5142562945041576, y: -2.6661400746528123, vx: 64.65791109574991, vy: -18.85262921130982, age: 0.11666666666666665, lifetime: 0.16666666666666666 },
    { x: 6.834416377405393, y: 2.106354556019534, vx: 68.55249710738725, vy: 24.396878893528672, age: 0.09999999999999999, lifetime: 0.16666666666666666 },
    { x: 5.187384983795612, y: -2.3748988983785813, vx: 62.41528647221401, vy: -25.83212011387631, age: 0.08333333333333333, lifetime: 0.16666666666666666 },
    { x: 1.6387165357468807, y: 4.596889397652108, vx: 24.705748036203207, vy: 70.9533409647816, age: 0.06666666666666667, lifetime: 0.16666666666666666 },
    { x: 3.5078803781697196, y: 0.07702630910979166, vx: 70.24094089672772, vy: 2.8738595155291664, age: 0.05, lifetime: 0.16666666666666666 },
    { x: 2.158847321523372, y: 0.9620971329959744, vx: 64.80708631236783, vy: 29.5295806565459, age: 0.03333333333333333, lifetime: 0.16666666666666666 },
    { x: 0.5436458034767128, y: 1.0552123236717978, vx: 32.61874820860277, vy: 63.31273942030787, age: 0.016666666666666666, lifetime: 0.16666666666666666 },
    { x: 0, y: 0, vx: 69.3461098893892, vy: -9.545524773880057, age: 0, lifetime: 0.16666666666666666 },
  ],
};

/** Snapshot every live particle's full field set at frames 30/60/90. */
async function snapshotFrames(
  runtime: SceneRuntime,
  entityName: string,
): Promise<Record<number, unknown>> {
  const snapshotAt: Record<number, unknown> = {};
  for (let frame = 1; frame <= 90; frame++) {
    runtime.step();
    if (frame === 30 || frame === 60 || frame === 90) {
      snapshotAt[frame] = (runtime.getParticles(entityName) as readonly Particle[]).map((p) => ({
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        age: p.age,
        lifetime: p.lifetime,
      }));
    }
  }
  return snapshotAt;
}

/**
 * The platform on which EXPECTED_CAP/EXPECTED_EXPIRY were recorded (see the
 * block comment above). The absolute pin is only meaningful here; everywhere
 * else the run-twice determinism assert carries the pooling safety net.
 */
const IS_RECORDING_PLATFORM = process.platform === 'darwin' && process.arch === 'arm64';

/**
 * Runs the same emitter config twice (independent runtimes, independent
 * particle pools) and asserts the two snapshots are identical — pooling must
 * never make a run diverge from an equivalent run. On the recording platform,
 * additionally pins the exact pre-pooling trajectory.
 */
async function assertPoolingTrajectory(
  overrides: Record<string, unknown>,
  expected: Record<number, unknown>,
): Promise<void> {
  const snapA = await snapshotFrames(await makeRuntimeWithEmitter(overrides), 'Emitter');
  const snapB = await snapshotFrames(await makeRuntimeWithEmitter(overrides), 'Emitter');
  expect(snapB, 'pooling made two identical-config runs diverge').toEqual(snapA);
  if (IS_RECORDING_PLATFORM) {
    expect(snapA, 'trajectory changed on the recording platform').toEqual(expected);
  }
}

describe('seeded particle trajectory pin (Task 11 pooling safety net)', () => {
  it('cap-eviction (shift) path: pooling-stable, and matches pre-pooling positions on the recording platform', async () => {
    await assertPoolingTrajectory(
      {
        seed: 11,
        rate: 60,
        burst: 0,
        lifetime: 10 / 60,
        speed: 50,
        spread: 30,
        direction: 0,
        gravity: { x: 0, y: 80 },
        maxParticles: 4,
        emitting: true,
      },
      EXPECTED_CAP,
    );
  });

  it('lifetime-expiry (splice) path: pooling-stable, and matches pre-pooling positions on the recording platform', async () => {
    await assertPoolingTrajectory(
      {
        seed: 22,
        rate: 60,
        burst: 0,
        lifetime: 10 / 60,
        speed: 70,
        spread: 60,
        direction: 15,
        gravity: { x: 5, y: 80 },
        maxParticles: 50,
        emitting: true,
      },
      EXPECTED_EXPIRY,
    );
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
