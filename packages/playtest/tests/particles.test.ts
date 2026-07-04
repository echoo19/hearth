/**
 * assertParticleCount playtest step + particleCounts reporting on
 * PlaytestResult/SmokeResult.
 *
 * Expected count arithmetic (rate 10/s, lifetime 1s, 60fps fixed timestep,
 * default burst 0): spawnAccumulator gains 10*(1/60) per fixed step. Naively
 * that crosses 1.0 every 6 steps, but 10*(1/60) is not exactly representable
 * in binary floating point, so summing it 6 times lands a hair under 1.0 —
 * the accumulator only crosses on the 7th step. Verified directly against
 * particles.ts's spawn loop: spawns land at steps 7, 13, 19, 25, 31 (not
 * 6, 12, 18, 24, 30). After 30 fixed steps (a 'wait 30 frames' step), only
 * the first 4 of those have fired, so 4 particles are live — the 5th spawns
 * on step 31. All 4 are well under the 1s lifetime (oldest has aged
 * (30-7)/60 ≈ 0.38s), so none have expired.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, ProjectStore, createProject, HearthSession } from '@hearth/core';
import { runPlaytest, runSceneSmoke, createRuntimeHooks } from '@hearth/playtest';

/** Starter project (Main scene: Camera, Ground, Player) plus a seeded emitter entity. */
async function makeEmitterProject(
  particleOverrides: Record<string, unknown> = { rate: 10, lifetime: 1 },
): Promise<{ store: ProjectStore; session: HearthSession }> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Particle Game' });
  const session = HearthSession.fromStore(store, { runtime: createRuntimeHooks() });
  const created = await session.execute('createEntity', {
    scene: 'Main',
    name: 'Emitter',
    components: { ParticleEmitter: particleOverrides },
  });
  expect(created.success).toBe(true);
  return { store, session };
}

