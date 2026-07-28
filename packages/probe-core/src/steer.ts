/**
 * Steerer — turn a desired world direction into held inputs, using a probed
 * movement basis. Given "I want to go this way", it picks the single basis entry
 * whose measured displacement is best aligned (largest normalized dot product)
 * and holds it. When the best choice changes, it releases the previously held
 * steering input first, so exactly one steering input is active at a time.
 *
 * Ported from @hearth/playtest's steer.ts, retyped against the probe contract:
 * the basis is measured in-session against a live GameUnderTest (see avatar.ts)
 * rather than in throwaway engine sessions, and the Steerer now exposes its
 * current intent so the wall-bump detector can ask "the bot is pushing this
 * way — is it actually going anywhere?".
 *
 * The Steerer only touches inputs it chose; a policy is free to press other
 * actions (a mash burst, a non-movement tap) around it.
 */
import type { InputSink } from './input.js';
import type { Direction } from './nav.js';

/** Minimum vector length before we treat a direction (or basis entry) as meaningful. */
const EPSILON = 1e-6;

/**
 * One basis input and the net world displacement holding it produced. The input
 * descriptor names a reusable control, not a recorded event: actions have no
 * `down`, axes carry the ±1 that was held.
 */
export interface MovementBasisEntry {
  input: { kind: 'action'; action: string } | { kind: 'axis'; axis: string; value: 1 | -1 };
  /** Net world-x displacement over the probe window, control-subtracted. */
  dx: number;
  /** Net world-y displacement over the probe window, control-subtracted. */
  dy: number;
}

/** The set of inputs that measurably move the avatar, in a stable probe order. */
export interface MovementBasis {
  entries: MovementBasisEntry[];
}

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
  private desired: Direction | null = null;

  constructor(private readonly basis: MovementBasis) {}

  /**
   * Drive toward (dx, dy). Applies the newly chosen input (and releases the old
   * one) only when the choice changes, so a sustained direction records one hold
   * rather than a hold per step. A degenerate/backward direction releases.
   */
  steer(input: InputSink, dx: number, dy: number): void {
    const choice = pickBasis(this.basis, dx, dy);
    if (choice === null) {
      this.release(input);
      return;
    }
    const len = Math.hypot(dx, dy);
    this.desired = { dx: dx / len, dy: dy / len };
    if (this.active && entryKey(this.active) === entryKey(choice)) return;
    this.releaseHeld(input);
    this.apply(input, choice);
    this.active = choice;
  }

  /** Release whatever steering input is currently held (no-op when none). */
  release(input: InputSink): void {
    this.desired = null;
    this.releaseHeld(input);
  }

  /**
   * The unit direction the bot is currently trying to move, or null when it is
   * not steering. The wall-bump detector compares this against real displacement.
   */
  get intent(): Direction | null {
    return this.active === null ? null : this.desired;
  }

  /**
   * The name of the control being held right now, or null. A policy that mashes
   * random inputs AROUND its own steering (seek's recovery does) has to know
   * which single control it must not touch, or it fights itself.
   */
  get activeInputName(): string | null {
    if (this.active === null) return null;
    return this.active.input.kind === 'action' ? this.active.input.action : this.active.input.axis;
  }

  private releaseHeld(input: InputSink): void {
    if (!this.active) return;
    const held = this.active;
    this.active = null;
    if (held.input.kind === 'action') input.action(held.input.action, false);
    else input.axis(held.input.axis, 0);
  }

  private apply(input: InputSink, entry: MovementBasisEntry): void {
    if (entry.input.kind === 'action') input.action(entry.input.action, true);
    else input.axis(entry.input.axis, entry.input.value);
  }
}
