/**
 * Runtime stdlib — the deterministic building blocks behind ctx v2:
 * seeded RNG (mulberry32), easing functions, and per-entity timer/tween
 * bookkeeping. Headless-safe, no wall clock, no Math.random.
 */

/**
 * Seeded deterministic RNG (mulberry32). Returns a function producing
 * floats in [0, 1). Same seed → same sequence.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type EasingName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

/** Easing functions over normalized t in [0, 1]. */
export const EASINGS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2),
};

/**
 * Resolve a dot path like "Transform.position.x" against a component map
 * to the object holding the final numeric property. Null when the path
 * does not exist or the value is not a number.
 */
export function resolveNumericTarget(
  root: unknown,
  path: string,
): { holder: Record<string, number>; key: string } | null {
  const parts = path.split('.');
  if (parts.length === 0 || parts.some((p) => p.length === 0)) return null;
  let current: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current === null || typeof current !== 'object' || !(parts[i] in current)) return null;
    current = (current as Record<string, unknown>)[parts[i]];
  }
  const key = parts[parts.length - 1];
  if (current === null || typeof current !== 'object') return null;
  if (typeof (current as Record<string, unknown>)[key] !== 'number') return null;
  return { holder: current as Record<string, number>, key };
}

interface TimerEntry {
  id: string;
  /** Seconds until the next fire. */
  remaining: number;
  interval: number;
  repeat: boolean;
  fn: () => void;
}

interface TweenEntry {
  id: string;
  holder: Record<string, number>;
  key: string;
  from: number;
  to: number;
  duration: number;
  elapsed: number;
  easing: (t: number) => number;
  onComplete?: () => void;
}

const EPSILON = 1e-9;

/**
 * Per-entity timer and tween bookkeeping. Owned by one script state and
 * stepped deterministically right before that entity's onUpdate: timers
 * fire first (creation order, at most once per step each), then tweens
 * advance (creation order). Dies with the entity.
 */
export class EntityScheduler {
  private timers: TimerEntry[] = [];
  private tweens: TweenEntry[] = [];
  private seq = 0;

  after(seconds: number, fn: () => void): string {
    const id = `tmr_${++this.seq}`;
    this.timers.push({ id, remaining: Math.max(0, seconds), interval: seconds, repeat: false, fn });
    return id;
  }

  every(seconds: number, fn: () => void): string {
    const id = `tmr_${++this.seq}`;
    this.timers.push({ id, remaining: Math.max(0, seconds), interval: seconds, repeat: true, fn });
    return id;
  }

  cancelTimer(id: string): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  tweenTo(
    holder: Record<string, number>,
    key: string,
    target: number,
    seconds: number,
    easing: (t: number) => number,
    onComplete?: () => void,
  ): string {
    const id = `twn_${++this.seq}`;
    this.tweens.push({
      id,
      holder,
      key,
      from: holder[key],
      to: target,
      duration: Math.max(0, seconds),
      elapsed: 0,
      easing,
      onComplete,
    });
    return id;
  }

  cancelTween(id: string): void {
    this.tweens = this.tweens.filter((t) => t.id !== id);
  }

  /**
   * Advance one fixed step. Timers created during callbacks start on the
   * next step; timers cancelled during callbacks do not fire this step.
   * Callback exceptions are routed to `onError` and never abort the step.
   */
  step(dt: number, onError: (phase: 'timer' | 'tween', err: unknown) => void): void {
    // Timers, creation order. Snapshot: entries added during callbacks wait.
    const dueTimers = this.timers.slice();
    for (const timer of dueTimers) {
      if (!this.timers.includes(timer)) continue; // cancelled mid-step
      timer.remaining -= dt;
      if (timer.remaining > EPSILON) continue;
      if (timer.repeat) {
        // At most one fire per step; short intervals never burst-loop.
        timer.remaining = Math.max(0, timer.remaining + timer.interval);
      } else {
        this.timers = this.timers.filter((t) => t !== timer);
      }
      try {
        timer.fn();
      } catch (err) {
        onError('timer', err);
      }
    }

    // Tweens, creation order.
    const activeTweens = this.tweens.slice();
    for (const tween of activeTweens) {
      if (!this.tweens.includes(tween)) continue; // cancelled mid-step
      tween.elapsed += dt;
      const t = tween.duration <= EPSILON ? 1 : Math.min(1, tween.elapsed / tween.duration);
      tween.holder[tween.key] =
        t >= 1 ? tween.to : tween.from + (tween.to - tween.from) * tween.easing(t);
      if (t >= 1) {
        this.tweens = this.tweens.filter((x) => x !== tween);
        try {
          tween.onComplete?.();
        } catch (err) {
          onError('tween', err);
        }
      }
    }
  }

  clear(): void {
    this.timers = [];
    this.tweens = [];
  }
}
