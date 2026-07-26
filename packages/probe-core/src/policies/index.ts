/**
 * The policy registry and its capability gate.
 *
 * idle and mash run against anything — they need no senses, only the declared
 * input vocabulary. wander and seek need to know where the avatar is and where
 * the floor is, so they run only when the game declares BOTH entity enumeration
 * and a nav grid. When it does not, the sweep records a skip naming the missing
 * sense rather than running a steering bot blind.
 */
import type { ProbeCapabilities } from '../contract.js';
import { IdlePolicy, MashPolicy } from './basic.js';
import { SeekPolicy, WanderPolicy } from './steering.js';
import type { Policy } from './types.js';

export * from './types.js';
export { IdlePolicy, MashPolicy, MASH_ACTION_FLIP_P, MASH_AXIS_P, MASH_POINTER_P, MASH_MENU_CLICK_P } from './basic.js';
export { SeekPolicy, WanderPolicy } from './steering.js';

/** Policies that steer an avatar and therefore need a measured movement basis. */
export const STEERING_POLICIES = new Set(['wander', 'seek']);

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
  const { input, senses } = capabilities;
  if (name === 'mash' && input.actions.length === 0 && input.axes.length === 0 && !input.pointer) {
    return 'the game declares no actions, axes, or pointer — there is nothing to mash';
  }
  if (!STEERING_POLICIES.has(name)) return null;
  const missing: string[] = [];
  if (!senses.entities) missing.push('entity enumeration');
  if (!senses.nav) missing.push('a nav grid');
  if (missing.length > 0) {
    return `steering needs ${missing.join(' and ')}, which this game does not declare`;
  }
  if (input.actions.length === 0 && input.axes.length === 0) {
    return 'steering needs at least one declared action or axis to move with';
  }
  return null;
}
