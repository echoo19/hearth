/**
 * wander and seek — the policies that actually try to get somewhere.
 *
 * Ported from @hearth/playtest's SteeringPolicy pair. The shape is unchanged:
 * derive a world goal, path to it over the nav grid, and feed each waypoint
 * direction to a Steerer backed by a MEASURED movement basis, so neither policy
 * assumes "right means +x" — they work on any control scheme because the basis
 * was probed from the game itself.
 *
 * Three adaptations to the probe contract: paths come from probe-core's own BFS
 * (no engine pathfinder), the avatar is a ProbeEntity snapshot rather than a
 * live runtime entity, and both policies are only ever run when the game
 * declares nav + entities — otherwise the sweep skips them by name instead of
 * letting them flail.
 */
import type { NavGrid } from '../contract.js';
import { resolveTargetPoint } from '../entities.js';
import { navField, pathToCell, reachableCells, nearestUnvisited, type NavField } from '../nav.js';
import { cellCenter, cellIndexAt } from '../reachability.js';
import { randomInt, type Rng } from '../rng.js';
import { Steerer } from '../steer.js';
import type { Direction, Point, Policy, PolicyContext, PolicyStep } from './types.js';

/** Re-decide the goal at least this often, even without arriving. */
const DECIDE_INTERVAL = 15;
/** Distance below which per-step avatar motion counts as "not moving". */
const STALL_EPSILON = 0.5;
/** Consecutive not-moving steps before wander falls back to a mash burst. */
const STALL_LIMIT = 45;
/** Length of a wander mash burst (steps), meant to jiggle over an obstacle. */
const BURST_STEPS = 30;
/** Per-step probability during a burst that an action flips held/released. */
const BURST_FLIP_P = 1 / 8;
/** Per-step probability during a burst that an axis is set to a new value. */
const BURST_AXIS_P = 1 / 8;
/** Per-step probability wander taps a non-movement action (button poke). */
const TAP_P = 1 / 90;
/** Fallback arrive radius before a nav grid supplies a cell-sized one. */
const DEFAULT_ARRIVE_RADIUS = 16;

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

abstract class SteeringPolicy implements Policy {
  abstract readonly name: string;
  protected rng!: Rng;
  protected steerer!: Steerer;
  protected actions: string[] = [];
  protected axes: string[] = [];
  protected cellSize = 32;
  protected arriveRadius = DEFAULT_ARRIVE_RADIUS;
  private path: Point[] | null = null;
  private pathIndex = 0;
  private sinceDecision = 0;

  init(ctx: PolicyContext): void {
    if (!ctx.basis || ctx.basis.entries.length === 0) {
      throw new Error(
        `${this.name} policy has no movement basis: the probe found no input that moves the avatar`,
      );
    }
    this.rng = ctx.rng;
    this.steerer = new Steerer(ctx.basis);
    this.actions = ctx.actions;
    this.axes = ctx.axes;
    this.cellSize = ctx.navGrid?.cellSize ?? ctx.cellSize;
    this.onInit(ctx);
  }

  step(s: PolicyStep): void {
    this.steerTowardGoal(s);
  }

  intent(): Direction | null {
    return this.steerer?.intent ?? null;
  }

  protected onInit(_ctx: PolicyContext): void {}

  /** The world point to steer toward this decision, or null when there is none. */
  protected abstract chooseGoal(
    s: PolicyStep,
    pos: Point,
    grid: NavGrid | null,
    field: NavField | null,
  ): Point | null;

  /** Decide (when due) then feed the current waypoint direction to the Steerer. */
  protected steerTowardGoal(s: PolicyStep): void {
    const avatar = s.avatar;
    if (!avatar) {
      this.releaseSteering(s);
      return;
    }
    const pos = { x: avatar.x, y: avatar.y };
    const goal = this.path ? this.path[this.path.length - 1] : null;
    const arrived =
      goal !== null && this.pathIndex >= (this.path?.length ?? 0) - 1 && dist(pos, goal) <= this.arriveRadius;
    if (this.path === null || this.sinceDecision >= DECIDE_INTERVAL || arrived) this.decide(s, pos);
    this.sinceDecision++;

    if (this.path === null || this.path.length === 0) {
      this.steerer.release(s.input);
      return;
    }
    while (this.pathIndex < this.path.length - 1 && dist(pos, this.path[this.pathIndex]) <= this.arriveRadius) {
      this.pathIndex++;
    }
    const wp = this.path[this.pathIndex];
    this.steerer.steer(s.input, wp.x - pos.x, wp.y - pos.y);
  }

  private decide(s: PolicyStep, pos: Point): void {
    this.sinceDecision = 0;
    const grid = s.navGrid;
    let field: NavField | null = null;
    if (grid) {
      const start = cellIndexAt(grid, pos.x, pos.y);
      if (start >= 0) field = navField(grid, start);
    }
    const goal = this.chooseGoal(s, pos, grid, field);
    if (!goal) {
      this.path = null;
      this.pathIndex = 0;
      return;
    }
    this.arriveRadius = grid ? Math.max(grid.cellSize * 0.5, 8) : DEFAULT_ARRIVE_RADIUS;
    let path: Point[] | null = null;
    if (grid && field) {
      const goalCell = cellIndexAt(grid, goal.x, goal.y);
      if (goalCell >= 0) path = pathToCell(grid, field, goalCell);
    }
    if (!path || path.length === 0) {
      // No grid or unreachable: steer straight at the goal and let stall
      // recovery (wander) or the next decision sort out the obstacle.
      path = [goal];
    } else {
      // The route ends on the goal cell's center; steer to the exact goal on the
      // final approach so arrival lines up with reach tolerances.
      path = [...path.slice(0, -1), goal];
    }
    this.path = path;
    this.pathIndex = 0;
  }

