/**
 * particlePreview.ts is the Scene view's editor-only live particle preview:
 * a real-time rAF ticker (fixed-dt accumulated) driving the pure
 * `EmitterState` stepper for whichever emitter is currently selected. These
 * tests drive the ticker with a fake clock (no real timers) and a
 * synchronous fake runtime loader (no real dynamic-import timing), so the
 * whole suite stays deterministic — same discipline as particles.ts itself
 * (no Math.random/Date.now).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createComponent } from '@hearth/core';
import { EmitterState } from '@hearth/runtime';
import { ParticlePreview, particleVisual, type PreviewTarget } from '../src/particlePreview';

/** Records requestFrame/cancelFrame calls; `fire(t)` synchronously invokes whatever is currently pending. */
function makeFakeClock() {
  let nextHandle = 1;
  const pending = new Map<number, (t: number) => void>();
  return {
    clock: {
      requestFrame(cb: (t: number) => void): number {
        const handle = nextHandle++;
        pending.set(handle, cb);
        return handle;
      },
      cancelFrame(handle: number): void {
        pending.delete(handle);
      },
    },
    pendingCount: () => pending.size,
    /** Fire every callback pending right now (there's normally at most one — the ticker re-requests exactly one frame per tick). */
    fire(t: number): void {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, cb] of entries) cb(t);
    },
  };
}

/** Synchronous fake for the dynamic `import('@hearth/runtime')` — resolves on a microtask, using the real EmitterState. */
function makeFakeRuntimeLoader() {
  let calls = 0;
  return {
    calls: () => calls,
    loadRuntime: async () => {
      calls++;
      return { EmitterState };
    },
  };
}

function makeEmitter(overrides: Record<string, unknown> = {}) {
  return createComponent('ParticleEmitter', overrides);
}

function makeTarget(entityId: string, overrides: Record<string, unknown> = {}): PreviewTarget {
  return { entityId, emitter: makeEmitter(overrides), origin: { x: 0, y: 0 } };
}

/** Advance the preview by one fixed step (60fps cadence): first fire() only establishes the time origin. */
async function stepOnce(fake: ReturnType<typeof makeFakeClock>, preview: ParticlePreview, tMs: number): Promise<void> {
  fake.fire(tMs);
  await Promise.resolve();
  await Promise.resolve();
}

