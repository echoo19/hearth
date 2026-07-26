/**
 * Entity lookup over a snapshot list — the offline half of `findEntity`.
 *
 * The contract's `findEntity` resolves by id, then exact name, then tag, and it
 * costs a round trip to the game. Every step the sweep already holds the full
 * `listEntities` snapshot, so detectors and policies resolve refs against that
 * instead, using exactly the same precedence. One rule, no extra traffic.
 */
import type { ProbeEntity } from './contract.js';

/** Resolve a ref (id, then exact name, then tag) against a snapshot. */
export function resolveEntityRef(entities: readonly ProbeEntity[], ref: string): ProbeEntity | null {
  for (const e of entities) if (e.id === ref) return e;
  for (const e of entities) if (e.name === ref) return e;
  for (const e of entities) if (e.tags?.includes(ref)) return e;
  return null;
}

/** Parse "12,34" as a world point; null when the string is not a point. */
export function parsePoint(ref: string): { x: number; y: number } | null {
  const comma = ref.indexOf(',');
  if (comma < 0) return null;
  const x = Number(ref.slice(0, comma).trim());
  const y = Number(ref.slice(comma + 1).trim());
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * Resolve a target ref to a world point: an explicit "x,y" wins, otherwise the
 * live position of the entity it names. Null when neither resolves.
 */
export function resolveTargetPoint(
  entities: readonly ProbeEntity[],
  ref: string,
): { x: number; y: number } | null {
  const point = parsePoint(ref);
  if (point) return point;
  const entity = resolveEntityRef(entities, ref);
  return entity ? { x: entity.x, y: entity.y } : null;
}
