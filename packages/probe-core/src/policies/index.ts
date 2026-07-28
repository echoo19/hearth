/**
 * The policy registry and its capability gate.
 *
 * idle and mash run against anything: they need no senses, only the declared
 * input vocabulary. wander and seek steer an avatar, so both need entity
 * enumeration and a measured movement basis. Only wander additionally needs a
 * nav grid: its whole job is walking the frontier of unvisited walkable cells,
 * and without the cells there is no frontier to walk.
 *
 * seek is different. A game that says where the avatar is and where the target
 * is has already said everything seek needs to TRY, so when the nav grid is
 * missing seek runs in `direct` mode: steer straight at the target, no path.
 * That is a real degradation (no routing around concave walls, no mazes) and it
 * is named in the report rather than hidden, because a direct-steering failure
 * is not evidence that the target is unreachable.
 *
 * When a policy cannot run at all, the sweep records a skip naming the missing
 * sense instead of running a bot blind.
 */
import type { PolicyMode, ProbeCapabilities } from '../contract.js';
import { IdlePolicy, MashPolicy } from './basic.js';
import { SeekPolicy, WanderPolicy } from './steering.js';
import type { Policy } from './types.js';

export * from './types.js';
export { IdlePolicy, MashPolicy, MASH_ACTION_FLIP_P, MASH_AXIS_P, MASH_POINTER_P, MASH_MENU_CLICK_P } from './basic.js';
export { SeekPolicy, WanderPolicy } from './steering.js';

/** Policies that steer an avatar and therefore need a measured movement basis. */
export const STEERING_POLICIES = new Set(['wander', 'seek']);

/** Steering policies the nav grid is not optional for: it IS the job. */
export const NAV_POLICIES = new Set(['wander']);

/**
 * What `direct` mode costs, stated wherever a direct run is reported. Written
 * once here so the CLI, the report and the app all say the same thing.
 */
export const DIRECT_MODE_NOTE =
  'the game declares no nav grid, so seek steered straight at its target instead of pathing to it: ' +
  'it cannot route around a concave wall or through a maze, and a run that never arrives is not ' +
  'proof the target is unreachable';

export type PolicyFactory = () => Policy;

export const policyRegistry: Record<string, PolicyFactory> = {
  idle: () => new IdlePolicy(),
  mash: () => new MashPolicy(),
  wander: () => new WanderPolicy(),
  seek: () => new SeekPolicy(),
};

/** Instantiate a policy by name, or throw if it is unknown. */
export function createPolicy(name: string): Policy {
  const factory = policyRegistry[name];
  if (!factory) {
    throw new Error(`unknown probe policy: "${name}" (registered: ${Object.keys(policyRegistry).join(', ')})`);
  }
  return factory();
}

/** Why this policy cannot run against these capabilities, or null when it can. */
export function policyUnavailable(name: string, capabilities: ProbeCapabilities): string | null {
  // A name nobody registered is a skip, not a crash: one typo in a caller's
  // policy list should cost that one bot, not the whole sweep.
  if (!(name in policyRegistry)) {
    return `there is no "${name}" policy (registered: ${Object.keys(policyRegistry).sort().join(', ')})`;
  }
  const { input, senses } = capabilities;
  if (name === 'mash' && input.actions.length === 0 && input.axes.length === 0 && !input.pointer) {
    return 'the game declares no actions, axes, or pointer, so there is nothing to mash';
  }
  if (!STEERING_POLICIES.has(name)) return null;
  const missing: string[] = [];
  if (!senses.entities) missing.push('entity enumeration');
  if (NAV_POLICIES.has(name) && !senses.nav) missing.push('a nav grid');
  if (missing.length > 0) {
    return `steering needs ${missing.join(' and ')}, which this game does not declare`;
  }
  if (input.actions.length === 0 && input.axes.length === 0) {
    return 'steering needs at least one declared action or axis to move with';
  }
  return null;
}

/**
 * How well-equipped this policy is for the run it is about to make. `navGrid`
 * is the grid the run actually holds, not the declared capability: a game that
 * declares nav but hands back nothing for this scene is in the same position as
 * a game that never declared it, and the report should say so either way.
 */
export function policyMode(name: string, navGrid: unknown): { mode: PolicyMode; note?: string } {
  if (name === 'seek' && navGrid === null) return { mode: 'direct', note: DIRECT_MODE_NOTE };
  return { mode: 'full' };
}
