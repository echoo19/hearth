/**
 * Arrow-key nudge accumulator: collapses a burst of nudgeSelection calls into
 * one debounced flush (~300ms), so a held/rapid arrow-key run produces a
 * single `moveEntity` exec (one undo step) instead of one per keypress.
 *
 * Extracted out of store.ts (which held this as bare module-scope
 * `pendingNudge`/`nudgeTimer` variables) into its own factory — mirrors
 * prefabActions.ts's pattern — so the accumulate/flush/clear contract is
 * unit-testable with fake timers, independent of zustand, the DOM, or a live
 * API client. store.ts is now a thin adapter: it owns *what* a flush does
 * (the `moveEntity` exec) and *when* teardown must happen (project close,
 * scene switch); this module owns *how* the burst accumulates and debounces.
 */
import type { Vec2 } from './types';

export interface PendingNudge {
  scene: string;
  entity: string;
  base: Vec2;
  accum: Vec2;
}

export interface NudgeQueue {
  /**
   * Queue a delta for (scene, entity). If a burst is already pending for a
   * *different* (scene, entity), that burst is flushed first (each entity's
   * move stays its own undo step). `base` is only used to seed a fresh burst
   * — it's ignored while extending an existing one, since `base` at that
   * point is the (already-moved) live position, not the burst's origin.
   * Returns the optimistic target position for immediate UI feedback, and
   * (re)arms the debounce timer.
   */
  nudge(input: { scene: string; entity: string; base: Vec2; dx: number; dy: number }): Vec2;
  /** Flush the pending burst synchronously (if any) via the flush callback, and clear the timer. */
  flush(): void;
  /** Drop the pending burst and timer without flushing — no exec fires. */
  clear(): void;
  /** True while a burst is pending (debounce timer armed). */
  isPending(): boolean;
}

/** `onFlush` is called synchronously from `flush()` with the accumulated burst; it owns the actual exec. */
export function createNudgeQueue(onFlush: (pending: PendingNudge) => void, debounceMs = 300): NudgeQueue {
  let pending: PendingNudge | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function stopTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flush(): void {
    stopTimer();
    const p = pending;
    pending = null;
    if (p) onFlush(p);
  }

  function clear(): void {
    stopTimer();
    pending = null;
  }

  return {
    nudge({ scene, entity, base, dx, dy }) {
      if (pending && (pending.entity !== entity || pending.scene !== scene)) {
        flush();
      }
      if (!pending) {
        pending = { scene, entity, base, accum: { x: 0, y: 0 } };
      }
      pending.accum = { x: pending.accum.x + dx, y: pending.accum.y + dy };
      stopTimer();
      timer = setTimeout(flush, debounceMs);
      return { x: pending.base.x + pending.accum.x, y: pending.base.y + pending.accum.y };
    },
    flush,
    clear,
    isPending() {
      return pending !== null;
    },
  };
}