describe('ParticlePreview gating', () => {
  let fake: ReturnType<typeof makeFakeClock>;
  let loader: ReturnType<typeof makeFakeRuntimeLoader>;
  let preview: ParticlePreview;

  beforeEach(() => {
    fake = makeFakeClock();
    loader = makeFakeRuntimeLoader();
    preview = new ParticlePreview({ clock: fake.clock, loadRuntime: loader.loadRuntime });
  });

  it('is inactive and not running with nothing selected, panel hidden, default state', () => {
    expect(preview.isActive()).toBe(false);
    expect(preview.isRunning()).toBe(false);
    expect(fake.pendingCount()).toBe(0);
  });

  it('does not start when only visible (no targets)', () => {
    preview.setVisible(true);
    expect(preview.isActive()).toBe(false);
    expect(preview.isRunning()).toBe(false);
  });

  it('starts once visible + toggle on + a target is set, after the runtime loader resolves', async () => {
    preview.setVisible(true);
    preview.setTargets([makeTarget('e1')]);
    expect(preview.isActive()).toBe(true);
    // Not running yet: EmitterState ctor loads asynchronously.
    await Promise.resolve();
    await Promise.resolve();
    expect(preview.isRunning()).toBe(true);
    expect(loader.calls()).toBe(1);
  });

  it('stops when the panel becomes hidden', async () => {
    preview.setVisible(true);
    preview.setTargets([makeTarget('e1')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(preview.isRunning()).toBe(true);

    preview.setVisible(false);
    expect(preview.isRunning()).toBe(false);
    expect(fake.pendingCount()).toBe(0);
  });

  it('stops when the toggle is switched off, and resumes when switched back on', async () => {
    preview.setVisible(true);
    preview.setTargets([makeTarget('e1')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(preview.isRunning()).toBe(true);

    preview.setToggleEnabled(false);
    expect(preview.isActive()).toBe(false);
    expect(preview.isRunning()).toBe(false);

    preview.setToggleEnabled(true);
    expect(preview.isRunning()).toBe(true);
  });

  it('stops when the selection is cleared (no targets)', async () => {
    preview.setVisible(true);
    preview.setTargets([makeTarget('e1')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(preview.isRunning()).toBe(true);

    preview.setTargets([]);
    expect(preview.isActive()).toBe(false);
    expect(preview.isRunning()).toBe(false);
  });

  it('only loads the runtime module once across repeated target churn', async () => {
    preview.setVisible(true);
    preview.setTargets([makeTarget('e1')]);
    await Promise.resolve();
    await Promise.resolve();
    preview.setTargets([]);
    preview.setTargets([makeTarget('e1')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(loader.calls()).toBe(1);
  });

  it('dispose() stops the ticker and clears listeners', async () => {
    preview.setVisible(true);
    preview.setTargets([makeTarget('e1')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(preview.isRunning()).toBe(true);

    preview.dispose();
    expect(preview.isRunning()).toBe(false);
    expect(fake.pendingCount()).toBe(0);
  });
});

describe('ParticlePreview determinism', () => {
  it('identical seed + config + frame sequence produce identical particle snapshots', async () => {
    const fakeA = makeFakeClock();
    const fakeB = makeFakeClock();
    const loaderA = makeFakeRuntimeLoader();
    const loaderB = makeFakeRuntimeLoader();
    const a = new ParticlePreview({ clock: fakeA.clock, loadRuntime: loaderA.loadRuntime });
    const b = new ParticlePreview({ clock: fakeB.clock, loadRuntime: loaderB.loadRuntime });

    const overrides = { seed: 42, rate: 30, burst: 4, lifetime: 1, speed: 80, spread: 45, gravity: { x: 0, y: 40 } };
    a.setVisible(true);
    b.setVisible(true);
    a.setTargets([makeTarget('emitter', overrides)]);
    b.setTargets([makeTarget('emitter', overrides)]);
    await Promise.resolve();
    await Promise.resolve();

    // Drive both through the same sequence of frame timestamps at 60fps.
    for (let i = 0; i <= 10; i++) {
      const t = (1000 / 60) * i;
      fakeA.fire(t);
      fakeB.fire(t);
    }

    expect(a.getPreviewParticles('emitter')).toEqual(b.getPreviewParticles('emitter'));
    expect(a.getPreviewParticles('emitter').length).toBeGreaterThan(0);
  });
});

describe('ParticlePreview reset-on-edit', () => {
  let fake: ReturnType<typeof makeFakeClock>;
  let loader: ReturnType<typeof makeFakeRuntimeLoader>;
  let preview: ParticlePreview;

  beforeEach(() => {
    fake = makeFakeClock();
    loader = makeFakeRuntimeLoader();
    preview = new ParticlePreview({ clock: fake.clock, loadRuntime: loader.loadRuntime });
    preview.setVisible(true);
  });

  async function warmUp(entityId: string, overrides: Record<string, unknown> = {}) {
    preview.setTargets([makeTarget(entityId, overrides)]);
    await Promise.resolve();
    await Promise.resolve();
    for (let i = 0; i <= 5; i++) fake.fire((1000 / 60) * i);
  }

  it('changing an emitter field resets that emitter to a fresh EmitterState (particles clear, autoBurst refires)', async () => {
    await warmUp('e1', { seed: 1, rate: 30, burst: 5, lifetime: 5 });
    const before = preview.getPreviewParticles('e1');
    expect(before.length).toBeGreaterThan(0);

    // Same entity, gravity changed and rate dropped to 0 (isolates the
    // post-reset assertion to the burst count only, avoiding having to
    // reason about exact rate-accumulator timing) — a fresh component
    // object, as the store hands SceneView after every edit.
    preview.setTargets([makeTarget('e1', { seed: 1, rate: 0, burst: 5, lifetime: 5, gravity: { x: 5, y: 5 } })]);
    const afterReset = preview.getPreviewParticles('e1');
    expect(afterReset).toEqual([]);

    // A couple of clean incremental ticks (not one huge jump, which the
    // catch-up cap would clamp) — burst fires once on the first of these,
    // rate is 0 so the count stays exactly at `burst` from then on.
    let t = (1000 / 60) * 5;
    for (let i = 1; i <= 3; i++) {
      t += 1000 / 60;
      fake.fire(t);
    }
    expect(preview.getPreviewParticles('e1').length).toBe(5); // burst: 5, fresh state
  });

  it('an unrelated re-render with a value-identical (but reference-different) emitter object does NOT reset', async () => {
    await warmUp('e1', { seed: 3, rate: 20, burst: 6, lifetime: 5 });
    const before = preview.getPreviewParticles('e1');
    expect(before.length).toBeGreaterThan(0);

    // Simulate the editor's full-scene refetch: a brand-new object, same values.
    preview.setTargets([makeTarget('e1', { seed: 3, rate: 20, burst: 6, lifetime: 5 })]);
    expect(preview.getPreviewParticles('e1')).toBe(before); // same array reference — no reset happened
  });

  it('resets only the changed emitter, leaving a second tracked emitter untouched', async () => {
    preview.setTargets([makeTarget('e1', { seed: 1, rate: 10, burst: 4, lifetime: 5 }), makeTarget('e2', { seed: 2, rate: 10, burst: 7, lifetime: 5 })]);
    await Promise.resolve();
    await Promise.resolve();
    for (let i = 0; i <= 5; i++) fake.fire((1000 / 60) * i);

    const e2Before = preview.getPreviewParticles('e2');
    expect(e2Before.length).toBeGreaterThan(0);

    preview.setTargets([
      makeTarget('e1', { seed: 1, rate: 10, burst: 4, lifetime: 5, direction: 90 }), // changed
      makeTarget('e2', { seed: 2, rate: 10, burst: 7, lifetime: 5 }), // unchanged
    ]);

    expect(preview.getPreviewParticles('e1')).toEqual([]); // reset
    expect(preview.getPreviewParticles('e2')).toBe(e2Before); // untouched, same reference
  });

  it('an origin-only change (e.g. a live drag) does NOT reset the emitter: existing particles keep simulating, new ones spawn from the new origin', async () => {
    // speed: 0 + gravity: 0 so already-spawned particles never move — any
    // position drift can only come from where they were spawned, isolating
    // the "old particles keep their old spawn point" half of the assertion.
    const overrides = { seed: 1, rate: 30, burst: 3, lifetime: 5, speed: 0, gravity: { x: 0, y: 0 } };
    await warmUp('e1', overrides);
    const before = preview.getPreviewParticles('e1');
    expect(before.length).toBeGreaterThan(0);
    const beforeCount = before.length;
    for (const p of before) {
      expect(p.x).toBe(0);
      expect(p.y).toBe(0);
    }

    // Simulate SceneView's drag effect: a fresh, value-identical emitter
    // object (same as an unrelated re-render) but a moved world origin.
    preview.setTargets([{ entityId: 'e1', emitter: makeEmitter(overrides), origin: { x: 100, y: 50 } }]);

    // No reset: same array reference, same particles, still at the old spot.
    const afterTargetsUpdate = preview.getPreviewParticles('e1');
    expect(afterTargetsUpdate).toBe(before);
    for (const p of afterTargetsUpdate) {
      expect(p.x).toBe(0);
      expect(p.y).toBe(0);
    }

    // Step forward: rate-spawned particles now appear at the NEW origin,
    // while the pre-existing ones are untouched (still at the old spot).
    let t = (1000 / 60) * 5;
    for (let i = 1; i <= 5; i++) {
      t += 1000 / 60;
      fake.fire(t);
    }
    const after = preview.getPreviewParticles('e1');
    expect(after.length).toBeGreaterThan(beforeCount);
    for (const p of after.slice(0, beforeCount)) {
      expect(p.x).toBe(0);
      expect(p.y).toBe(0);
    }
    for (const p of after.slice(beforeCount)) {
      expect(p.x).toBe(100);
      expect(p.y).toBe(50);
    }
  });

  it('changing an emitter field AND the origin at the same time resets once, and the fresh burst spawns from the new origin', async () => {
    // speed: 0 + gravity: 0 again, so the fresh burst's particles don't
    // drift off origin during the one step() that runs right after burst()
    // fires within the same tick (see stepAll) — isolates this assertion to
    // spawn position only.
    await warmUp('e1', { seed: 1, rate: 0, burst: 4, lifetime: 5, speed: 0, gravity: { x: 0, y: 0 } });
    const before = preview.getPreviewParticles('e1');
    expect(before.length).toBeGreaterThan(0);

    preview.setTargets([
      {
        entityId: 'e1',
        emitter: makeEmitter({ seed: 1, rate: 0, burst: 6, lifetime: 5, speed: 0, gravity: { x: 0, y: 0 } }),
        origin: { x: 100, y: 0 },
      },
    ]);
    expect(preview.getPreviewParticles('e1')).toEqual([]); // reset

    // One clean tick fires the fresh burst (burst: 6) at the new origin.
    let t = (1000 / 60) * 5;
    t += 1000 / 60;
    fake.fire(t);
    const after = preview.getPreviewParticles('e1');
    expect(after.length).toBe(6);
    for (const p of after) {
      expect(p.x).toBe(100);
      expect(p.y).toBe(0);
    }
  });
});

describe('particleVisual', () => {
  it('interpolates size, color, and alpha from age/lifetime, matching Pixi\'s updateParticles formula', () => {
    const emitter = makeEmitter({ startSize: 10, endSize: 0, startColor: '#ff0000', endColor: '#0000ff' });
    const start = particleVisual({ x: 1, y: 2, vx: 0, vy: 0, age: 0, lifetime: 2 }, emitter);
    expect(start).toEqual({ x: 1, y: 2, radius: 5, color: '#ff0000', alpha: 1 });

    const mid = particleVisual({ x: 0, y: 0, vx: 0, vy: 0, age: 1, lifetime: 2 }, emitter);
    expect(mid?.radius).toBeCloseTo(2.5);
    expect(mid?.color).toBe('#800080');
    expect(mid?.alpha).toBeCloseTo(0.875);
  });

  it('returns null once interpolated size reaches zero (skip rendering, matching updateParticles)', () => {
    const emitter = makeEmitter({ startSize: 4, endSize: 0 });
    const end = particleVisual({ x: 0, y: 0, vx: 0, vy: 0, age: 2, lifetime: 2 }, emitter);
    expect(end).toBeNull();
  });
});
