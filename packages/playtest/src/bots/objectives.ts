/**
 * Objective evaluation — pure per-frame checks over live session/runtime state.
 *
 * Each declared Objective gets a LiveObjective that accumulates its outcome as
 * the run proceeds: `achievedAtFrame` is sticky (first frame the objective held
 * true), `failed` is sticky too. A `survive` objective fails the whole run the
 * moment its entity disappears or is disabled before the target frame — that is
 * the one objective type that can definitively fail mid-run.
 */
import type { Objective } from '@hearth/core';
import type { GameSession, RuntimeEntity, SceneRuntime } from '@hearth/runtime';
import type { ObjectiveOutcome } from './types.js';

/** Mutable per-objective tracking state; projects to ObjectiveOutcome. */
export interface LiveObjective {
  objective: Objective;
  index: number;
  summary: string;
  achievedAtFrame: number | null;
  failed: boolean;
}

/** Context handed to each per-frame objective evaluation. */
export interface ObjectiveEvalContext {
  runtime: SceneRuntime;
  session: GameSession;
  /** Resolved avatar entity id, the default target for objectives that omit `entity`. */
  avatarId: string | null;
  frame: number;
}

/** Human-facing one-line summary of an objective (used in reports). */
export function objectiveSummary(o: Objective): string {
  switch (o.type) {
    case 'reach': {
      const where = typeof o.target === 'string' ? o.target : `(${o.target.x}, ${o.target.y})`;
      return `reach ${where} ±${o.tolerance}px`;
    }
    case 'survive':
      return `survive ${o.entity ?? 'avatar'} ${o.frames}f`;
    case 'event':
      return `event ${o.event} ×${o.count}`;
    case 'property': {
      const parts: string[] = [];
      if (o.equals !== undefined) parts.push(`= ${JSON.stringify(o.equals)}`);
      if (o.greaterThan !== undefined) parts.push(`> ${o.greaterThan}`);
      if (o.lessThan !== undefined) parts.push(`< ${o.lessThan}`);
      return `property ${o.entity}.${o.property} ${parts.join(' and ')}`;
    }
  }
}

/** Build the initial tracking state for a list of objectives. */
export function makeLiveObjectives(objectives: Objective[]): LiveObjective[] {
  return objectives.map((objective, index) => ({
    objective,
    index,
    summary: objectiveSummary(objective),
    achievedAtFrame: null,
    failed: false,
  }));
}

/** Advance every objective by one frame against the current live state. */
export function evaluateObjectives(live: LiveObjective[], ctx: ObjectiveEvalContext): void {
  for (const item of live) evaluateOne(item, ctx);
}

/** Project tracking state to the report-facing outcome shape. */
export function toOutcomes(live: LiveObjective[]): ObjectiveOutcome[] {
  return live.map(({ index, summary, achievedAtFrame, failed }) => ({
    index,
    summary,
    achievedAtFrame,
    failed,
  }));
}

function evaluateOne(item: LiveObjective, ctx: ObjectiveEvalContext): void {
  const { objective } = item;
  switch (objective.type) {
    case 'reach': {
      if (item.achievedAtFrame !== null) return;
      const ref = objective.entity ?? ctx.avatarId ?? undefined;
      const entity = ref !== undefined ? ctx.runtime.find(ref) : undefined;
      if (!entity) return;
      const point = resolveTargetPoint(objective.target, ctx.runtime);
      if (!point) return;
      const pos = ctx.runtime.getWorldPosition(entity);
      if (Math.hypot(pos.x - point.x, pos.y - point.y) <= objective.tolerance) {
        item.achievedAtFrame = ctx.frame;
      }
      return;
    }
    case 'survive': {
      if (item.achievedAtFrame !== null || item.failed) return;
      const ref = objective.entity ?? ctx.avatarId ?? undefined;
      const entity = ref !== undefined ? ctx.runtime.find(ref) : undefined;
      const alive = entity !== undefined && entity.enabled;
      if (!alive) {
        // Disappeared or disabled before the target frame ⇒ definitive failure.
        item.failed = true;
        return;
      }
      if (ctx.frame >= objective.frames) item.achievedAtFrame = ctx.frame;
      return;
    }
    case 'event': {
      if (item.achievedAtFrame !== null) return;
      const count = ctx.session.eventCounts.get(objective.event) ?? 0;
      if (count >= objective.count) item.achievedAtFrame = ctx.frame;
      return;
    }
    case 'property': {
      if (item.achievedAtFrame !== null) return;
      const entity = ctx.runtime.find(objective.entity);
      if (!entity) return;
      const resolved = resolvePropertyPath(entity, objective.property);
      if (!resolved.found) return;
      if (matchesComparators(resolved.value, objective)) item.achievedAtFrame = ctx.frame;
      return;
    }
  }
}

function resolveTargetPoint(
  target: string | { x: number; y: number },
  runtime: SceneRuntime,
): { x: number; y: number } | null {
  if (typeof target !== 'string') return target;
  const entity = runtime.find(target);
  if (!entity) return null;
  return runtime.getWorldPosition(entity);
}

function matchesComparators(
  value: unknown,
  o: Extract<Objective, { type: 'property' }>,
): boolean {
  let checked = false;
  if (o.equals !== undefined) {
    checked = true;
    if (!looseEquals(value, o.equals)) return false;
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

/** Resolve a dot path like "Transform.position.x" against entity.components. */
function resolvePropertyPath(entity: RuntimeEntity, path: string): { found: boolean; value?: unknown } {
  let current: unknown = entity.components;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in current)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}
