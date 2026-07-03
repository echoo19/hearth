/**
 * Pure math for the Scene view's point editor: shared by the polygon
 * Collider vertex editor and the LineRenderer vertex editor (SceneView's
 * `pointsSelection` picks whichever component the current selection has).
 *
 * The transform mirrors the runtime exactly: polygon points are local space,
 * scaled by Transform.scale, rotated by Transform.rotation (degrees), then
 * translated by the entity's world position plus an offset (Collider.offset
 * for polygon colliders; {0,0} for LineRenderer, which has no offset field —
 * see packages/runtime/src/physics.ts colliderShape and
 * packages/runtime/src/pixi/index.ts's node transform + redrawLine).
 *
 *   world = worldPos + offset + R(rotation) · S(scale) · local
 *
 * For editing we also need the inverse. A scale component of 0 collapses the
 * shape and has no inverse, so both directions substitute 1 for a zero
 * scale — degenerate in the runtime, but it keeps handles editable.
 */
import type { Vec2 } from './types';

export interface PolygonFrame {
  /** Entity world position (translation only, matching the Scene view). */
  worldPos: Vec2;
  /** Collider.offset. */
  offset: Vec2;
  /** Transform.rotation in degrees. */
  rotation: number;
  /** Transform.scale. */
  scale: Vec2;
}

function safeScale(v: number): number {
  return v === 0 ? 1 : v;
}

export function polygonLocalToWorld(local: Vec2, frame: PolygonFrame): Vec2 {
  const rad = (frame.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x = local.x * safeScale(frame.scale.x);
  const y = local.y * safeScale(frame.scale.y);
  return {
    x: frame.worldPos.x + frame.offset.x + x * cos - y * sin,
    y: frame.worldPos.y + frame.offset.y + x * sin + y * cos,
  };
}

export function polygonWorldToLocal(world: Vec2, frame: PolygonFrame): Vec2 {
  const rad = (frame.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = world.x - frame.worldPos.x - frame.offset.x;
  const dy = world.y - frame.worldPos.y - frame.offset.y;
  // Inverse rotation, then inverse scale.
  const x = dx * cos + dy * sin;
  const y = -dx * sin + dy * cos;
  return { x: x / safeScale(frame.scale.x), y: y / safeScale(frame.scale.y) };
}

/**
 * Midpoint of each edge, in the same space as `points` (edge i runs from
 * point i to point (i+1) % n).
 */
export function edgeMidpoints(points: readonly Vec2[]): Vec2[] {
  return points.map((p, i) => {
    const q = points[(i + 1) % points.length];
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  });
}

/** New array with the midpoint of edge `edgeIndex` inserted as a vertex. */
export function insertVertexOnEdge(points: readonly Vec2[], edgeIndex: number): Vec2[] {
  const mid = edgeMidpoints(points)[edgeIndex];
  const next = points.map((p) => ({ ...p }));
  next.splice(edgeIndex + 1, 0, mid);
  return next;
}

/**
 * New array without vertex `index`, or null when that would go below `min`
 * points. `min` is 3 for a polygon collider (a degenerate polygon isn't
 * meaningful) and 2 for a LineRenderer (a line needs at least two points).
 */
export function removeVertex(points: readonly Vec2[], index: number, min = 3): Vec2[] | null {
  if (points.length <= min) return null;
  return points.filter((_, i) => i !== index).map((p) => ({ ...p }));
}

/** Round points for a tidy commit (scene JSON stays human-readable). */
export function roundPoints(points: readonly Vec2[]): Vec2[] {
  return points.map((p) => ({
    x: Math.round(p.x * 100) / 100,
    y: Math.round(p.y * 100) / 100,
  }));
}
