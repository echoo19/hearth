/**
 * Bot policies — mash, idle, wander, and seek, behind a name-keyed registry.
 *
 * Every policy is pure-deterministic: it draws only from the injected
 * mulberry32 rng (see runBotRun), never the wall clock or Math.random, so the
 * same (policy, seed) always produces the same input timeline. wander and seek
 * steer via a probed movement basis (see probe.ts / steer.ts) so they work on
 * any control scheme without assuming which input moves which way.
 */
import { findPath } from '@hearth/core';
import type { BotInitCtx, BotObservation, BotPolicy } from './types.js';
import { Steerer } from './steer.js';
import { interactiveUiCenters } from './uiTargets.js';

/** A world-space point (findPath waypoints and steering goals). */
interface Point {
  x: number;
  y: number;
}

/** Per-frame probability an individual digital action flips held/released. */
const MASH_ACTION_FLIP_P = 1 / 30;
/** Per-frame probability an individual axis is set to a new sticky value. */
const MASH_AXIS_P = 1 / 45;
/** Per-frame probability of a pointer click somewhere in the viewport (gameplay scenes). */
const MASH_POINTER_P = 1 / 120;
/**
 * Per-frame click probability in a menu-like scene (no avatar + interactive UI).
 * Brisk enough to hit a button well within a default stuck window, so a working
 * menu advances instead of reading as a false stall. Gameplay HUDs are left
 * alone (that path stays at MASH_POINTER_P and never targets UI) so the bot never
 * spams a pause/quit button mid-game.
 */
const MASH_MENU_CLICK_P = 1 / 12;

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
  /** Null avatar ⇒ no gameplay entity; combined with interactive UI this reads as a menu. */
  private avatar: string | null = null;

  init(ctx: BotInitCtx): void {
    this.rng = ctx.rng;
    this.actions = ctx.actions;
    this.axes = ctx.axes;
    this.viewport = ctx.viewport;
    this.avatar = ctx.avatar;
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
    // Menu-like scenes (no avatar) get brisk, button-targeted clicks so a working
    // menu is navigated rather than falsely judged stuck; a dead button still
    // stalls, which is the real bug. Gameplay scenes keep the old rare random click.
    if (this.avatar === null) {
      if (this.rng() < MASH_MENU_CLICK_P) {
        const targets = interactiveUiCenters(obs.runtime, this.viewport.width, this.viewport.height);
        if (targets.length > 0) {
          const target = targets[Math.floor(this.rng() * targets.length)];
          this.click(obs, target.x, target.y);
        } else {
          this.click(obs, this.rng() * this.viewport.width, this.rng() * this.viewport.height);
        }
      }
    } else if (this.rng() < MASH_POINTER_P) {
      this.click(obs, this.rng() * this.viewport.width, this.rng() * this.viewport.height);
    }
  }

  private click(obs: BotObservation, x: number, y: number): void {
    obs.input.pointer(x, y, 'down');
    obs.input.pointer(x, y, 'up');
  }
}

/** idle — injects nothing. Catches auto-play errors, cutscene softlocks, timeouts. */
export class IdlePolicy implements BotPolicy {
  init(): void {}
  onFrame(): void {}
}

// --- steering policies (wander, seek) -------------------------------------

/** Re-decide the goal at least this often, even without arriving. */
const DECIDE_INTERVAL = 15;
/** Distance below which per-frame avatar motion counts as "not moving". */
const STALL_EPSILON = 0.5;
/** Consecutive not-moving frames before wander falls back to a mash burst. */
const STALL_LIMIT = 45;
/** Length of a wander mash burst (frames), meant to jiggle over an obstacle. */
const BURST_FRAMES = 30;
/** Per-frame probability during a burst that an action flips held/released. */
const BURST_FLIP_P = 1 / 8;
/** Per-frame probability during a burst that an axis is set to a new value. */
const BURST_AXIS_P = 1 / 8;
/** Per-frame probability wander taps a non-movement action (button poke). */
const TAP_P = 1 / 90;
/** Fallback arrive radius (px) before a nav grid supplies a cell-sized one. */
const DEFAULT_ARRIVE_RADIUS = 16;

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function worldCellKey(x: number, y: number, size: number): string {
  return `${Math.floor(x / size)},${Math.floor(y / size)}`;
}

/**
 * Shared steering machinery for wander and seek. Both derive a world-space goal
 * (the subclass hook), path to it over the live nav grid, and follow the path by
 * feeding each waypoint direction to a Steerer backed by the probed movement
 * basis. A run without a resolved avatar or a usable basis fails fast at init —
 * these policies are meaningless otherwise.
 */
abstract class SteeringPolicy implements BotPolicy {
  protected rng!: () => number;
  protected steerer!: Steerer;
  protected avatarId!: string;
  protected actions: string[] = [];
  protected axes: string[] = [];
  private path: Point[] | null = null;
  private pathIndex = 0;
  private framesSinceDecision = 0;
  protected arriveRadius = DEFAULT_ARRIVE_RADIUS;
  protected cellSize = 32;

