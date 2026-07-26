/**
 * idle and mash — the two policies that need no senses at all.
 *
 * Ported from @hearth/playtest's policies.ts, minus the engine: mash reads the
 * DECLARED action/axis lists out of the capabilities rather than an engine's
 * input mappings, and its menu-click path can no longer target real UI widgets
 * (the contract exposes no widget tree), so it clicks briskly around the
 * viewport instead when there is no avatar to drive.
 *
 * Weighted persistence is the whole idea behind mash: flipping every button
 * every step produces noise no game can respond to. Low per-step flip
 * probabilities mean holds last long enough to matter — a jump completes, a run
 * builds speed, a charge finishes.
 */
import type { Rng } from '../rng.js';
import type { Direction, Policy, PolicyContext, PolicyStep } from './types.js';

/** Per-step probability an individual digital action flips held/released. */
export const MASH_ACTION_FLIP_P = 1 / 30;
/** Per-step probability an individual axis is set to a new sticky value. */
export const MASH_AXIS_P = 1 / 45;
/** Per-step probability of a pointer click somewhere in the viewport (gameplay). */
export const MASH_POINTER_P = 1 / 120;
/**
 * Per-step click probability with no avatar in sight — the game is probably a
 * menu, and a working menu should be navigated briskly enough to advance well
 * within a stuck window, so a dead button is the thing that stalls, not the bot.
 */
export const MASH_MENU_CLICK_P = 1 / 12;

/** idle — injects nothing. Catches auto-play errors, cutscene softlocks, timeouts. */
export class IdlePolicy implements Policy {
  readonly name = 'idle';
  init(): void {}
  step(): void {}
  intent(): Direction | null {
    return null;
  }
}

/**
 * mash — weighted-persistence random input over the declared vocabulary. Works
 * on any game with zero configuration and zero conventions.
 */
export class MashPolicy implements Policy {
  readonly name = 'mash';
  private rng!: Rng;
  private actions: string[] = [];
  private axes: string[] = [];
  private pointer = false;
  private viewport = { width: 0, height: 0 };
  private readonly held = new Map<string, boolean>();
  private avatarRef: string | null = null;

  init(ctx: PolicyContext): void {
    this.rng = ctx.rng;
    this.actions = ctx.actions;
    this.axes = ctx.axes;
    this.pointer = ctx.capabilities.input.pointer;
    this.viewport = ctx.viewport;
    this.avatarRef = ctx.avatarRef;
    for (const action of this.actions) this.held.set(action, false);
  }

  step(s: PolicyStep): void {
    for (const action of this.actions) {
      if (this.rng() < MASH_ACTION_FLIP_P) {
        const next = !(this.held.get(action) ?? false);
        this.held.set(action, next);
        s.input.action(action, next);
      }
    }
    for (const axis of this.axes) {
      if (this.rng() < MASH_AXIS_P) s.input.axis(axis, this.rng() * 2 - 1);
    }
    if (!this.pointer) return;
    const rate = this.avatarRef === null ? MASH_MENU_CLICK_P : MASH_POINTER_P;
    if (this.rng() < rate) {
      const x = this.rng() * this.viewport.width;
      const y = this.rng() * this.viewport.height;
      s.input.pointer(x, y, 'down');
      s.input.pointer(x, y, 'up');
    }
  }

  intent(): Direction | null {
    return null;
  }
}
