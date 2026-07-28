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
 * live runtime entity, and a policy the game cannot support is skipped by name
 * rather than left to flail (see the gate in ./index.ts).
 *
 * Neither bot has a jump planner or any model of the game's physics, so both
 * get the same crude recovery: when the avatar stops making headway, fire a
 * short SEEDED mash burst. Press things, see if the world moves. It is how a
 * person plays a platformer they have not solved yet, and it is the difference
 * between a bot that walks into a pit forever and one that eventually jumps it.
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
/** Consecutive not-moving steps before a steering bot falls back to a mash burst. */
const STALL_LIMIT = 45;
/**
 * Steps of getting no closer to the target before DIRECT seek bursts. Distance
 * is only a stall signal when the straight line is the plan: a bot pathing over
 * a nav grid legitimately walks away from its goal to get around a wall, so
 * this counter is never armed in full mode.
 *
 * Much shorter than STALL_LIMIT, deliberately. Not moving might be a cutscene
 * or a knockback; moving without ever getting closer means the straight line is
 * wrong, which is conclusive almost immediately. It also has to fit inside a
 * short sweep: the app's default run is 60 steps, and a bot that waits 45 of
 * them before trying anything else never tries anything else.
 */
const NO_APPROACH_LIMIT = 20;
/** Improvement in distance-to-target that counts as approach rather than jitter. */
const APPROACH_EPSILON = 1;
/** Length of a mash burst (steps), meant to jiggle over an obstacle. */
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
  /** Steps in a row the avatar has not measurably moved. */
  protected stalledSteps = 0;
  protected readonly held = new Map<string, boolean>();
  private burstRemaining = 0;
  private lastPos: Point | null = null;
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
    for (const action of ctx.actions) this.held.set(action, false);
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
      // No grid or unreachable: steer straight at the goal and let the burst
      // recovery or the next decision sort out the obstacle. This line is all
      // there is to `direct` mode, which is exactly why it is reported: the
      // straight line is not a route, it is a guess that usually works.
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

  // --- stall recovery, shared by both bots -------------------------------

  /** Count a step where the avatar went nowhere. Call once per step, first. */
  protected trackStall(pos: Point): void {
    if (this.lastPos && dist(pos, this.lastPos) < STALL_EPSILON) this.stalledSteps++;
    else this.stalledSteps = 0;
    this.lastPos = pos;
  }

  /**
   * Spend one step of an in-flight burst, if there is one. True means the step
   * is used up and the caller must not steer this step.
   */
  protected continueBurst(s: PolicyStep): boolean {
    if (this.burstRemaining <= 0) return false;
    this.burstStep(s);
    if (--this.burstRemaining === 0) this.endBurst(s);
    return true;
  }

  /** Start bursting, spending this step on the first burst step. */
  protected beginBurst(s: PolicyStep): void {
    this.stalledSteps = 0;
    this.burstRemaining = BURST_STEPS;
    this.burstStep(s);
    if (--this.burstRemaining === 0) this.endBurst(s);
  }

  /**
   * One step of a burst. The default (wander's) lets go of the wheel: the bot
   * has no particular place to be, so flailing in every direction is the point.
   * seek overrides it, because it does have somewhere to be.
   */
  protected burstStep(s: PolicyStep): void {
    this.steerer.release(s.input);
    this.mashStep(s, null);
  }

  /**
   * One step of aggressive random input, drawing from the shared rng stream.
   * `skip` names a control the caller is steering with: it is still drawn for,
   * so the seeded stream does not shift, but it is never touched.
   */
  protected mashStep(s: PolicyStep, skip: string | null): void {
    for (const action of this.actions) {
      if (this.rng() < BURST_FLIP_P) {
        const next = !(this.held.get(action) ?? false);
        if (action === skip) continue;
        this.held.set(action, next);
        s.input.action(action, next);
      }
    }
    for (const axis of this.axes) {
      if (this.rng() < BURST_AXIS_P) {
        const value = this.rng() * 2 - 1;
        if (axis !== skip) s.input.axis(axis, value);
      }
    }
  }

  /** Release everything the burst left held so steering resumes from a clean slate. */
  private endBurst(s: PolicyStep): void {
    for (const [action, down] of this.held) {
      if (down) s.input.action(action, false);
      this.held.set(action, false);
    }
    for (const axis of this.axes) s.input.axis(axis, 0);
    this.onBurstEnd(s);
  }

  /** Hook for a subclass to clean up and re-arm its own counters after a burst. */
  protected onBurstEnd(_s: PolicyStep): void {}
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
  private pendingRelease: string | null = null;

  protected onInit(ctx: PolicyContext): void {
    for (const entry of ctx.basis?.entries ?? []) {
      if (entry.input.kind === 'action') this.movementActions.add(entry.input.action);
    }
    this.nonMovementActions = ctx.actions.filter((a) => !this.movementActions.has(a));
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
    this.trackStall(pos);

    if (this.continueBurst(s)) return;
    if (this.stalledSteps > STALL_LIMIT) {
      this.beginBurst(s);
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
}

/**
 * seek — the verification bot. Same steering as wander, but toward a fixed goal:
 * an entity (re-resolved live each decision so it tracks a moving target) or a
 * world point. "Can the player actually reach the exit?"
 *
 * With a nav grid it paths. Without one it runs in DIRECT mode: the straight
 * line to the target IS the plan. That answers the question for the games most
 * people are building (a room, a side-scroller, a board) and answers nothing at
 * all for a maze, which is why the mode is named in the report. A direct run
 * that never arrives says the bot could not get there, not that a player
 * cannot. Because the straight line is the whole plan, distance to the target
 * doubles as a progress signal: when it stops shrinking the bot is against
 * something, and a mash burst is the only tool it has for getting over it.
 */
export class SeekPolicy extends SteeringPolicy {
  readonly name = 'seek';
  private target!: string | Point;
  private direct = false;
  private closest: number | null = null;
  private noApproachSteps = 0;

  protected onInit(ctx: PolicyContext): void {
    if (ctx.target === undefined) {
      throw new Error('seek policy needs a target (an entity ref or {x,y}) but none was given');
    }
    this.target = ctx.target;
    this.direct = ctx.navGrid === null;
  }

  step(s: PolicyStep): void {
    const avatar = s.avatar;
    if (!avatar) {
      this.releaseSteering(s);
      return;
    }
    const pos = { x: avatar.x, y: avatar.y };
    this.trackStall(pos);

    if (this.continueBurst(s)) return;

    // Standing on the target is not being stuck, it is being finished. Without
    // this, a seek that arrives and has nothing left to do sits there until the
    // stall counter trips and then mashes on top of the thing it just reached.
    if (this.arrived(s, pos)) {
      this.stalledSteps = 0;
      this.noApproachSteps = 0;
      this.steerTowardGoal(s);
      return;
    }

    const noApproach = this.trackApproach(s, pos) > NO_APPROACH_LIMIT;
    if (this.stalledSteps > STALL_LIMIT || noApproach) {
      this.beginBurst(s);
      return;
    }

    this.steerTowardGoal(s);
  }

  /** Is the avatar already at the target, within the arrival tolerance? */
  private arrived(s: PolicyStep, pos: Point): boolean {
    const goal = this.chooseGoal(s);
    return goal !== null && dist(pos, goal) <= this.arriveRadius;
  }

  protected chooseGoal(s: PolicyStep): Point | null {
    if (typeof this.target !== 'string') return this.target;
    if (!s.entities) return null;
    return resolveTargetPoint(s.entities, this.target);
  }

  /**
   * seek's burst keeps hold of the wheel. It is already pointed at the target
   * and the direction is not what is wrong, so it goes on pressing that one
   * control and mashes everything else around it: keep walking into the gap,
   * try the other buttons, see if one of them is a jump. Letting go instead
   * (wander's burst) mostly walks the bot back the way it came.
   */
  protected burstStep(s: PolicyStep): void {
    this.steerTowardGoal(s);
    this.mashStep(s, this.steerer.activeInputName);
  }

  /** Steps since the bot was last closer to the target than it has ever been. */
  private trackApproach(s: PolicyStep, pos: Point): number {
    if (!this.direct) return 0;
    const goal = this.chooseGoal(s);
    if (!goal) return 0;
    const d = dist(pos, goal);
    if (this.closest === null || d < this.closest - APPROACH_EPSILON) {
      this.closest = d;
      this.noApproachSteps = 0;
      return 0;
    }
    return ++this.noApproachSteps;
  }

  /**
   * Re-arm from wherever the burst left the avatar. Without this the counter is
   * still over the limit the step after a burst ends, and the bot mashes
   * forever instead of trying to walk again. The steering input goes too: the
   * burst may have left the Steerer holding something the mash also touched, so
   * the next step re-chooses from a clean slate.
   */
  protected onBurstEnd(s: PolicyStep): void {
    this.steerer.release(s.input);
    this.closest = null;
    this.noApproachSteps = 0;
  }
}