  /** Drop any held steering input and forget the current path. */
  protected releaseSteering(s: PolicyStep): void {
    this.steerer.release(s.input);
    this.path = null;
    this.pathIndex = 0;
  }
}

/**
 * wander — curiosity-driven exploration. Each decision it paths to the nearest
 * unvisited reachable cell; when everything reachable is visited it roams to a
 * random one. If the avatar stops making progress it fires a short seeded mash
 * burst to jiggle over whatever is blocking it, and now and then taps a
 * non-movement action to poke at buttons and switches.
 */
export class WanderPolicy extends SteeringPolicy {
  readonly name = 'wander';
  private readonly visited = new Set<string>();
  private readonly movementActions = new Set<string>();
  private nonMovementActions: string[] = [];
  private readonly held = new Map<string, boolean>();
  private pendingRelease: string | null = null;
  private burstRemaining = 0;
  private stalledSteps = 0;
  private lastPos: Point | null = null;

  protected onInit(ctx: PolicyContext): void {
    for (const entry of ctx.basis?.entries ?? []) {
      if (entry.input.kind === 'action') this.movementActions.add(entry.input.action);
    }
    this.nonMovementActions = ctx.actions.filter((a) => !this.movementActions.has(a));
    for (const action of ctx.actions) this.held.set(action, false);
  }

  step(s: PolicyStep): void {
    // Release a one-step tap started last step.
    if (this.pendingRelease !== null) {
      s.input.action(this.pendingRelease, false);
      this.held.set(this.pendingRelease, false);
      this.pendingRelease = null;
    }

    const avatar = s.avatar;
    if (!avatar) {
      this.releaseSteering(s);
      return;
    }
    const pos = { x: avatar.x, y: avatar.y };
    this.visited.add(this.key(pos));

    if (this.lastPos && dist(pos, this.lastPos) < STALL_EPSILON) this.stalledSteps++;
    else this.stalledSteps = 0;
    this.lastPos = pos;

    if (this.burstRemaining > 0) {
      this.mashStep(s);
      if (--this.burstRemaining === 0) this.endBurst(s);
      return;
    }
    if (this.stalledSteps > STALL_LIMIT) {
      this.stalledSteps = 0;
      this.steerer.release(s.input);
      this.burstRemaining = BURST_STEPS;
      this.mashStep(s);
      if (--this.burstRemaining === 0) this.endBurst(s);
      return;
    }

    this.steerTowardGoal(s);

    if (this.nonMovementActions.length > 0 && this.rng() < TAP_P) {
      const action = this.nonMovementActions[randomInt(this.rng, this.nonMovementActions.length)];
      s.input.action(action, true);
      this.held.set(action, true);
      this.pendingRelease = action;
    }
  }

  protected chooseGoal(_s: PolicyStep, _pos: Point, grid: NavGrid | null, field: NavField | null): Point | null {
    if (!grid || !field) return null;
    this.cellSize = grid.cellSize;
    const keyOf = (p: Point): string => this.key(p);
    const frontier = nearestUnvisited(grid, field, this.visited, keyOf);
    if (frontier !== null) return cellCenter(grid, frontier);
    const reachable = reachableCells(field);
    if (reachable.length === 0) return null;
    return cellCenter(grid, reachable[randomInt(this.rng, reachable.length)]);
  }

  private key(p: Point): string {
    return `${Math.floor(p.x / this.cellSize)},${Math.floor(p.y / this.cellSize)}`;
  }

  /** One step of aggressive random input, drawing from the shared rng stream. */
  private mashStep(s: PolicyStep): void {
    for (const action of this.actions) {
      if (this.rng() < BURST_FLIP_P) {
        const next = !(this.held.get(action) ?? false);
        this.held.set(action, next);
        s.input.action(action, next);
      }
    }
    for (const axis of this.axes) {
      if (this.rng() < BURST_AXIS_P) s.input.axis(axis, this.rng() * 2 - 1);
    }
  }

  /** Release everything the burst left held so steering resumes from a clean slate. */
  private endBurst(s: PolicyStep): void {
    for (const [action, down] of this.held) {
      if (down) s.input.action(action, false);
      this.held.set(action, false);
    }
    for (const axis of this.axes) s.input.axis(axis, 0);
  }
}

/**
 * seek — the verification bot. Same steering as wander, but toward a fixed goal:
 * an entity (re-resolved live each decision so it tracks a moving target) or a
 * world point. "Can the player actually reach the exit?"
 */
export class SeekPolicy extends SteeringPolicy {
  readonly name = 'seek';
  private target!: string | Point;

  protected onInit(ctx: PolicyContext): void {
    if (ctx.target === undefined) {
      throw new Error('seek policy needs a target (an entity ref or {x,y}) but none was given');
    }
    this.target = ctx.target;
  }

  protected chooseGoal(s: PolicyStep): Point | null {
    if (typeof this.target !== 'string') return this.target;
    if (!s.entities) return null;
    return resolveTargetPoint(s.entities, this.target);
  }
}
