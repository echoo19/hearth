/**
 * sweepScene + bakePlaytest commands: parameter defaults, scene resolution,
 * the frame budget guard, journaling, and the shared persist path. The heavy
 * bot execution lives in @hearth/playtest (see sweep.test.ts); here we inject
 * fake RuntimeHooks and assert the command wiring around them.
 */
import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  listCommands,
  type ProjectStore,
  type RuntimeHooks,
  type SweepParams,
  type BakeParams,
} from '@hearth/core';

/** Fake sweep/bake hooks that record their calls and echo valid-shaped data. */
function fakeHooks(): {
  runtime: RuntimeHooks;
  sweepCalls: SweepParams[];
  bakeCalls: BakeParams[];
} {
  const sweepCalls: SweepParams[] = [];
  const bakeCalls: BakeParams[] = [];
  const runtime: RuntimeHooks = {
    sweepScene: async (_store, params) => {
      sweepCalls.push(params);
      return {
        scene: 'main',
        runs: params.policies.length * params.seeds,
        framesSimulated: 100,
        wallMs: 3,
        verdicts: { 'ran-clean': 1, stuck: 0, error: 0, completed: 0, 'objective-failed': 0 },
        objectives: [],
        failures: [],
        ...(params.heatmap ? { heatmap: '##\n..' } : {}),
        reportFile: '.hearth/sweeps/main-0001.json',
      };
    },
    bakeBotRun: async (_store, params) => {
      bakeCalls.push(params);
      return {
        steps: [
          { type: 'setAction', action: 'right', down: true, frames: 1 },
          { type: 'wait', frames: 5 },
          { type: 'assertNoErrors' },
        ],
        seed: params.seed,
      };
    },
  };
  return { runtime, sweepCalls, bakeCalls };
}

async function makeSession(
  runtime?: RuntimeHooks,
): Promise<{ store: ProjectStore; session: HearthSession }> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Sweep Game' });
  const session = HearthSession.fromStore(store, { runtime, source: 'cli' });
  return { store, session };
}

describe('sweep command registry', () => {
  it('registers sweepScene and bakePlaytest for a total of 79 commands', () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toContain('sweepScene');
    expect(names).toContain('bakePlaytest');
    expect(names.length).toBe(79);
  });

  it('sweepScene is read-only and non-mutating', () => {
    const def = listCommands().find((c) => c.name === 'sweepScene');
    expect(def!.permission).toBe('read-only');
    expect(def!.mutates).toBe(false);
  });

  it('bakePlaytest is safe-edit and mutating', () => {
    const def = listCommands().find((c) => c.name === 'bakePlaytest');
    expect(def!.permission).toBe('safe-edit');
    expect(def!.mutates).toBe(true);
  });
});

