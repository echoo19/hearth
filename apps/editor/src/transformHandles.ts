/**
 * Pure math for the Scene view's transform-handle gizmo: the 8 resize
 * handles + 1 rotate handle drawn on a selected entity's bounding box.
 * SceneView (Task 10) resolves which component a drag actually edits
 * (HandleTarget) and turns DragResult into a scene-JSON patch; this module
 * only knows about an abstract, already-rotated `SelectionBox`.
 *
 * Rotation convention matches `polygonEditing.ts` / SceneView's SVG
 * rendering exactly: `rotation` is degrees, and world = center + R(rotation)
 * · local where R is the standard rotation matrix
 *   x' = x·cosθ - y·sinθ
 *   y' = x·sinθ + y·cosθ
 * Because SVG's y axis points down, this reads as *clockwise* on screen —
 * e.g. rotating by +90° swings local "up" (0,-1) to screen "right" (1,0).
 * See SceneView.tsx's `<g transform="rotate(${rot})">` on the selection
 * outline, and polygonEditing.ts's PolygonFrame doc comment.
 *
 * Screen-constant sizing: anything that should look the same size on screen
 * regardless of zoom (hit radius, the rotate handle's stem length) is a
 * fixed pixel constant divided by `zoom` — mirroring SceneView's own
 * `r = 4 / view.s` pattern for vertex handles. Box-edge handle positions
 * are NOT screen-constant: they sit exactly on the box's world-space edges.
 */
import type { SceneEntity, Vec2 } from './types';

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

/** What a drag gesture edits; resolved and interpreted by Task 10 (SceneView). */
export interface HandleTarget {
  kind: 'sprite-size' | 'collider-box' | 'collider-circle' | 'ui-size' | 'transform-scale';
  /** Current extent in world px (a circle collider reports radius*2 for both). */
  width: number;
  height: number;
}

/** The selected entity's bounding box, in world space. */
export interface SelectionBox {
  center: Vec2;
  width: number;
  height: number;
  /** Degrees; same convention as Transform.rotation. */
  rotation: number;
}

export interface DragResult {
  width: number;
  height: number;
  rotation: number;
  /** World-space shift to apply to the box (and underlying transform) center. */
  centerShift: Vec2;
}

/** Screen pixels the rotate handle's stem extends above the box's north edge. */
const ROTATE_STEM_PX = 24;
/** Screen pixels of hit-test slop around each handle (generous, easy to grab). */
const HIT_RADIUS_PX = 10;
/** A box edited by a size handle never collapses below this world-space extent. */
const MIN_EXTENT = 2;
/** Rotate-handle shift snap increment, in degrees. */
const ROTATE_SNAP_DEG = 15;

const CORNER_IDS: ReadonlySet<HandleId> = new Set(['nw', 'ne', 'se', 'sw']);

/** Unrotated (box-local) offset of each resize handle from the box center. */
function localOffset(id: Exclude<HandleId, 'rotate'>, width: number, height: number): Vec2 {
  const hw = width / 2;
  const hh = height / 2;
  switch (id) {
    case 'nw':
      return { x: -hw, y: -hh };
    case 'n':
      return { x: 0, y: -hh };
    case 'ne':
      return { x: hw, y: -hh };
    case 'e':
      return { x: hw, y: 0 };
    case 'se':
      return { x: hw, y: hh };
    case 's':
      return { x: 0, y: hh };
    case 'sw':
      return { x: -hw, y: hh };
    case 'w':
      return { x: -hw, y: 0 };
  }
}

