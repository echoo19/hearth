/**
 * Contract tests for the nudge-burst accumulator extracted from store.ts's
 * nudgeSelection (Task 8 review fix): a burst of nudge() calls must collapse
 * into exactly ONE flush with the accumulated delta after the debounce
 * window, and teardown (flush/clear) must behave correctly regardless of
 * whether a burst is in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNudgeQueue } from '../src/nudgeQueue';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createNudgeQueue: debounce contract', () => {
  it('collapses a burst of nudges into exactly one flush after ~300ms, with the accumulated delta', () => {
    const onFlush = vi.fn();
    const queue = createNudgeQueue(onFlush);

    queue.nudge({ scene: 'sceneA', entity: 'e1', base: { x: 10, y: 20 }, dx: 1, dy: 0 });
    vi.advanceTimersByTime(100);
    queue.nudge({ scene: 'sceneA', entity: 'e1', base: { x: 10, y: 20 }, dx: 1, dy: 0 });
    vi.advanceTimersByTime(100);
    queue.nudge({ scene: 'sceneA', entity: 'e1', base: { x: 10, y: 20 }, dx: 0, dy: -10 });

    // Still well within the debounce window of the last nudge — no flush yet.
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({
      scene: 'sceneA',
      entity: 'e1',
      base: { x: 10, y: 20 },
      accum: { x: 2, y: -10 },
    });
  });

  it('does not flush before the debounce window elapses', () => {
    const onFlush = vi.fn();
    const queue = createNudgeQueue(onFlush);
    queue.nudge({ scene: 's', entity: 'e', base: { x: 0, y: 0 }, dx: 1, dy: 0 });
    vi.advanceTimersByTime(299);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('a new burst for a different entity flushes the prior one first (separate undo steps)', () => {
    const calls: unknown[] = [];
    const queue = createNudgeQueue((p) => calls.push(p));

    queue.nudge({ scene: 'sceneA', entity: 'e1', base: { x: 0, y: 0 }, dx: 1, dy: 0 });
    vi.advanceTimersByTime(50);
    queue.nudge({ scene: 'sceneA', entity: 'e2', base: { x: 5, y: 5 }, dx: 0, dy: 1 });

    // e1's burst flushed immediately (synchronously) when e2's nudge arrived.
    expect(calls).toEqual([{ scene: 'sceneA', entity: 'e1', base: { x: 0, y: 0 }, accum: { x: 1, y: 0 } }]);

    vi.advanceTimersByTime(300);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ scene: 'sceneA', entity: 'e2', base: { x: 5, y: 5 }, accum: { x: 0, y: 1 } });
  });

  it('a new burst for a different scene (same entity id) also flushes the prior one first', () => {
    const calls: unknown[] = [];
    const queue = createNudgeQueue((p) => calls.push(p));
    queue.nudge({ scene: 'sceneA', entity: 'e1', base: { x: 0, y: 0 }, dx: 1, dy: 0 });
    queue.nudge({ scene: 'sceneB', entity: 'e1', base: { x: 9, y: 9 }, dx: 0, dy: 1 });
    expect(calls).toEqual([{ scene: 'sceneA', entity: 'e1', base: { x: 0, y: 0 }, accum: { x: 1, y: 0 } }]);
  });

  it('nudge() returns the running optimistic target position', () => {
    const queue = createNudgeQueue(() => {});
    const p1 = queue.nudge({ scene: 's', entity: 'e', base: { x: 10, y: 10 }, dx: 1, dy: 0 });
    expect(p1).toEqual({ x: 11, y: 10 });
    const p2 = queue.nudge({ scene: 's', entity: 'e', base: { x: 999, y: 999 }, dx: 1, dy: 0 });
    // Still the same burst (same scene/entity): base is NOT re-seeded from
    // the second call's (already-moved) base — only the first nudge's base
    // anchors the whole burst.
    expect(p2).toEqual({ x: 12, y: 10 });
  });
});

describe('createNudgeQueue: teardown (flush-or-clear)', () => {
  it('flush() with no pending burst is a no-op', () => {
    const onFlush = vi.fn();
    const queue = createNudgeQueue(onFlush);
    queue.flush();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('flush() lands the pending burst synchronously and cancels the timer (scene-switch case)', () => {
    const onFlush = vi.fn();
    const queue = createNudgeQueue(onFlush);
    queue.nudge({ scene: 'sceneA', entity: 'e1', base: { x: 0, y: 0 }, dx: 5, dy: 5 });
    queue.flush();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(queue.isPending()).toBe(false);

    // The debounce timer that would have fired the burst is cancelled — no
    // second flush later.
    vi.advanceTimersByTime(1000);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('clear() drops a pending burst without ever calling onFlush (project-close case)', () => {
    const onFlush = vi.fn();
    const queue = createNudgeQueue(onFlush);
    queue.nudge({ scene: 'sceneA', entity: 'e1', base: { x: 0, y: 0 }, dx: 5, dy: 5 });
    queue.clear();
    expect(queue.isPending()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('clear() with no pending burst is a no-op', () => {
    const onFlush = vi.fn();
    const queue = createNudgeQueue(onFlush);
    queue.clear();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('a fresh nudge after clear() starts an independent burst', () => {
    const calls: unknown[] = [];
    const queue = createNudgeQueue((p) => calls.push(p));
    queue.nudge({ scene: 'sceneA', entity: 'e1', base: { x: 0, y: 0 }, dx: 5, dy: 5 });
    queue.clear();
    queue.nudge({ scene: 'sceneA', entity: 'e1', base: { x: 100, y: 100 }, dx: 1, dy: 1 });
    vi.advanceTimersByTime(300);
    expect(calls).toEqual([{ scene: 'sceneA', entity: 'e1', base: { x: 100, y: 100 }, accum: { x: 1, y: 1 } }]);
  });
});