describe('sweepScene command', () => {
  it('defaults to the project initial scene and applies param defaults', async () => {
    const { runtime, sweepCalls } = fakeHooks();
    const { store, session } = await makeSession(runtime);
    const result = await session.execute<any>('sweepScene', {});
    expect(result.success).toBe(true);
    expect(sweepCalls).toHaveLength(1);
    expect(sweepCalls[0].scene).toBe(store.project.initialScene);
    expect(sweepCalls[0].policies).toEqual(['mash']);
    expect(sweepCalls[0].seeds).toBe(8);
    expect(sweepCalls[0].seedStart).toBe(0);
    expect(sweepCalls[0].maxFrames).toBe(600);
    expect(sweepCalls[0].stuckAfter).toBe(180);
    expect(sweepCalls[0].heatmap).toBe(false);
  });

  it('resolves a scene by name to its id', async () => {
    const { runtime, sweepCalls } = fakeHooks();
    const { store, session } = await makeSession(runtime);
    const result = await session.execute<any>('sweepScene', { scene: 'Main' });
    expect(result.success).toBe(true);
    expect(sweepCalls[0].scene).toBe(store.project.initialScene);
  });

  it('records the report file on the result changed[]', async () => {
    const { runtime } = fakeHooks();
    const { session } = await makeSession(runtime);
    const result = await session.execute<any>('sweepScene', { scene: 'Main' });
    expect(result.data.reportFile).toBe('.hearth/sweeps/main-0001.json');
    expect(result.changed).toContainEqual({
      kind: 'file',
      path: '.hearth/sweeps/main-0001.json',
      action: 'created',
    });
  });

  it('omits the heatmap by default and includes it when requested', async () => {
    const { runtime } = fakeHooks();
    const { session } = await makeSession(runtime);
    const off = await session.execute<any>('sweepScene', { scene: 'Main' });
    expect(off.data.heatmap).toBeUndefined();
    const on = await session.execute<any>('sweepScene', { scene: 'Main', heatmap: true });
    expect(typeof on.data.heatmap).toBe('string');
  });

  it('fails the budget guard before running when frames exceed the cap', async () => {
    const { runtime, sweepCalls } = fakeHooks();
    const { session } = await makeSession(runtime);
    // 2 policies × 400 seeds × 600 frames = 480000 > 400000.
    const result = await session.execute('sweepScene', {
      scene: 'Main',
      policies: ['mash', 'idle'],
      seeds: 400,
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
    expect(result.errors[0].message).toContain('budget');
    // The guard fired before the hook was ever consulted.
    expect(sweepCalls).toHaveLength(0);
  });

  it('errors INVALID_INPUT when the runtime hook is not injected', async () => {
    const { session } = await makeSession();
    const result = await session.execute('sweepScene', { scene: 'Main' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });

  it('errors NOT_FOUND for an unknown scene', async () => {
    const { runtime } = fakeHooks();
    const { session } = await makeSession(runtime);
    const result = await session.execute('sweepScene', { scene: 'Nope' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
  });

  it('journals a sweep with {scene, runs, verdicts} detail', async () => {
    const { runtime } = fakeHooks();
    const { session } = await makeSession(runtime);
    await session.execute('sweepScene', { scene: 'Main' });
    const journal = await session.execute<any>('listJournal', {});
    const entry = journal.data.entries.find((e: any) => e.command === 'sweepScene');
    expect(entry).toBeDefined();
    expect(entry.detail).toEqual({
      scene: 'main',
      runs: 8,
      verdicts: { 'ran-clean': 1, stuck: 0, error: 0, completed: 0, 'objective-failed': 0 },
    });
  });
});

describe('bakePlaytest command', () => {
  it('persists a playtest through the shared path with the run seed', async () => {
    const { runtime, bakeCalls } = fakeHooks();
    const { store, session } = await makeSession(runtime);
    const result = await session.execute<any>('bakePlaytest', {
      name: 'crash-seed-4',
      scene: 'Main',
      policy: 'mash',
      seed: 4,
    });
    expect(result.success).toBe(true);
    expect(bakeCalls[0].seed).toBe(4);
    // The playtest landed in the store with the baked steps and seed.
    const pt = store.getPlaytest('crash-seed-4');
    expect(pt).toBeDefined();
    expect(pt!.seed).toBe(4);
    expect(pt!.steps.length).toBe(3);
    // A playtest file was written (mutating command).
    expect(result.files.some((f: string) => f.endsWith('.playtest.json'))).toBe(true);
  });

  it('rejects a duplicate playtest name', async () => {
    const { runtime } = fakeHooks();
    const { session } = await makeSession(runtime);
    await session.execute('bakePlaytest', { name: 'dupe', scene: 'Main', policy: 'mash', seed: 0 });
    const again = await session.execute('bakePlaytest', {
      name: 'dupe',
      scene: 'Main',
      policy: 'mash',
      seed: 0,
    });
    expect(again.success).toBe(false);
    expect(again.errors[0].code).toBe('CONFLICT');
  });

  it('errors INVALID_INPUT when the runtime hook is not injected', async () => {
    const { session } = await makeSession();
    const result = await session.execute('bakePlaytest', {
      name: 'x',
      scene: 'Main',
      policy: 'mash',
      seed: 0,
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });

  it('journals a bake with {name, scene, policy, seed} detail from params', async () => {
    const { runtime } = fakeHooks();
    const { session } = await makeSession(runtime);
    await session.execute('bakePlaytest', {
      name: 'baked',
      scene: 'Main',
      policy: 'mash',
      seed: 2,
    });
    const journal = await session.execute<any>('listJournal', {});
    const entry = journal.data.entries.find((e: any) => e.command === 'bakePlaytest');
    // detail.scene is the param as passed (unresolved 'Main'), not the id.
    expect(entry.detail).toEqual({ name: 'baked', scene: 'Main', policy: 'mash', seed: 2 });
  });
});
