/**
 * Bot policies — mash and idle, behind a name-keyed registry.
 *
 * Every policy is pure-deterministic: it draws only from the injected
 * mulberry32 rng (see runBotRun), never the wall clock or Math.random, so the
 * same (policy, seed) always produces the same input timeline. wander and seek
 * are added to this file (and registered below) by the steering task.
 */
import type { BotInitCtx, BotObservation, BotPolicy } from './types.js';

/** Per-frame probability an individual digital action flips held/released. */
const MASH_ACTION_FLIP_P = 1 / 30;
/** Per-frame probability an individual axis is set to a new sticky value. */
const MASH_AXIS_P = 1 / 45;
/** Per-frame probability of a pointer click somewhere in the viewport. */
const MASH_POINTER_P = 1 / 120;

/**
 * mash — weighted-persistence random input. Works on any game with zero config:
 * it reads the action/axis lists straight from inputMappings. Actions flip with
 * low per-frame probability so holds last long enough to matter (platformer
 * jumps, sustained runs); axes get sticky random values; the pointer clicks
 * occasionally inside the viewport.
 */
export class MashPolicy implements BotPolicy {
  private rng!: () => number;
  private actions: string[] = [];
  private axes: string[] = [];
  private viewport = { width: 0, height: 0 };
  private held = new Map<string, boolean>();

  init(ctx: BotInitCtx): void {
    this.rng = ctx.rng;
    this.actions = ctx.actions;
    this.axes = ctx.axes;
    this.viewport = ctx.viewport;
    for (const action of this.actions) this.held.set(action, false);
  }

  onFrame(obs: BotObservation): void {
    for (const action of this.actions) {
      if (this.rng() < MASH_ACTION_FLIP_P) {
        const next = !(this.held.get(action) ?? false);
        this.held.set(action, next);
        obs.input.action(action, next);
      }
    }
    for (const axis of this.axes) {
      if (this.rng() < MASH_AXIS_P) {
        obs.input.axis(axis, this.rng() * 2 - 1);
      }
    }
    if (this.rng() < MASH_POINTER_P) {
      const x = this.rng() * this.viewport.width;
      const y = this.rng() * this.viewport.height;
      obs.input.pointer(x, y, 'down');
      obs.input.pointer(x, y, 'up');
    }
  }
}

/** idle — injects nothing. Catches auto-play errors, cutscene softlocks, timeouts. */
export class IdlePolicy implements BotPolicy {
  init(): void {}
  onFrame(): void {}
}

/** Factory for one policy instance (policies are stateful per run). */
export type PolicyFactory = () => BotPolicy;

/**
 * Name-keyed policy registry. wander and seek are intentionally absent here —
 * the steering task registers them once their movement-probe machinery exists.
 */
export const policyRegistry: Record<string, PolicyFactory> = {
  mash: () => new MashPolicy(),
  idle: () => new IdlePolicy(),
};

/** Instantiate a policy by name, or throw if it is unknown/unregistered. */
export function createPolicy(name: string): BotPolicy {
  const factory = policyRegistry[name];
  if (!factory) {
    const known = Object.keys(policyRegistry).join(', ');
    throw new Error(`unknown bot policy: "${name}" (registered: ${known})`);
  }
  return factory();
}
