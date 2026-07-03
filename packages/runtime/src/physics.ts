/**
 * Physics helpers — collision shape construction and minimal-translation-
 * vector math.
 *
 * Box and circle colliders keep the v1 model: both become axis-aligned
 * bounding boxes (circles use their bounding box) resolved along the axis of
 * least penetration, and solid tilemaps contribute one static AABB per
 * non-empty grid cell. Polygon colliders (convex, validated by core) use SAT
 * against polygons, boxes, and true circles, with the MTV along the axis of
 * least overlap. Coordinates are pixels, +y is down.
 */
import type { ColliderComponent, TilemapComponent, TransformComponent, Vec2 } from '@hearth/core';

/** Gravity in px/s² applied to dynamic bodies (scaled by gravityScale). */
export const GRAVITY = 980;

/** An axis-aligned box described by center + half extents. */
export interface Box {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

/** MTV push for shape `a` out of shape `b`, or null when not overlapping. */
export interface Push {
  /** Unit direction `a` should move (axis-aligned for AABB pairs, any unit vector for SAT). */
  nx: number;
  ny: number;
  /** Penetration depth along that direction. */
  amount: number;
}

/**
 * A collision shape with its bounding box. Box and circle colliders resolve
 * as AABBs (unchanged v1 behavior); polygons carry world-space convex points
 * for SAT, and circles keep their true center/radius for SAT against
 * polygons.
 */
export type CollisionShape =
  | { kind: 'box'; box: Box }
  | { kind: 'circle'; box: Box; x: number; y: number; radius: number }
  | { kind: 'polygon'; box: Box; points: Vec2[] };

/** Build the collision box for a Collider at a world position. */
export function colliderBox(collider: ColliderComponent, worldPos: Vec2): Box {
  const cx = worldPos.x + collider.offset.x;
  const cy = worldPos.y + collider.offset.y;
  if (collider.shape === 'circle') {
    return { cx, cy, hw: collider.radius, hh: collider.radius };
  }
  return { cx, cy, hw: collider.width / 2, hh: collider.height / 2 };
}

/**
 * Build the collision shape for a Collider at a world position. Box and
 * circle colliders ignore Transform scale/rotation (v1 behavior); polygon
 * points are local space, transformed by the entity's scale then rotation,
 * then translated by worldPos + Collider.offset.
 */
export function colliderShape(
  collider: ColliderComponent,
  worldPos: Vec2,
  transform?: Pick<TransformComponent, 'rotation' | 'scale'>,
): CollisionShape {
  if (collider.shape === 'polygon') {
    const cx = worldPos.x + collider.offset.x;
    const cy = worldPos.y + collider.offset.y;
    const rad = ((transform?.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const sx = transform?.scale.x ?? 1;
    const sy = transform?.scale.y ?? 1;
    const points = collider.points.map((p) => {
      const x = p.x * sx;
      const y = p.y * sy;
      return { x: cx + x * cos - y * sin, y: cy + x * sin + y * cos };
    });
    return { kind: 'polygon', box: polygonBounds(points), points };
  }
  const box = colliderBox(collider, worldPos);
  if (collider.shape === 'circle') {
    return { kind: 'circle', box, x: box.cx, y: box.cy, radius: collider.radius };
  }
  return { kind: 'box', box };
}

/** Move a collision shape (used when resolution pushes a mover). */
export function translateShape(shape: CollisionShape, dx: number, dy: number): void {
  shape.box.cx += dx;
  shape.box.cy += dy;
  if (shape.kind === 'circle') {
    shape.x += dx;
    shape.y += dy;
  } else if (shape.kind === 'polygon') {
    for (const p of shape.points) {
      p.x += dx;
      p.y += dy;
    }
  }
}

/**
 * Static boxes for a solid tilemap. `worldPos` is the tilemap's top-left
 * origin; every grid character except '.' and ' ' is solid.
 */
export function tilemapBoxes(tilemap: TilemapComponent, worldPos: Vec2): Box[] {
  const boxes: Box[] = [];
  const ts = tilemap.tileSize;
  const half = ts / 2;
  for (let row = 0; row < tilemap.grid.length; row++) {
    const line = tilemap.grid[row];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === '.' || ch === ' ') continue;
      boxes.push({
        cx: worldPos.x + col * ts + half,
        cy: worldPos.y + row * ts + half,
        hw: half,
        hh: half,
      });
    }
  }
  return boxes;
}

/**
 * Minimal translation to push `a` out of `b`, along the axis of least
 * penetration. Returns null when the boxes do not overlap (edge contact
 * does not count as overlap).
 */
export function computePush(a: Box, b: Box): Push | null {
  const ox = a.hw + b.hw - Math.abs(a.cx - b.cx);
  const oy = a.hh + b.hh - Math.abs(a.cy - b.cy);
  if (ox <= 0 || oy <= 0) return null;
  if (ox < oy) {
    return { nx: a.cx < b.cx ? -1 : 1, ny: 0, amount: ox };
  }
  return { nx: 0, ny: a.cy < b.cy ? -1 : 1, amount: oy };
}

/**
 * MTV push between two collision shapes. Pairs without a polygon keep the v1
 * bounding-box behavior exactly; any pair involving a polygon runs SAT.
 */
export function computeShapePush(a: CollisionShape, b: CollisionShape): Push | null {
  if (a.kind !== 'polygon' && b.kind !== 'polygon') {
    return computePush(a.box, b.box);
  }
  // Cheap AABB reject before SAT.
  if (
    Math.abs(a.box.cx - b.box.cx) >= a.box.hw + b.box.hw ||
    Math.abs(a.box.cy - b.box.cy) >= a.box.hh + b.box.hh
  ) {
    return null;
  }
  if (a.kind === 'circle') {
    return circlePolygonPush(a, shapePoints(b)!);
  }
  if (b.kind === 'circle') {
    const push = circlePolygonPush(b, shapePoints(a)!);
    return push ? { nx: -push.nx, ny: -push.ny, amount: push.amount } : null;
  }
  return polygonPolygonPush(shapePoints(a)!, shapePoints(b)!);
}

/** Zero the velocity component that points against the push normal. */
export function cancelVelocityAlong(velocity: Vec2, nx: number, ny: number): void {
  const along = velocity.x * nx + velocity.y * ny;
  if (along < 0) {
    velocity.x -= along * nx;
    velocity.y -= along * ny;
  }
}

// ---------------------------------------------------------------------------
// SAT internals
// ---------------------------------------------------------------------------

function polygonBounds(points: Vec2[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, hw: (maxX - minX) / 2, hh: (maxY - minY) / 2 };
}

/** World-space corner list for SAT (null for circles). */
function shapePoints(shape: CollisionShape): Vec2[] | null {
  if (shape.kind === 'polygon') return shape.points;
  if (shape.kind === 'circle') return null;
  const { cx, cy, hw, hh } = shape.box;
  return [
    { x: cx - hw, y: cy - hh },
    { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh },
    { x: cx - hw, y: cy + hh },
  ];
}

function projectPoints(points: Vec2[], ax: number, ay: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const d = p.x * ax + p.y * ay;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

function centroid(points: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** Unit edge normals of a polygon (winding-agnostic; orientation fixed later). */
function edgeAxes(points: Vec2[], out: Vec2[]): void {
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const len = Math.hypot(ex, ey);
    if (len === 0) continue; // degenerate edge — validation rejects these, be safe
    out.push({ x: -ey / len, y: ex / len });
  }
}

/**
 * SAT for two convex polygons. Returns the minimal push that moves `a` out
 * of `b`, oriented from `b`'s centroid toward `a`'s.
 */
function polygonPolygonPush(a: Vec2[], b: Vec2[]): Push | null {
  const axes: Vec2[] = [];
  edgeAxes(a, axes);
  edgeAxes(b, axes);
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (const axis of axes) {
    const pa = projectPoints(a, axis.x, axis.y);
    const pb = projectPoints(b, axis.x, axis.y);
    const overlap = Math.min(pa.max, pb.max) - Math.max(pa.min, pb.min);
    if (overlap <= 0) return null;
    if (overlap < best) {
      best = overlap;
      bx = axis.x;
      by = axis.y;
    }
  }
  const ca = centroid(a);
  const cb = centroid(b);
  if ((ca.x - cb.x) * bx + (ca.y - cb.y) * by < 0) {
    bx = -bx;
    by = -by;
  }
  return { nx: bx, ny: by, amount: best };
}

/**
 * SAT for a circle vs a convex polygon. Axes are the polygon edge normals
 * plus the axis from the closest polygon vertex to the circle center.
 * Returns the push that moves the circle out of the polygon.
 */
function circlePolygonPush(
  circle: { x: number; y: number; radius: number },
  poly: Vec2[],
): Push | null {
  const axes: Vec2[] = [];
  edgeAxes(poly, axes);
  let closest: Vec2 | null = null;
  let closestDist = Infinity;
  for (const p of poly) {
    const d = (p.x - circle.x) ** 2 + (p.y - circle.y) ** 2;
    if (d < closestDist) {
      closestDist = d;
      closest = p;
    }
  }
  if (closest && closestDist > 0) {
    const len = Math.sqrt(closestDist);
    axes.push({ x: (closest.x - circle.x) / len, y: (closest.y - circle.y) / len });
  }
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (const axis of axes) {
    const pp = projectPoints(poly, axis.x, axis.y);
    const c = circle.x * axis.x + circle.y * axis.y;
    const overlap = Math.min(c + circle.radius, pp.max) - Math.max(c - circle.radius, pp.min);
    if (overlap <= 0) return null;
    if (overlap < best) {
      best = overlap;
      bx = axis.x;
      by = axis.y;
    }
  }
  const cp = centroid(poly);
  if ((circle.x - cp.x) * bx + (circle.y - cp.y) * by < 0) {
    bx = -bx;
    by = -by;
  }
  return { nx: bx, ny: by, amount: best };
}
