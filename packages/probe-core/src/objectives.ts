/**
 * Objective evaluation — sticky per-step checks over what the probe can see.
 *
 * Ported from @hearth/playtest's objectives.ts and retyped against the contract:
 * there is no engine here, so an objective reads a ProbeEntity snapshot, the
 * cumulative event counts the sweep tallies from StepObservation, and the frame
 * counter — nothing else.
 *
 * `achieved` is sticky (the first instant the objective held), `failed` is
 * sticky too. `survive` is the one type that can definitively fail mid-run: its
 * entity vanished or died before the target frame.
 */
import type { Objective, ObjectiveOutcome, ProbeEntity, ProbeInstant } from './contract.js';
import { resolveEntityRef, resolveTargetPoint } from './entities.js';

/** Mutable per-objective tracking state; projects to ObjectiveOutcome. */
export interface LiveObjective {
  objective: Objective;
  index: number;
  summary: string;
  achievedAt: ProbeInstant | null;
  failed: boolean;
}

/** What one evaluation pass can see. */
export interface ObjectiveContext {
  /** Live entity snapshot, or null when the game has no entity sense. */
  entities: readonly ProbeEntity[] | null;
  /** Resolved avatar id — the default subject for reach/survive. */
  avatarId: string | null;
  /** Cumulative per-name event totals for the run so far. */
  eventCounts: ReadonlyMap<string, number>;
  instant: ProbeInstant;
}

/** Default reach tolerance in world units when an objective omits one. */
const DEFAULT_TOLERANCE = 16;

/** Human-facing one-line summary of an objective (used in reports). */
export function objectiveSummary(o: Objective): string {
  switch (o.type) {
    case 'reach':
      return `reach ${o.target ?? '?'} ±${o.tolerance ?? DEFAULT_TOLERANCE}`;
    case 'survive':
      return `survive ${o.target ?? 'avatar'} ${o.frames ?? 0}f`;
    case 'event':
      return `event ${o.event ?? '?'} x${o.count ?? 1}`;
    case 'property': {
      const parts: string[] = [];
      if (o.equals !== undefined) parts.push(`= ${JSON.stringify(o.equals)}`);
      if (o.greaterThan !== undefined) parts.push(`> ${o.greaterThan}`);
      if (o.lessThan !== undefined) parts.push(`< ${o.lessThan}`);
      return `property ${o.target ?? 'avatar'}.${o.property ?? '?'} ${parts.join(' and ')}`.trim();
    }
    default:
      return `objective ${String((o as Objective).type)}`;
  }
}

/** Build the initial tracking state for a list of objectives. */
export function makeLiveObjectives(objectives: readonly Objective[]): LiveObjective[] {
  return objectives.map((objective, index) => ({
    objective,
    index,
    summary: objectiveSummary(objective),
    achievedAt: null,
    failed: false,
  }));
}

/** Advance every objective by one step against the current state. */
export function evaluateObjectives(live: LiveObjective[], ctx: ObjectiveContext): void {
  for (const item of live) evaluateOne(item, ctx);
}

/** Project tracking state to the contract's outcome shape. */
export function toOutcomes(live: readonly LiveObjective[]): ObjectiveOutcome[] {
  return live.map((item) => ({
    objective: item.objective,
    achieved: item.achievedAt !== null,
    failed: item.failed,
    ...(item.achievedAt ? { achievedAt: item.achievedAt } : {}),
  }));
}

function subject(item: LiveObjective, ctx: ObjectiveContext): ProbeEntity | null {
  if (!ctx.entities) return null;
  const ref = item.objective.target ?? ctx.avatarId;
  if (ref === null || ref === undefined) return null;
  return resolveEntityRef(ctx.entities, ref);
}

function evaluateOne(item: LiveObjective, ctx: ObjectiveContext): void {
  const o = item.objective;
  switch (o.type) {
    case 'reach': {
      if (item.achievedAt !== null || !ctx.entities) return;
      const avatarRef = ctx.avatarId;
      const avatar = avatarRef ? resolveEntityRef(ctx.entities, avatarRef) : null;
      if (!avatar || o.target === undefined) return;
      const point = resolveTargetPoint(ctx.entities, o.target);
      if (!point) return;
      const tolerance = o.tolerance ?? DEFAULT_TOLERANCE;
      if (Math.hypot(avatar.x - point.x, avatar.y - point.y) <= tolerance) {
        item.achievedAt = ctx.instant;
      }
      return;
    }
    case 'survive': {
      if (item.achievedAt !== null || item.failed) return;
      // With no entity sense we cannot witness a death; survive then reduces to
      // "the run lasted this long", which is still a real (weaker) assertion.
      const entity = subject(item, ctx);
      if (ctx.entities && (!entity || !entity.alive)) {
        item.failed = true;
        return;
      }
      if (ctx.instant.frame >= (o.frames ?? 0)) item.achievedAt = ctx.instant;
      return;
    }
    case 'event': {
      if (item.achievedAt !== null || o.event === undefined) return;
      const count = ctx.eventCounts.get(o.event) ?? 0;
      if (count >= (o.count ?? 1)) item.achievedAt = ctx.instant;
      return;
    }
    case 'property': {
      if (item.achievedAt !== null || o.property === undefined) return;
      const entity = subject(item, ctx);
      if (!entity) return;
      const value = (entity as unknown as Record<string, unknown>)[o.property];
      if (value === undefined) return;
      if (matchesComparators(value, o)) item.achievedAt = ctx.instant;
      return;
    }
  }
}

function matchesComparators(value: unknown, o: Objective): boolean {
  let checked = false;
  if (o.equals !== undefined) {
    checked = true;
    if (!Object.is(value, o.equals)) return false;
  }
  if (o.greaterThan !== undefined) {
    checked = true;
    if (typeof value !== 'number' || !(value > o.greaterThan)) return false;
  }
  if (o.lessThan !== undefined) {
    checked = true;
    if (typeof value !== 'number' || !(value < o.lessThan)) return false;
  }
  return checked;
}
