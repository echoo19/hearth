/**
 * Motion tracing: per-frame position sampling, traceSummary math, raw opt-in
 * + cap, and the assertPeak/assertRange/assertSettledBy trace asserts.
 */
import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  ProjectStore,
  SceneSchema,
  createProject,
  HearthSession,
} from '@hearth/core';
import { runPlaytest, createRuntimeHooks } from '@hearth/playtest';

// Ramp Mover.x from 0 to 50 over frames 1..5 (10px/frame), then hold at 50.
// Deterministic and independent of dt.
const RAMP_SCRIPT = `export default {
  onUpdate(ctx) {
    ctx.transform.position.x = Math.min(ctx.time.frame, 5) * 10;
  },
};`;

// Move the camera-carrying entity the same way so camera tracing has signal.
// Camera starts at x=400, so ramp additively from there (20px/frame for 5
// frames → 400..500) to match the tracing assertions below.
const CAMERA_RAMP_SCRIPT = `export default {
  onUpdate(ctx) {
    ctx.transform.position.x = 400 + Math.min(ctx.time.frame, 5) * 20;
  },
};`;

/**
 * Project with a Main scene containing a Camera and a Mover entity driven by
 * the ramp script. Optionally moves the Camera too.
 */
async function makeMoverProject(opts: { moveCamera?: boolean } = {}): Promise<{
  store: ProjectStore;
  session: HearthSession;
}> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/mover', { name: 'Mover Game', starterScene: false });
  store.project.scenes.push({ id: 'scn_main', name: 'Main', path: 'scenes/main.scene.json' });
  store.project.initialScene = 'scn_main';
  store.scenes.set(
    'scn_main',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_main',
      name: 'Main',
      entities: [
        {
          id: 'ent_cam',
          name: 'Camera',
          parentId: null,
          enabled: true,
          tags: [],
          components: {
            Transform: { position: { x: 400, y: 300 } },
            Camera: { isMain: true },
            ...(opts.moveCamera ? { Script: { scriptPath: 'scripts/cammove.js' } } : {}),
          },
        },
        {
          id: 'ent_mover',
          name: 'Mover',
          parentId: null,
          enabled: true,
          tags: [],
          components: {
            Transform: { position: { x: 0, y: 0 } },
            Script: { scriptPath: 'scripts/ramp.js' },
          },
        },
      ],
    }),
  );
  await fs.writeFile('/mover/scripts/ramp.js', RAMP_SCRIPT);
  await fs.writeFile('/mover/scripts/cammove.js', CAMERA_RAMP_SCRIPT);
  await store.save();
  const loaded = await ProjectStore.load(fs, '/mover');
  const session = HearthSession.fromStore(loaded, { runtime: createRuntimeHooks() });
  return { store: loaded, session };
}

describe('trace recording', () => {
  it('summarizes envelope, peak speed and settle time for a scripted ramp', async () => {
    const { store, session } = await makeMoverProject();
    await session.execute('createPlaytest', {
      name: 'ramp trace',
      scene: 'Main',
      trace: { entities: ['Mover'] },
      steps: [{ type: 'wait', frames: 20 }],
    });
    const result = await runPlaytest(store, 'ramp trace');
    expect(result.passed).toBe(true);

    const s = result.traceSummary.Mover;
    expect(s).toBeDefined();
    // Envelope: starts at 0, climbs to 50, y never changes.
    expect(s.first).toEqual({ x: 0, y: 0 });
    expect(s.final).toEqual({ x: 50, y: 0 });
    expect(s.min).toEqual({ x: 0, y: 0 });
    expect(s.max).toEqual({ x: 50, y: 0 });
    // Ramp moves 10px/frame at 60fps → peakSpeed 600.
    expect(s.peakSpeed).toBeCloseTo(600, 6);
    // Motion stops once x reaches 50; must have settled before the run ended.
    expect(s.settledAtFrame).not.toBeNull();
    expect(s.settledAtFrame!).toBeGreaterThan(0);
    expect(s.settledAtFrame!).toBeLessThan(result.framesRun);
    // frames = 20 steps + the frame-0 baseline sample.
    expect(s.frames).toBe(21);
  });

  it('reports settledAtFrame null when the entity is still moving at the end', async () => {
    const { store, session } = await makeMoverProject();
    await session.execute('createPlaytest', {
      name: 'still moving',
      scene: 'Main',
      trace: { entities: ['Mover'] },
      // Stop while the ramp is still climbing (before frame 5).
      steps: [{ type: 'wait', frames: 3 }],
    });
    const result = await runPlaytest(store, 'still moving');
    expect(result.traceSummary.Mover.settledAtFrame).toBeNull();
  });

  it('traces the camera when requested', async () => {
    const { store, session } = await makeMoverProject({ moveCamera: true });
    await session.execute('createPlaytest', {
      name: 'camera trace',
      scene: 'Main',
      trace: { entities: [], camera: true },
      steps: [{ type: 'wait', frames: 20 }],
    });
    const result = await runPlaytest(store, 'camera trace');
    const c = result.traceSummary.camera;
    expect(c).toBeDefined();
    // Camera x ramps from 400 to 400+100 (20px/frame × 5).
    expect(c.first.x).toBe(400);
    expect(c.max.x).toBe(500);
    expect(c.peakSpeed).toBeCloseTo(1200, 6);
  });

  it('omits raw samples from the default result', async () => {
    const { store, session } = await makeMoverProject();
    await session.execute('createPlaytest', {
      name: 'no raw',
      scene: 'Main',
      trace: { entities: ['Mover'] },
      steps: [{ type: 'wait', frames: 10 }],
    });
    const result = await runPlaytest(store, 'no raw');
    expect(result.traceSummary.Mover).toBeDefined();
    expect(result.trace).toBeUndefined();
  });

  it('includes raw per-frame samples only when raw:true', async () => {
    const { store, session } = await makeMoverProject();
    await session.execute('createPlaytest', {
      name: 'with raw',
      scene: 'Main',
      trace: { entities: ['Mover'], raw: true },
      steps: [{ type: 'wait', frames: 5 }],
    });
    const result = await runPlaytest(store, 'with raw');
    expect(result.trace).toBeDefined();
    const samples = result.trace!.Mover;
    expect(samples.length).toBe(6); // frame-0 baseline + 5 steps
    expect(samples[0]).toEqual({ frame: 0, x: 0, y: 0 });
    // Every sample carries a frame index and world coordinates.
    for (const smp of samples) {
      expect(typeof smp.frame).toBe('number');
      expect(typeof smp.x).toBe('number');
      expect(typeof smp.y).toBe('number');
    }
  });

  it('errors and fails when the raw trace exceeds the sample cap', async () => {
    const { store, session } = await makeMoverProject();
    // 20001 frames × 1 entity > 20000 cap.
    await session.execute('createPlaytest', {
      name: 'raw cap',
      scene: 'Main',
      maxFrames: 20001,
      trace: { entities: ['Mover'], raw: true },
      steps: [{ type: 'wait', frames: 20001 }],
    });
    const result = await runPlaytest(store, 'raw cap');
    expect(result.passed).toBe(false);
    expect(result.trace).toBeUndefined();
    expect(result.errors.some((e) => /cap/.test(e.message) && /20000/.test(e.message))).toBe(true);
  });
});