/** Rotate a vector by `degrees`, forward (box-local → world). */
function rotateVec(v: Vec2, degrees: number): Vec2 {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

/** Inverse of {@link rotateVec}: world → box-local. */
function unrotateVec(v: Vec2, degrees: number): Vec2 {
  return rotateVec(v, -degrees);
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

const RESIZE_IDS: Exclude<HandleId, 'rotate'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * World-space position of every handle: the 8 resize handles sit exactly on
 * the rotated box's corners/edge-midpoints; the rotate handle sits a
 * screen-constant distance above the box's local -Y (its "top"), further
 * offset by that same stem from the `n` handle so it never overlaps it.
 */
export function handlePositions(box: SelectionBox, zoom: number): Array<{ id: HandleId; x: number; y: number }> {
  const z = zoom > 0 ? zoom : 1;
  const results: Array<{ id: HandleId; x: number; y: number }> = RESIZE_IDS.map((id) => {
    const world = rotateVec(localOffset(id, box.width, box.height), box.rotation);
    return { id, x: box.center.x + world.x, y: box.center.y + world.y };
  });

  const stem = ROTATE_STEM_PX / z;
  const rotateLocal: Vec2 = { x: 0, y: -box.height / 2 - stem };
  const rotateWorld = rotateVec(rotateLocal, box.rotation);
  results.push({ id: 'rotate', x: box.center.x + rotateWorld.x, y: box.center.y + rotateWorld.y });

  return results;
}

/** The handle nearest `point` within a generous, screen-constant radius, or null. */
export function hitHandle(box: SelectionBox, zoom: number, point: Vec2): HandleId | null {
  const z = zoom > 0 ? zoom : 1;
  const radius = HIT_RADIUS_PX / z;
  let best: HandleId | null = null;
  let bestDist = Infinity;
  for (const h of handlePositions(box, zoom)) {
    const dx = point.x - h.x;
    const dy = point.y - h.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= radius && dist < bestDist) {
      best = h.id;
      bestDist = dist;
    }
  }
  return best;
}

function applyResizeDrag(box: SelectionBox, id: Exclude<HandleId, 'rotate'>, start: Vec2, current: Vec2, mods: { shift: boolean }): DragResult {
  const worldDelta: Vec2 = { x: current.x - start.x, y: current.y - start.y };
  const local = unrotateVec(worldDelta, box.rotation);

  const signX = id.includes('w') ? -1 : id.includes('e') ? 1 : 0;
  const signY = id.includes('n') ? -1 : id.includes('s') ? 1 : 0;

  let newWidth = box.width;
  let newHeight = box.height;

  if (CORNER_IDS.has(id) && mods.shift && box.width > 0 && box.height > 0) {
    // Aspect-locked: pick whichever axis the pointer moved further along
    // (in width-equivalent terms) and scale both dimensions uniformly so
    // the anchored opposite corner stays put and the aspect ratio holds.
    const aspect = box.width / box.height;
    const dwFromX = signX * local.x;
    const dwFromY = signY * local.y * aspect;
    const dw = Math.abs(dwFromX) >= Math.abs(dwFromY) ? dwFromX : dwFromY;
    let scale = 1 + dw / box.width;
    const minScale = Math.max(MIN_EXTENT / box.width, MIN_EXTENT / box.height);
    scale = Math.max(scale, minScale);
    newWidth = box.width * scale;
    newHeight = box.height * scale;
  } else {
    if (signX !== 0) {
      newWidth = Math.max(MIN_EXTENT, box.width + signX * local.x);
    }
    if (signY !== 0) {
      newHeight = Math.max(MIN_EXTENT, box.height + signY * local.y);
    }
  }

  const localShift: Vec2 = {
    x: signX !== 0 ? ((newWidth - box.width) * signX) / 2 : 0,
    y: signY !== 0 ? ((newHeight - box.height) * signY) / 2 : 0,
  };
  const centerShift = rotateVec(localShift, box.rotation);

  return { width: newWidth, height: newHeight, rotation: box.rotation, centerShift };
}

function applyRotateDrag(box: SelectionBox, current: Vec2, mods: { shift: boolean }): DragResult {
  const v: Vec2 = { x: current.x - box.center.x, y: current.y - box.center.y };
  // Handle-local "up" (0,-1) maps to world angle -90°, so add 90° to align
  // atan2's 0° (world +X) with the handle's rest position (local -Y).
  let angle = normalizeDeg((Math.atan2(v.y, v.x) * 180) / Math.PI + 90);
  if (mods.shift) {
    angle = normalizeDeg(Math.round(angle / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG);
  }
  return { width: box.width, height: box.height, rotation: angle, centerShift: { x: 0, y: 0 } };
}

/**
 * Computes the result of dragging handle `id` from `start` to `current`
 * (both world-space pointer positions). Resize handles work in box-local
 * space (the world delta is unrotated by `box.rotation` first) so a drag
 * along the box's own edge always changes size, never rotation. The
 * opposite edge/corner stays anchored — `centerShift` is how far the box
 * center (and thus the underlying transform) must move to keep it there.
 */
export function applyHandleDrag(box: SelectionBox, id: HandleId, start: Vec2, current: Vec2, mods: { shift: boolean }): DragResult {
  if (id === 'rotate') return applyRotateDrag(box, current, mods);
  return applyResizeDrag(box, id, start, current, mods);
}

/**
 * Center-anchored variant of {@link applyHandleDrag}, used by SceneView for
 * the actual gesture. Why not anchored resize: the editor records ONE undo
 * history entry per command (HearthSession.execute snapshots the project
 * before every mutating command — see packages/core/src/session.ts — and
 * `undo` restores one entry per call), so committing an anchored resize
 * would take a size setComponentProperty PLUS a moveEntity for centerShift
 * = two undo steps for one gesture. Resizing about the center keeps the
 * commit to strictly one size command (centerShift is always zero).
 *
 * The pointer delta is doubled before delegating so the grabbed handle
 * still tracks the pointer: growing symmetrically about the center moves
 * each edge by half the extent change. Rotate drags pass through unchanged
 * (rotation already pivots on the center).
 */
export function applyCenterHandleDrag(box: SelectionBox, id: HandleId, start: Vec2, current: Vec2, mods: { shift: boolean }): DragResult {
  if (id === 'rotate') return applyRotateDrag(box, current, mods);
  const doubled: Vec2 = { x: start.x + (current.x - start.x) * 2, y: start.y + (current.y - start.y) * 2 };
  const result = applyResizeDrag(box, id, start, doubled, mods);
  return { ...result, centerShift: { x: 0, y: 0 } };
}

/** What a SceneView handle drag on `entity` actually edits. */
export interface ResolvedHandleTarget extends HandleTarget {
  component: 'SpriteRenderer' | 'Collider' | 'Transform';
  /**
   * Dot path of the (primary) property the commit writes. `sprite-size` and
   * `collider-box` extents live in two separate scalar schema leaves
   * (`.width`/`.height` — there is no vec-shaped size property), so for
   * those kinds this names the width leaf and the height leaf is the
   * `.height` sibling.
   */
  property: string;
}

/**
 * Resolve which component a transform-handle drag edits, in spec priority
 * order: SpriteRenderer.width/height → box Collider.width/height → circle
 * Collider.radius (any handle drags the radius uniformly) → Transform.scale.
 *
 * The spec's `UIElement.size` tier is unreachable in this schema: UIElement
 * is anchor/offset/interactive/focusable only (its visuals come from sibling
 * Text/SpriteRenderer components, which the earlier tiers catch), so
 * UIElement-only entities fall through to the scale fallback.
 *
 * Polygon colliders are skipped too — the point editor owns their geometry,
 * and Transform.scale is how the runtime scales their points.
 *
 * `base` is the entity's rendered bounds at scale 1 (SceneView's boundsOf),
 * used only by the `transform-scale` fallback: newScale = newExtent / base.
 * Extents returned are component-local (unscaled) values; SceneView worlds
 * them per kind (physics ignores Transform scale for box/circle colliders).
 */
export function resolveHandleTarget(entity: SceneEntity, base: { w: number; h: number }): ResolvedHandleTarget {
  const sr = entity.components.SpriteRenderer as { width?: number; height?: number } | undefined;
  if (sr) {
    return {
      kind: 'sprite-size',
      component: 'SpriteRenderer',
      property: 'SpriteRenderer.width',
      width: sr.width ?? 32,
      height: sr.height ?? 32,
    };
  }
  const collider = entity.components.Collider as
    | { shape?: string; width?: number; height?: number; radius?: number }
    | undefined;
  if (collider && (collider.shape === 'box' || collider.shape === undefined)) {
    return {
      kind: 'collider-box',
      component: 'Collider',
      property: 'Collider.width',
      width: collider.width ?? 32,
      height: collider.height ?? 32,
    };
  }
  if (collider?.shape === 'circle') {
    const radius = collider.radius ?? 16;
    return {
      kind: 'collider-circle',
      component: 'Collider',
      property: 'Collider.radius',
      width: radius * 2,
      height: radius * 2,
    };
  }
  return {
    kind: 'transform-scale',
    component: 'Transform',
    property: 'Transform.scale',
    width: base.w,
    height: base.h,
  };
}

const CURSOR_BASE_ANGLE: Record<Exclude<HandleId, 'rotate'>, number> = {
  n: 0,
  ne: 45,
  e: 90,
  se: 135,
  s: 180,
  sw: 225,
  w: 270,
  nw: 315,
};

/**
 * CSS resize cursor for handle `id`, rotated to the nearest 45° so it keeps
 * pointing along the handle's actual on-screen direction as the box
 * rotates. Only 4 distinct resize cursors exist (they repeat every 180°).
 */
export function cursorFor(id: HandleId, rotation: number): string {
  if (id === 'rotate') return 'grab';
  const total = CURSOR_BASE_ANGLE[id] + rotation;
  const snapped = (((Math.round(total / 45) * 45) % 180) + 180) % 180;
  switch (snapped) {
    case 45:
      return 'nesw-resize';
    case 90:
      return 'ew-resize';
    case 135:
      return 'nwse-resize';
    default:
      return 'ns-resize';
  }
}