  init(ctx: BotInitCtx): void {
    if (ctx.avatar === null) {
      throw new Error(
        `${this.label()} policy needs an avatar but none resolved; pass an explicit avatar`,
      );
    }
    if (!ctx.basis || ctx.basis.entries.length === 0) {
      throw new Error(
        `${this.label()} policy has no movement basis for the avatar; ` +
          `the probe found no input that moves it`,
      );
    }
    this.rng = ctx.rng;
    this.steerer = new Steerer(ctx.basis);
    this.avatarId = ctx.avatar;
    this.actions = ctx.actions;
    this.axes = ctx.axes;
    this.onInit(ctx);
  }

  onFrame(obs: BotObservation): void {
    this.steerTowardGoal(obs);
  }

  /** Subclass setup after the base captured rng/basis/avatar. */
  protected onInit(_ctx: BotInitCtx): void {}
  /** Policy name for error messages. */
  protected abstract label(): string;
  /** The world point to steer toward this decision, or null when there is none. */
  protected abstract chooseGoal(obs: BotObservation): Point | null;

  /** Decide (when due) then feed the current waypoint direction to the Steerer. */
  protected steerTowardGoal(obs: BotObservation): void {
    const avatar = obs.avatar;
    if (!avatar) {
      this.releaseSteering(obs);
      return;
    }
    const pos = obs.runtime.getWorldPosition(avatar);

    const goal = this.path ? this.path[this.path.length - 1] : null;
    const arrived = goal !== null && this.pathIndex >= this.path!.length - 1 && dist(pos, goal) <= this.arriveRadius;
    if (this.path === null || this.framesSinceDecision >= DECIDE_INTERVAL || arrived) {
      this.decide(obs, pos);
    }
    this.framesSinceDecision++;

    if (this.path === null || this.path.length === 0) {
      this.steerer.release(obs.input);
      return;
    }
    while (this.pathIndex < this.path.length - 1 && dist(pos, this.path[this.pathIndex]) <= this.arriveRadius) {
      this.pathIndex++;
    }
    const wp = this.path[this.pathIndex];
    this.steerer.steer(obs.input, wp.x - pos.x, wp.y - pos.y);
  }

  private decide(obs: BotObservation, pos: Point): void {
    this.framesSinceDecision = 0;
    const goal = this.chooseGoal(obs);
    if (!goal) {
      this.path = null;
      this.pathIndex = 0;
      return;
    }
    const grid = obs.runtime.getNavGrid([pos, goal]);
    this.arriveRadius = grid ? Math.max(grid.cellSize * 0.5, 8) : DEFAULT_ARRIVE_RADIUS;
    let path = grid ? findPath(grid, pos, goal) : null;
    if (!path || path.length === 0) {
      // No grid or unreachable: steer straight at the goal and let stall
      // recovery (wander) or the next decision sort out obstacles.
      path = [goal];
    } else {
      // findPath ends on the goal cell's center; steer to the exact goal on the
      // final approach so arrival lines up with reach tolerances.
      path = [...path.slice(0, -1), goal];
    }
    this.path = path;
    this.pathIndex = 0;
  }

  /** Drop any held steering input and forget the current path. */
  protected releaseSteering(obs: BotObservation): void {
    this.steerer.release(obs.input);
    this.path = null;
    this.pathIndex = 0;
  }
}

/**
 * wander — curiosity-driven exploration. Each decision it paths to the nearest
 * unvisited reachable nav-grid cell and steers there; when everything nearby is
 * visited it roams to a random reachable cell. If the avatar stops making
 * progress for a while it fires a short seeded mash burst to jiggle over
 * whatever is blocking it, and now and then it taps a non-movement action to
 * poke at buttons/switches.
 */
export class WanderPolicy extends SteeringPolicy {
  private visited = new Set<string>();
  private movementActions = new Set<string>();
  private nonMovementActions: string[] = [];
  private held = new Map<string, boolean>();
  private pendingRelease: string | null = null;
  private burstRemaining = 0;
  private stalledFrames = 0;
  private lastPos: Point | null = null;

  protected label(): string {
    return 'wander';
  }

  protected onInit(ctx: BotInitCtx): void {
    for (const entry of ctx.basis!.entries) {
      if (entry.input.kind === 'action') this.movementActions.add(entry.input.action);
    }
    this.nonMovementActions = ctx.actions.filter((a) => !this.movementActions.has(a));
    for (const action of ctx.actions) this.held.set(action, false);
  }

