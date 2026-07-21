/**
 * Steerer — turn a desired world direction into held inputs, using a probed
 * movement basis. Given "I want to go this way", it picks the single basis entry
 * whose measured displacement is best aligned (largest normalized dot product)
 * and holds it. When the best choice changes, it releases the previously held
 * steering input first, so exactly one steering input is active at a time.
 *
 * Every apply flows through the InputRecorder, so a bake can replay the steering
 * verbatim. The Steerer only touches inputs it chose; a policy is free to press
 * other actions (a mash burst, a non-movement tap) around it.
 */
import type { MovementBasis, MovementBasisEntry } from './probe.js';
import type { InputRecorder } from './recorder.js';

/** Minimum vector length before we treat a direction (or basis entry) as meaningful. */
const EPSILON = 1e-6;

/** Stable key for a basis entry, so we can tell whether the choice changed. */
function entryKey(entry: MovementBasisEntry): string {
  return entry.input.kind === 'action'
    ? `action:${entry.input.action}`
    : `axis:${entry.input.axis}:${entry.input.value}`;
}

/**
 * Pick the basis entry best aligned with (dx, dy), or null when the direction is
 * degenerate or no entry points the right way. Alignment is the dot product of
 * unit vectors; only strictly-positive alignment counts (never steer backward).
 * Ties break by basis order, which is deterministic (sorted action/axis names).
 */
export function pickBasis(basis: MovementBasis, dx: number, dy: number): MovementBasisEntry | null {
  const len = Math.hypot(dx, dy);
  if (len < EPSILON) return null;
  const nx = dx / len;
  const ny = dy / len;

  let best: MovementBasisEntry | null = null;
  let bestDot = 0;
  for (const entry of basis.entries) {
    const el = Math.hypot(entry.dx, entry.dy);
    if (el < EPSILON) continue;
    const dot = (entry.dx / el) * nx + (entry.dy / el) * ny;
    if (dot > bestDot) {
      bestDot = dot;
      best = entry;
    }
  }
  return best;
}

export class Steerer {
  private active: MovementBasisEntry | null = null;

  constructor(private readonly basis: MovementBasis) {}

  /**
   * Drive toward (dx, dy). Applies the newly chosen input (and releases the old
   * one) only when the choice changes, so a sustained direction records one hold
   * rather than a hold per frame. A degenerate/backward direction releases.
   */
  steer(input: InputRecorder, dx: number, dy: number): void {
    const choice = pickBasis(this.basis, dx, dy);
    if (choice === null) {
      this.release(input);
      return;
    }
    if (this.active && entryKey(this.active) === entryKey(choice)) return;
    this.release(input);
    this.apply(input, choice);
    this.active = choice;
  }

  /** Release whatever steering input is currently held (no-op when none). */
  release(input: InputRecorder): void {
    if (!this.active) return;
    const held = this.active;
    this.active = null;
    if (held.input.kind === 'action') input.action(held.input.action, false);
    else input.axis(held.input.axis, 0);
  }

  private apply(input: InputRecorder, entry: MovementBasisEntry): void {
    if (entry.input.kind === 'action') input.action(entry.input.action, true);
    else input.axis(entry.input.axis, entry.input.value);
  }
}
