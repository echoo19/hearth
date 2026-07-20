/**
 * Scene benchmark: pure-stats unit tests (deterministic, timing-free) plus a
 * small integration run against a real starter scene. Per CI-flakiness policy
 * we never assert wall-clock thresholds — only structure, counts, and the
 * synthetic-sample stats.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject } from '@hearth/core';
import {
  benchScene,
  summarizeBench,
  percentile,
  FRAME_BUDGET_60FPS_MS,
} from '../src/bench.js';

describe('percentile (nearest-rank)', () => {
  it('empty array is 0', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 95)).toBe(0);
  });

  it('odd-length array', () => {
    const s = [1, 2, 3, 4, 5];
    expect(percentile(s, 50)).toBe(3); // ceil(2.5)=3 -> idx 2
    expect(percentile(s, 95)).toBe(5); // ceil(4.75)=5 -> idx 4
    expect(percentile(s, 100)).toBe(5);
  });

  it('even-length array', () => {
    const s = [10, 20, 30, 40];
    expect(percentile(s, 50)).toBe(20); // ceil(2)=2 -> idx 1
    expect(percentile(s, 95)).toBe(40); // ceil(3.8)=4 -> idx 3
  });

  it('clamps the low end to the first element', () => {
    expect(percentile([7, 8, 9], 0)).toBe(7); // rank clamps to 1 -> idx 0
  });
});

describe('summarizeBench', () => {
  it('computes avg/median/p95/max/total over samples', () => {
    const r = summarizeBench({
      scene: 'scn_1',
      sceneName: 'Main',
      entityCount: 3,
      samples: [1, 2, 3, 4, 5],
      scriptErrors: 0,
    });
    expect(r.frames).toBe(5);
    expect(r.avgMs).toBe(3);
    expect(r.medianMs).toBe(3);
    expect(r.p95Ms).toBe(5);
    expect(r.maxMs).toBe(5);
    expect(r.totalMs).toBe(15);
    expect(r.entityCount).toBe(3);
    expect(r.scriptErrors).toBe(0);
  });

  it('omits budgetMs/withinBudget when no budget is given', () => {
    const r = summarizeBench({ scene: 's', sceneName: 'S', entityCount: 0, samples: [5, 5, 5], scriptErrors: 0 });
    expect(r.budgetMs).toBeUndefined();
    expect(r.withinBudget).toBeUndefined();
  });

  it('withinBudget true when median <= budgetMs', () => {
    const r = summarizeBench({ scene: 's', sceneName: 'S', entityCount: 0, samples: [1, 2, 3, 4, 5], budgetMs: 4, scriptErrors: 0 });
    expect(r.budgetMs).toBe(4);
    expect(r.withinBudget).toBe(true); // median 3 <= 4
  });

  it('withinBudget false when median > budgetMs', () => {
    const r = summarizeBench({ scene: 's', sceneName: 'S', entityCount: 0, samples: [1, 2, 3, 4, 5], budgetMs: 2, scriptErrors: 0 });
    expect(r.withinBudget).toBe(false); // median 3 > 2
  });

  it('adds a 60fps suggestion only when median exceeds 16.67ms', () => {
    const fast = summarizeBench({ scene: 's', sceneName: 'S', entityCount: 0, samples: [1, 2, 3], scriptErrors: 0 });
    expect(fast.suggestions).toEqual([]);

    const slow = summarizeBench({ scene: 's', sceneName: 'S', entityCount: 0, samples: [20, 20, 20], scriptErrors: 0 });
    expect(slow.suggestions).toHaveLength(1);
    expect(slow.suggestions[0]).toContain('16.67ms');
    expect(slow.suggestions[0]).toContain('60fps');
  });

  it('exposes the 60fps frame budget constant', () => {
    expect(FRAME_BUDGET_60FPS_MS).toBeCloseTo(16.6667, 3);
  });

  it('handles zero samples without dividing by zero', () => {
    const r = summarizeBench({ scene: 's', sceneName: 'S', entityCount: 0, samples: [], scriptErrors: 0 });
    expect(r.frames).toBe(0);
    expect(r.avgMs).toBe(0);
    expect(r.medianMs).toBe(0);
    expect(r.p95Ms).toBe(0);
    expect(r.maxMs).toBe(0);
    expect(r.totalMs).toBe(0);
  });
});

describe('benchScene (integration, no wall-clock assertions)', () => {
  async function starterStore() {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Bench Game' });
    return store;
  }

  it('returns a full summary with every field present', async () => {
    const store = await starterStore();
    const r = await benchScene(store, 'Main', { frames: 5, warmupFrames: 3 });
    expect(r.scene).toBeTruthy();
    expect(r.sceneName).toBe('Main');
    expect(r.frames).toBe(5);
    expect(r.entityCount).toBeGreaterThan(0);
    expect(r.avgMs).toBeGreaterThanOrEqual(0);
    expect(r.medianMs).toBeGreaterThanOrEqual(0);
    expect(r.p95Ms).toBeGreaterThanOrEqual(0);
    expect(r.maxMs).toBeGreaterThanOrEqual(0);
    expect(r.totalMs).toBeGreaterThanOrEqual(0);
    expect(r.scriptErrors).toBe(0);
    expect(Array.isArray(r.suggestions)).toBe(true);
  });

  it('measures exactly `frames` frames regardless of warmup', async () => {
    const store = await starterStore();
    const withWarmup = await benchScene(store, 'Main', { frames: 4, warmupFrames: 10 });
    const noWarmup = await benchScene(await starterStore(), 'Main', { frames: 4, warmupFrames: 0 });
    expect(withWarmup.frames).toBe(4);
    expect(noWarmup.frames).toBe(4);
  });

  it('threads budgetMs through to withinBudget', async () => {
    const store = await starterStore();
    const r = await benchScene(store, 'Main', { frames: 3, warmupFrames: 1, budgetMs: 16.67 });
    expect(r.budgetMs).toBe(16.67);
    expect(typeof r.withinBudget).toBe('boolean');
  });
});