  onFrame(obs: BotObservation): void {
    // Release a one-frame tap started last frame.
    if (this.pendingRelease !== null) {
      obs.input.action(this.pendingRelease, false);
      this.held.set(this.pendingRelease, false);
      this.pendingRelease = null;
    }

    const avatar = obs.avatar;
    if (!avatar) {
      this.releaseSteering(obs);
      return;
    }
    const pos = obs.runtime.getWorldPosition(avatar);
    this.visited.add(worldCellKey(pos.x, pos.y, this.cellSize));

    if (this.lastPos && dist(pos, this.lastPos) < STALL_EPSILON) this.stalledFrames++;
    else this.stalledFrames = 0;
    this.lastPos = pos;

    if (this.burstRemaining > 0) {
      this.mashFrame(obs);
      if (--this.burstRemaining === 0) this.endBurst(obs);
      return;
    }
    if (this.stalledFrames > STALL_LIMIT) {
      this.stalledFrames = 0;
      this.steerer.release(obs.input);
      this.burstRemaining = BURST_FRAMES;
      this.mashFrame(obs);
      if (--this.burstRemaining === 0) this.endBurst(obs);
      return;
    }

    this.steerTowardGoal(obs);

    if (this.nonMovementActions.length > 0 && this.rng() < TAP_P) {
      const idx = Math.min(
        this.nonMovementActions.length - 1,
        Math.floor(this.rng() * this.nonMovementActions.length),
      );
      const action = this.nonMovementActions[idx];
      obs.input.action(action, true);
      this.held.set(action, true);
      this.pendingRelease = action;
    }
  }

  protected chooseGoal(obs: BotObservation): Point | null {
    const avatar = obs.avatar;
    if (!avatar) return null;
    const pos = obs.runtime.getWorldPosition(avatar);
    const grid = obs.runtime.getNavGrid([pos]);
    if (!grid) return null;
    this.cellSize = grid.cellSize;

    const { cellSize, originX, originY, cols, rows, solid } = grid;
    const candidates: { center: Point; key: string; d: number; order: number }[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const order = row * cols + col;
        if (solid[order] !== 0) continue;
        const center: Point = {
          x: originX + (col + 0.5) * cellSize,
          y: originY + (row + 0.5) * cellSize,
        };
        candidates.push({
          center,
          key: worldCellKey(center.x, center.y, cellSize),
          d: dist(pos, center),
          order,
        });
      }
    }
    candidates.sort((a, b) => a.d - b.d || a.order - b.order);

    const reachable: Point[] = [];
    for (const c of candidates) {
      if (findPath(grid, pos, c.center) === null) continue;
      if (!this.visited.has(c.key)) return c.center; // nearest unvisited reachable
      reachable.push(c.center);
    }
    if (reachable.length === 0) return null;
    // Everything reachable is already visited: roam to a random reachable cell.
    const idx = Math.min(reachable.length - 1, Math.floor(this.rng() * reachable.length));
    return reachable[idx];
  }

  /** One frame of aggressive random input, drawing from the shared rng stream. */
  private mashFrame(obs: BotObservation): void {
    for (const action of this.actions) {
      if (this.rng() < BURST_FLIP_P) {
        const next = !(this.held.get(action) ?? false);
        this.held.set(action, next);
        obs.input.action(action, next);
      }
    }
    for (const axis of this.axes) {
      if (this.rng() < BURST_AXIS_P) obs.input.axis(axis, this.rng() * 2 - 1);
    }
  }

  /** Release everything the burst left held so steering resumes from a clean slate. */
  private endBurst(obs: BotObservation): void {
    for (const [action, down] of this.held) {
      if (down) obs.input.action(action, false);
      this.held.set(action, false);
    }
    for (const axis of this.axes) obs.input.axis(axis, 0);
  }
}

/**
 * seek — the verification bot. Same steering as wander, but toward a fixed goal:
 * an entity (re-resolved live each decision so it tracks a moving target) or a
 * world point. "Can the player actually reach the exit?"
 */
export class SeekPolicy extends SteeringPolicy {
  private target!: string | Point;

  protected label(): string {
    return 'seek';
  }

  protected onInit(ctx: BotInitCtx): void {
    if (ctx.config.target === undefined) {
      throw new Error('seek policy needs a target (an entity ref or {x,y}) but none was given');
    }
    this.target = ctx.config.target;
  }

  protected chooseGoal(obs: BotObservation): Point | null {
    if (typeof this.target !== 'string') return this.target;
    const entity = obs.runtime.find(this.target);
    if (!entity) return null;
    return obs.runtime.getWorldPosition(entity);
  }
}

/** Factory for one policy instance (policies are stateful per run). */
export type PolicyFactory = () => BotPolicy;

/** Name-keyed policy registry: mash/idle (zero-config) plus the steering pair wander/seek. */
export const policyRegistry: Record<string, PolicyFactory> = {
  mash: () => new MashPolicy(),
  idle: () => new IdlePolicy(),
  wander: () => new WanderPolicy(),
  seek: () => new SeekPolicy(),
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
