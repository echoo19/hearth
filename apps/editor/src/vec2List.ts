/**
 * Pure array helpers for the Inspector's Vec2ListField control — the row
 * editor for Vec2[] fields (LineRenderer.points, Collider.points polygon
 * points). Kept separate from Inspector.tsx so the list-editing logic is
 * unit-testable without a DOM (see gizmo/SVG code, which is verified
 * visually instead).
 */
import type { Vec2 } from './types';

/** New array with `axis` of the point at `index` set to `value`. */
export function setPointAxis(points: readonly Vec2[], index: number, axis: 'x' | 'y', value: number): Vec2[] {
  return points.map((p, i) => (i === index ? { ...p, [axis]: value } : p));
}

/** New array without the point at `index`. */
export function removePoint(points: readonly Vec2[], index: number): Vec2[] {
  return points.filter((_, i) => i !== index);
}

/** New array with a point appended: a copy of the last point, or the origin for an empty list. */
export function addPoint(points: readonly Vec2[]): Vec2[] {
  const last = points[points.length - 1];
  return [...points, last ? { ...last } : { x: 0, y: 0 }];
}
