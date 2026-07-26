/**
 * What a policy is: a seeded decision function over what the probe can see.
 *
 * A policy is handed the game's DECLARED capabilities (never assumptions), a
 * seeded rng, and a per-step observation, and it writes input mutations to a
 * sink. It is synchronous and pure with respect to that rng, which is what makes
 * a failing seed reproducible even though the game is not: replay the seed and
 * the bot makes the same decisions, whatever the game does back.
 *
 * Policies that need senses the game lacks are not run at all — the sweep
 * records a skip naming the missing capability instead of degrading silently.
 */
import type { NavGrid, ProbeCapabilities, ProbeEntity, ProbeInstant, StepObservation } from '../contract.js';
import type { InputSink } from '../input.js';
import type { Direction, Point } from '../nav.js';
import type { Rng } from '../rng.js';
import type { MovementBasis } from '../steer.js';

export type { Direction, Point };

/** Handed to a policy once, before the first step. */
export interface PolicyContext {
  capabilities: ProbeCapabilities;
  /** The one deterministic stream every policy decision must draw from. */
  rng: Rng;
  seed: number;
  /** Declared digital actions, sorted for deterministic iteration. */
  actions: string[];
  /** Declared virtual axes, sorted for deterministic iteration. */
  axes: string[];
  viewport: { width: number; height: number };
  /** Resolved avatar ref, or null when none could be identified. */
  avatarRef: string | null;
  /** Measured control scheme, present only for steering policies. */
  basis: MovementBasis | null;
  navGrid: NavGrid | null;
  /** seek's goal: an entity ref, an "x,y" string, or a point. */
  target?: string | Point;
  /** World-unit coverage cell size (the wander frontier's resolution fallback). */
  cellSize: number;
}

/** What a policy reads each step. `input` is the only surface it may touch. */
export interface PolicyStep {
  instant: ProbeInstant;
  obs: StepObservation;
  entities: readonly ProbeEntity[] | null;
  avatar: ProbeEntity | null;
  navGrid: NavGrid | null;
  input: InputSink;
}

export interface Policy {
  readonly name: string;
  init(ctx: PolicyContext): void;
  step(s: PolicyStep): void;
  /**
   * The unit direction this policy is currently trying to move, or null. Only
   * steering policies have one; the wall-bump detector reads it.
   */
  intent(): Direction | null;
}
