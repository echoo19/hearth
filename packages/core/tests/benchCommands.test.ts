/**
 * benchScene command: parameter/scene resolution and hook wiring. The heavy
 * timing lives in @hearth/playtest (see bench.test.ts); here we inject a fake
 * RuntimeHooks.benchScene and assert the command resolves scenes, defaults to
 * the initial scene, threads params through, and mirrors runScene's errors.
 */
import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  listCommands,
  type ProjectStore,
  type RuntimeHooks,
} from '@hearth/core';

interface BenchCall {
  sceneId: string;
  opts: { frames: number; warmupFrames: number; budgetMs?: number };
}

/** Fake bench hook that records its call and echoes a valid-shaped summary. */
function fakeBenchHooks(): { runtime: RuntimeHooks; calls: BenchCall[] } {
  const calls: BenchCall[] = [];
  const runtime: RuntimeHooks = {
    benchScene: async (_store, sceneId, opts) => {
      calls.push({ sceneId, opts });
      return {
        scene: sceneId,
        sceneName: 'Main',
        frames: opts.frames,
        entityCount: 3,
        avgMs: 1,
        medianMs: 1,
        p95Ms: 1,
        maxMs: 1,
        totalMs: opts.frames,
        scriptErrors: 0,
        suggestions: [],
        ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs, withinBudget: true } : {}),
      };
    },
  };
  return { runtime, calls };
}

async function makeSession(runtime?: RuntimeHooks): Promise<{ store: ProjectStore; session: HearthSession }> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Bench Game' });
  const session = HearthSession.fromStore(store, { runtime });
  return { store, session };
}

describe('benchScene registry', () => {
  it('is registered as a read-only, non-mutating command', () => {
    const def = listCommands().find((c) => c.name === 'benchScene');
    expect(def).toBeDefined();
    expect(def!.permission).toBe('read-only');
    expect(def!.mutates).toBe(false);
  });
});

describe('benchScene command', () => {
  it('defaults to the project initial scene when no scene is given', async () => {
    const { store, session } = await makeSession(fakeBenchHooks().runtime);
    const result = await session.execute<any>('benchScene', {});
    expect(result.success).toBe(true);
    // Resolved to the initial scene's id.
    expect(result.data.scene).toBe(store.project.initialScene);
  });

  it('resolves a scene by name to its id and applies defaults', async () => {
    const { runtime, calls } = fakeBenchHooks();
    const { store, session } = await makeSession(runtime);
    const result = await session.execute<any>('benchScene', { scene: 'Main' });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sceneId).toBe(store.project.initialScene);
    // Default frames/warmupFrames.
    expect(calls[0].opts.frames).toBe(600);
    expect(calls[0].opts.warmupFrames).toBe(60);
    expect(calls[0].opts.budgetMs).toBeUndefined();
  });

  it('threads frames/warmupFrames/budgetMs to the hook', async () => {
    const { runtime, calls } = fakeBenchHooks();
    const { session } = await makeSession(runtime);
    const result = await session.execute<any>('benchScene', {
      scene: 'Main',
      frames: 120,
      warmupFrames: 10,
      budgetMs: 16.67,
    });
    expect(result.success).toBe(true);
    expect(calls[0].opts).toEqual({ frames: 120, warmupFrames: 10, budgetMs: 16.67 });
    expect(result.data.withinBudget).toBe(true);
  });

  it('errors NOT_FOUND for an unknown scene (matches runScene)', async () => {
    const { session } = await makeSession(fakeBenchHooks().runtime);
    const result = await session.execute('benchScene', { scene: 'NotAScene' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
    expect(result.errors[0].message).toContain('Scene not found');
  });

  it('errors INVALID_INPUT when the runtime hook is not injected', async () => {
    const { session } = await makeSession(); // no runtime
    const result = await session.execute('benchScene', { scene: 'Main' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });

  it('rejects frames above the cap', async () => {
    const { session } = await makeSession(fakeBenchHooks().runtime);
    const result = await session.execute('benchScene', { scene: 'Main', frames: 100000 });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_PARAMS');
  });

  it('rejects a negative warmupFrames', async () => {
    const { session } = await makeSession(fakeBenchHooks().runtime);
    const result = await session.execute('benchScene', { scene: 'Main', warmupFrames: -1 });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_PARAMS');
  });
});
