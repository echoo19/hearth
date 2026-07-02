/**
 * Physics helpers — AABB construction and minimal-translation-vector math.
 *
 * The v1 collision model is deliberately simple:
 *   - every collider becomes an axis-aligned bounding box (circles use their
 *     bounding box for resolution),
 *   - solid tilemaps contribute one static AABB per non-empty grid cell,
 *   - dynamic bodies are pushed out along the axis of least penetration.
 * Coordinates are pixels, +y is down.
 */
import type { ColliderComponent, TilemapComponent, Vec2 } from '@hearth/core';

/** Gravity in px/s² applied to dynamic bodies (scaled by gravityScale). */
export const GRAVITY = 980;

/** An axis-aligned box described by center + half extents. */
export interface Box {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

/** MTV push for box `a` out of box `b`, or null when not overlapping. */
export interface Push {
  /** Unit axis direction `a` should move (one of ±x / ±y). */
  nx: number;
  ny: number;
  /** Penetration depth along that axis. */
  amount: number;
}

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

/** Zero the velocity component that points against the push normal. */
export function cancelVelocityAlong(velocity: Vec2, nx: number, ny: number): void {
  if (nx !== 0 && velocity.x * nx < 0) velocity.x = 0;
  if (ny !== 0 && velocity.y * ny < 0) velocity.y = 0;
}