describe('assertPeak', () => {
  it('passes and fails over a scripted ramp with observed values in the message', async () => {
    const { store, session } = await makeMoverProject();
    await session.execute('createPlaytest', {
      name: 'peak asserts',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 20 },
        // peak x amplitude is 50 (moved 50 from start).
        { type: 'assertPeak', entity: 'Mover', property: 'x', op: 'greaterThan', value: 40 },
        { type: 'assertPeak', entity: 'Mover', property: 'x', op: 'lessThan', value: 40 },
        // peak speed is 600.
        { type: 'assertPeak', entity: 'Mover', property: 'speed', op: 'greaterThan', value: 500 },
      ],
    });
    const result = await runPlaytest(store, 'peak asserts');
    expect(result.steps[1].passed).toBe(true);
    expect(result.steps[2].passed).toBe(false);
    expect(result.steps[2].message).toMatch(/was 50/);
    expect(result.steps[2].message).toMatch(/expected < 40/);
    expect(result.steps[3].passed).toBe(true);
    // assertPeak auto-enabled tracing even though trace was not declared.
    expect(result.traceSummary.Mover).toBeDefined();
  });
});

describe('assertRange', () => {
  it('passes when the entity stays in range and fails with the offending extreme', async () => {
    const { store, session } = await makeMoverProject();
    await session.execute('createPlaytest', {
      name: 'range asserts',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 20 },
        { type: 'assertRange', entity: 'Mover', property: 'x', min: -10, max: 100 },
        { type: 'assertRange', entity: 'Mover', property: 'x', min: -10, max: 40 },
      ],
    });
    const result = await runPlaytest(store, 'range asserts');
    expect(result.steps[1].passed).toBe(true);
    expect(result.steps[2].passed).toBe(false);
    expect(result.steps[2].message).toMatch(/peaked at 50/);
  });
});

describe('assertSettledBy', () => {
  it('passes when settled by the frame and fails with the observed displacement', async () => {
    const { store, session } = await makeMoverProject();
    await session.execute('createPlaytest', {
      name: 'settle asserts',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 20 },
        // By frame 10 the ramp has long stopped.
        { type: 'assertSettledBy', entity: 'Mover', frame: 10 },
        // From frame 2 the ramp is still climbing (moves 10px/frame ≥ 0.1).
        { type: 'assertSettledBy', entity: 'Mover', frame: 2, epsilon: 0.1 },
      ],
    });
    const result = await runPlaytest(store, 'settle asserts');
    expect(result.steps[1].passed).toBe(true);
    expect(result.steps[2].passed).toBe(false);
    expect(result.steps[2].message).toMatch(/displacement 10/);
    expect(result.steps[2].message).toMatch(/expected < 0\.1/);
  });
});

describe('createPlaytest trace round-trip', () => {
  it('persists trace through the schema and back out of the store', async () => {
    const { store, session } = await makeMoverProject();
    const created = await session.execute<{ playtestId: string }>('createPlaytest', {
      name: 'roundtrip',
      scene: 'Main',
      trace: { entities: ['Mover'], camera: true, raw: true },
      steps: [{ type: 'wait', frames: 1 }],
    });
    expect(created.success).toBe(true);
    const pt = store.getPlaytest('roundtrip');
    expect(pt!.trace).toEqual({ entities: ['Mover'], camera: true, raw: true });

    // And a full save/load cycle keeps it.
    await store.save();
    const reloaded = await ProjectStore.load(store.fs, store.root);
    expect(reloaded.getPlaytest('roundtrip')!.trace).toEqual({
      entities: ['Mover'],
      camera: true,
      raw: true,
    });
  });

  it('rejects an assertRange step with neither min nor max', async () => {
    const { session } = await makeMoverProject();
    const result = await session.execute('createPlaytest', {
      name: 'bad range',
      scene: 'Main',
      steps: [{ type: 'assertRange', entity: 'Mover', property: 'x' }],
    });
    expect(result.success).toBe(false);
  });
});