describe('assertParticleCount step', () => {
  it('passes an exact count at a known frame', async () => {
    const { store, session } = await makeEmitterProject();
    const createdPlaytest = await session.execute<{ playtestId: string }>('createPlaytest', {
      name: 'exact count',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 30 },
        { type: 'assertParticleCount', entity: 'Emitter', equals: 4 },
      ],
    });
    expect(createdPlaytest.success).toBe(true);

    const result = await runPlaytest(store, 'exact count');
    expect(result.steps.map((s) => `${s.type}:${s.passed}`)).toEqual([
      'wait:true',
      'assertParticleCount:true',
    ]);
    expect(result.passed).toBe(true);
  });

  it('fails when the exact count does not match, with a clear message', async () => {
    const { store, session } = await makeEmitterProject();
    await session.execute('createPlaytest', {
      name: 'wrong exact count',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 30 },
        { type: 'assertParticleCount', entity: 'Emitter', equals: 999 },
      ],
    });
    const result = await runPlaytest(store, 'wrong exact count');
    expect(result.passed).toBe(false);
    expect(result.steps[1].passed).toBe(false);
    expect(result.steps[1].message).toMatch(/expected 999, got 4/);
  });

  it('passes a min bound that is satisfied', async () => {
    const { store, session } = await makeEmitterProject();
    await session.execute('createPlaytest', {
      name: 'min ok',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 30 },
        { type: 'assertParticleCount', entity: 'Emitter', min: 4 },
      ],
    });
    const result = await runPlaytest(store, 'min ok');
    expect(result.passed).toBe(true);
    expect(result.steps[1].message).toMatch(/particle count = 4/);
  });

  it('fails a min bound that is not satisfied, with a clear message', async () => {
    const { store, session } = await makeEmitterProject();
    await session.execute('createPlaytest', {
      name: 'min fail',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 30 },
        { type: 'assertParticleCount', entity: 'Emitter', min: 10 },
      ],
    });
    const result = await runPlaytest(store, 'min fail');
    expect(result.passed).toBe(false);
    expect(result.steps[1].message).toMatch(/expected >= 10, got 4/);
  });

  it('passes a max bound that is satisfied', async () => {
    const { store, session } = await makeEmitterProject();
    await session.execute('createPlaytest', {
      name: 'max ok',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 30 },
        { type: 'assertParticleCount', entity: 'Emitter', max: 4 },
      ],
    });
    const result = await runPlaytest(store, 'max ok');
    expect(result.passed).toBe(true);
  });

  it('fails a max bound that is not satisfied, with a clear message', async () => {
    const { store, session } = await makeEmitterProject();
    await session.execute('createPlaytest', {
      name: 'max fail',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 30 },
        { type: 'assertParticleCount', entity: 'Emitter', max: 2 },
      ],
    });
    const result = await runPlaytest(store, 'max fail');
    expect(result.passed).toBe(false);
    expect(result.steps[1].message).toMatch(/expected <= 2, got 4/);
  });

  it('passes a combined min/max range', async () => {
    const { store, session } = await makeEmitterProject();
    await session.execute('createPlaytest', {
      name: 'range ok',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 30 },
        { type: 'assertParticleCount', entity: 'Emitter', min: 3, max: 7 },
      ],
    });
    const result = await runPlaytest(store, 'range ok');
    expect(result.passed).toBe(true);
  });

  it('fails with a clear message when the entity is unknown', async () => {
    const { store, session } = await makeEmitterProject();
    await session.execute('createPlaytest', {
      name: 'unknown entity',
      scene: 'Main',
      steps: [{ type: 'assertParticleCount', entity: 'NoSuchEmitter', equals: 5 }],
    });
    const result = await runPlaytest(store, 'unknown entity');
    expect(result.passed).toBe(false);
    expect(result.steps[0].passed).toBe(false);
    expect(result.steps[0].message).toMatch(/entity not found: NoSuchEmitter/);
  });

  it('fails with a clear message when the entity has no ParticleEmitter, even for a vacuously-true bound', async () => {
    const { store, session } = await makeEmitterProject();
    const created = await session.execute('createEntity', { scene: 'Main', name: 'NotAnEmitter' });
    expect(created.success).toBe(true);
    await session.execute('createPlaytest', {
      name: 'no emitter',
      scene: 'Main',
      steps: [
        // max: 5 is satisfied by getParticleCount's 0-for-no-emitter default,
        // so without the fix this step passes even though "NotAnEmitter"
        // was never an emitter at all.
        { type: 'assertParticleCount', entity: 'NotAnEmitter', max: 5 },
      ],
    });
    const result = await runPlaytest(store, 'no emitter');
    expect(result.passed).toBe(false);
    expect(result.steps[0].passed).toBe(false);
    expect(result.steps[0].message).toMatch(/NotAnEmitter has no ParticleEmitter component/);
  });

  it('rejects a step schema with none of equals/min/max set', async () => {
    const { session } = await makeEmitterProject();
    const createdPlaytest = await session.execute('createPlaytest', {
      name: 'invalid step',
      scene: 'Main',
      steps: [{ type: 'assertParticleCount', entity: 'Emitter' }],
    });
    expect(createdPlaytest.success).toBe(false);
  });
});

describe('particleCounts reporting', () => {
  it('appears on PlaytestResult, keyed by entity name, only for ParticleEmitter entities', async () => {
    const { store, session } = await makeEmitterProject();
    await session.execute('createPlaytest', {
      name: 'counts report',
      scene: 'Main',
      steps: [{ type: 'wait', frames: 30 }],
    });
    const result = await runPlaytest(store, 'counts report');
    expect(result.particleCounts).toEqual({ Emitter: 4 });
  });

  it('appears on SmokeResult, keyed by entity name, only for ParticleEmitter entities', async () => {
    const { store } = await makeEmitterProject();
    const result = await runSceneSmoke(store, 'Main', 30);
    expect(result.particleCounts).toEqual({ Emitter: 4 });
  });
});
