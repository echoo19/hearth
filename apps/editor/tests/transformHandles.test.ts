/**
 * Rotation convention matches polygonEditing.ts / SceneView's SVG rendering:
 * degrees, world = center + R(rotation)·local, R the standard rotation
 * matrix (reads as clockwise on screen because SVG's y axis points down).
 */
import { describe, it, expect } from 'vitest';
import {
  handlePositions,
  hitHandle,
  applyHandleDrag,
  applyCenterHandleDrag,
  resolveHandleTarget,
  cursorFor,
  type SelectionBox,
} from '../src/transformHandles';
import type { SceneEntity } from '../src/types';

const BOX: SelectionBox = { center: { x: 0, y: 0 }, width: 100, height: 60, rotation: 0 };

function at(positions: ReturnType<typeof handlePositions>, id: string) {
  const h = positions.find((p) => p.id === id);
  if (!h) throw new Error(`no handle ${id}`);
  return h;
}

describe('handlePositions', () => {
  it('places the 8 resize handles on the corners/edges of an unrotated box', () => {
    const p = handlePositions(BOX, 1);
    expect(at(p, 'nw')).toEqual({ id: 'nw', x: -50, y: -30 });
    expect(at(p, 'n')).toEqual({ id: 'n', x: 0, y: -30 });
    expect(at(p, 'ne')).toEqual({ id: 'ne', x: 50, y: -30 });
    expect(at(p, 'e')).toEqual({ id: 'e', x: 50, y: 0 });
    expect(at(p, 'se')).toEqual({ id: 'se', x: 50, y: 30 });
    expect(at(p, 's')).toEqual({ id: 's', x: 0, y: 30 });
    expect(at(p, 'sw')).toEqual({ id: 'sw', x: -50, y: 30 });
    expect(at(p, 'w')).toEqual({ id: 'w', x: -50, y: 0 });
  });

  it('offsets the rotate handle above center along local -Y, screen-constant with zoom', () => {
    const zoom1 = at(handlePositions(BOX, 1), 'rotate');
    const zoom2 = at(handlePositions(BOX, 2), 'rotate');
    expect(zoom1.x).toBeCloseTo(0);
    expect(zoom1.y).toBeCloseTo(-30 - 24); // half-height + 24px stem at zoom 1
    expect(zoom2.x).toBeCloseTo(0);
    expect(zoom2.y).toBeCloseTo(-30 - 12); // stem halves at zoom 2 (screen-constant)
    // Box-edge handles are NOT screen-constant: unaffected by zoom.
    expect(at(handlePositions(BOX, 2), 'se')).toEqual({ id: 'se', x: 50, y: 30 });
  });

  it('rotates all handles with the box (90°)', () => {
    const rotated: SelectionBox = { ...BOX, rotation: 90 };
    const p = handlePositions(rotated, 1);
    // local (50,0) 'e' rotated 90° -> world (0,50)
    const e = at(p, 'e');
    expect(e.x).toBeCloseTo(0);
    expect(e.y).toBeCloseTo(50);
    // local (0,-30) 'n' rotated 90° -> world (30,0)
    const n = at(p, 'n');
    expect(n.x).toBeCloseTo(30);
    expect(n.y).toBeCloseTo(0);
    // rotate handle: local (0,-54) rotated 90° -> world (54,0)
    const rot = at(p, 'rotate');
    expect(rot.x).toBeCloseTo(54);
    expect(rot.y).toBeCloseTo(0);
  });

  it('offsets everything by a non-origin box center', () => {
    const box: SelectionBox = { center: { x: 200, y: -50 }, width: 100, height: 60, rotation: 0 };
    expect(at(handlePositions(box, 1), 'nw')).toEqual({ id: 'nw', x: 150, y: -80 });
  });
});

describe('hitHandle', () => {
  it('hits a handle when the point is within the generous screen-constant radius', () => {
    expect(hitHandle(BOX, 1, { x: 50, y: 30 })).toBe('se');
    expect(hitHandle(BOX, 1, { x: 54, y: 30 })).toBe('se'); // within slop
  });

  it('misses when the point is outside every handle radius', () => {
    expect(hitHandle(BOX, 1, { x: 1000, y: 1000 })).toBeNull();
    expect(hitHandle(BOX, 1, { x: 50 + 15, y: 30 })).toBeNull(); // outside 10px slop
  });

  it('shrinks the hit radius (in world space) as zoom increases', () => {
    expect(hitHandle(BOX, 1, { x: 50 + 8, y: 30 })).toBe('se');
    expect(hitHandle(BOX, 4, { x: 50 + 8, y: 30 })).toBeNull(); // 8 world px > 10/4 radius
  });

  it('picks the nearest handle when candidates are close', () => {
    // Between 'n' (0,-30) and 'ne' (50,-30) but much closer to 'n'.
    expect(hitHandle(BOX, 1, { x: 3, y: -30 })).toBe('n');
  });
});

describe('applyHandleDrag: corner resize', () => {
  it('grows both axes and anchors the opposite corner via centerShift', () => {
    const r = applyHandleDrag(BOX, 'se', { x: 50, y: 30 }, { x: 70, y: 40 }, { shift: false });
    expect(r.width).toBeCloseTo(120);
    expect(r.height).toBeCloseTo(70);
    expect(r.centerShift.x).toBeCloseTo(10);
    expect(r.centerShift.y).toBeCloseTo(5);
    expect(r.rotation).toBe(0);

    // nw corner (anchored) must land in the same place before and after.
    const nwBefore = { x: BOX.center.x - BOX.width / 2, y: BOX.center.y - BOX.height / 2 };
    const newCenter = { x: BOX.center.x + r.centerShift.x, y: BOX.center.y + r.centerShift.y };
    const nwAfter = { x: newCenter.x - r.width / 2, y: newCenter.y - r.height / 2 };
    expect(nwAfter.x).toBeCloseTo(nwBefore.x);
    expect(nwAfter.y).toBeCloseTo(nwBefore.y);
  });

  it('unrotates the pointer delta into box-local space before resizing', () => {
    const rotated: SelectionBox = { center: { x: 0, y: 0 }, width: 100, height: 60, rotation: 90 };
    // 'e' handle sits at world (0,50) when rotation=90; dragging it further
    // along the box's own local +X (world +Y here) should grow width only.
    const r = applyHandleDrag(rotated, 'e', { x: 0, y: 50 }, { x: 0, y: 70 }, { shift: false });
    expect(r.width).toBeCloseTo(120);
    expect(r.height).toBeCloseTo(60);
  });

  it('locks aspect ratio when shift is held, still anchoring the opposite corner', () => {
    const box: SelectionBox = { center: { x: 0, y: 0 }, width: 100, height: 50, rotation: 0 };
    const r = applyHandleDrag(box, 'se', { x: 50, y: 25 }, { x: 90, y: 30 }, { shift: true });
    expect(r.width).toBeCloseTo(140);
    expect(r.height).toBeCloseTo(70);
    expect(r.width / r.height).toBeCloseTo(box.width / box.height);
    expect(r.centerShift.x).toBeCloseTo(20);
    expect(r.centerShift.y).toBeCloseTo(10);
  });

  it('clamps to the minimum extent when dragged past collapse, per axis', () => {
    const r = applyHandleDrag(BOX, 'se', { x: 50, y: 30 }, { x: -1000, y: -1000 }, { shift: false });
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);
  });
});

describe('applyHandleDrag: edge resize', () => {
  it('edits a single axis and ignores perpendicular movement', () => {
    const r = applyHandleDrag(BOX, 'e', { x: 50, y: 0 }, { x: 80, y: 15 }, { shift: false });
    expect(r.width).toBeCloseTo(130);
    expect(r.height).toBeCloseTo(60); // unaffected by the y component
    expect(r.centerShift.x).toBeCloseTo(15);
    expect(r.centerShift.y).toBe(0);
  });

  it('anchors the opposite edge (west) while dragging east', () => {
    const r = applyHandleDrag(BOX, 'e', { x: 50, y: 0 }, { x: 80, y: 0 }, { shift: false });
    const westBefore = BOX.center.x - BOX.width / 2;
    const newCenterX = BOX.center.x + r.centerShift.x;
    expect(newCenterX - r.width / 2).toBeCloseTo(westBefore);
  });

  it('dragging west grows width while anchoring the east edge', () => {
    const r = applyHandleDrag(BOX, 'w', { x: -50, y: 0 }, { x: -70, y: 0 }, { shift: false });
    expect(r.width).toBeCloseTo(120);
    const eastBefore = BOX.center.x + BOX.width / 2;
    const newCenterX = BOX.center.x + r.centerShift.x;
    expect(newCenterX + r.width / 2).toBeCloseTo(eastBefore);
  });

  it('clamps a single-axis drag to the minimum extent', () => {
    const r = applyHandleDrag(BOX, 'e', { x: 50, y: 0 }, { x: -1000, y: 0 }, { shift: false });
    expect(r.width).toBe(2);
    expect(r.centerShift.x).toBeCloseTo(-49);
    expect(r.height).toBe(60);
  });
});

describe('applyHandleDrag: rotate', () => {
  const box: SelectionBox = { center: { x: 10, y: 20 }, width: 100, height: 60, rotation: 0 };

  it('reads 0° when the pointer is directly above center (handle rest position)', () => {
    const r = applyHandleDrag(box, 'rotate', { x: 10, y: -80 }, { x: 10, y: -80 }, { shift: false });
    expect(r.rotation).toBeCloseTo(0);
  });

  it('reads 90° when the pointer is directly to the right of center', () => {
    const r = applyHandleDrag(box, 'rotate', { x: 110, y: 20 }, { x: 110, y: 20 }, { shift: false });
    expect(r.rotation).toBeCloseTo(90);
  });

  it('leaves size unchanged and centerShift at zero', () => {
    const r = applyHandleDrag(box, 'rotate', { x: 110, y: 20 }, { x: 110, y: 20 }, { shift: false });
    expect(r.width).toBe(box.width);
    expect(r.height).toBe(box.height);
    expect(r.centerShift).toEqual({ x: 0, y: 0 });
  });

  it('snaps to 15° increments when shift is held', () => {
    // angle ~ 40° unsnapped
    const p = { x: box.center.x + Math.cos(((40 - 90) * Math.PI) / 180) * 50, y: box.center.y + Math.sin(((40 - 90) * Math.PI) / 180) * 50 };
    const r = applyHandleDrag(box, 'rotate', p, p, { shift: true });
    expect(r.rotation).toBeCloseTo(45);
  });
});

describe('resolveHandleTarget', () => {
  function entity(components: Record<string, Record<string, unknown>>): SceneEntity {
    return {
      id: 'e1',
      name: 'Test',
      parentId: null,
      enabled: true,
      tags: [],
      components,
      position: null,
      children: [],
    };
  }
  const BASE = { w: 24, h: 24 };

  it('prefers SpriteRenderer width/height over any collider', () => {
    const t = resolveHandleTarget(
      entity({
        SpriteRenderer: { width: 48, height: 24 },
        Collider: { shape: 'box', width: 100, height: 100 },
      }),
      BASE,
    );
    expect(t).toEqual({
      kind: 'sprite-size',
      component: 'SpriteRenderer',
      property: 'SpriteRenderer.width',
      width: 48,
      height: 24,
    });
  });

  it('applies the schema defaults (32x32) when a sprite omits width/height', () => {
    const t = resolveHandleTarget(entity({ SpriteRenderer: {} }), BASE);
    expect(t.width).toBe(32);
    expect(t.height).toBe(32);
  });

  it('falls back to a box Collider width/height when there is no sprite', () => {
    const t = resolveHandleTarget(entity({ Collider: { shape: 'box', width: 64, height: 40 } }), BASE);
    expect(t).toEqual({
      kind: 'collider-box',
      component: 'Collider',
      property: 'Collider.width',
      width: 64,
      height: 40,
    });
  });

  it('treats a Collider without an explicit shape as a box (the schema default)', () => {
    const t = resolveHandleTarget(entity({ Collider: { width: 10, height: 12 } }), BASE);
    expect(t.kind).toBe('collider-box');
  });

  it('reports a circle Collider as radius*2 on both extents', () => {
    const t = resolveHandleTarget(entity({ Collider: { shape: 'circle', radius: 20 } }), BASE);
    expect(t).toEqual({
      kind: 'collider-circle',
      component: 'Collider',
      property: 'Collider.radius',
      width: 40,
      height: 40,
    });
  });

  it('applies the schema default radius (16) when a circle omits it', () => {
    const t = resolveHandleTarget(entity({ Collider: { shape: 'circle' } }), BASE);
    expect(t.width).toBe(32);
  });

  it('skips polygon colliders (the point editor owns their geometry) to the scale fallback', () => {
    const t = resolveHandleTarget(entity({ Collider: { shape: 'polygon', points: [] }, Transform: {} }), BASE);
    expect(t.kind).toBe('transform-scale');
  });

  it('resolves a UIElement-only entity to the scale fallback (UIElement has no size field)', () => {
    // UIElementSchema is anchor/offset/interactive/focusable only; its visuals
    // come from sibling Text/SpriteRenderer components, which the earlier
    // tiers already catch. So the spec's ui-size tier can never match.
    const t = resolveHandleTarget(entity({ UIElement: { anchor: 'top-left' }, Transform: {} }), BASE);
    expect(t.kind).toBe('transform-scale');
  });

  it('falls back to Transform.scale with the provided base extents (rendered bounds at scale 1)', () => {
    const t = resolveHandleTarget(entity({ Text: { content: 'hi' }, Transform: {} }), { w: 120, h: 30 });
    expect(t).toEqual({
      kind: 'transform-scale',
      component: 'Transform',
      property: 'Transform.scale',
      width: 120,
      height: 30,
    });
  });
});

describe('applyCenterHandleDrag', () => {
  // The editor commits one history entry per command (session.ts snapshots
  // before every mutating command), so an anchored resize (size command +
  // moveEntity for centerShift) would undo in two steps. SceneView therefore
  // resizes about the box center: centerShift is always zero, and the pointer
  // delta is doubled so the grabbed handle still tracks the pointer.
  it('keeps the center fixed (zero centerShift) and tracks the pointer with the grabbed edge', () => {
    const r = applyCenterHandleDrag(BOX, 'e', { x: 50, y: 0 }, { x: 70, y: 0 }, { shift: false });
    expect(r.centerShift).toEqual({ x: 0, y: 0 });
    // width grows by 2x the drag so the east edge lands exactly under the pointer
    expect(r.width).toBeCloseTo(140);
    expect(BOX.center.x + r.width / 2).toBeCloseTo(70);
    expect(r.height).toBe(60);
  });

  it('mirrors corner drags about the center, honoring shift aspect lock', () => {
    const box: SelectionBox = { center: { x: 0, y: 0 }, width: 100, height: 50, rotation: 0 };
    const r = applyCenterHandleDrag(box, 'se', { x: 50, y: 25 }, { x: 70, y: 28 }, { shift: true });
    expect(r.centerShift).toEqual({ x: 0, y: 0 });
    expect(r.width / r.height).toBeCloseTo(box.width / box.height);
    expect(r.width).toBeCloseTo(140); // dominant axis doubled: 100 + 2*20
  });

  it('still clamps to the minimum extent', () => {
    const r = applyCenterHandleDrag(BOX, 'e', { x: 50, y: 0 }, { x: -1000, y: 0 }, { shift: false });
    expect(r.width).toBe(2);
    expect(r.centerShift).toEqual({ x: 0, y: 0 });
  });

  it('unrotates the doubled delta like applyHandleDrag does', () => {
    const rotated: SelectionBox = { center: { x: 0, y: 0 }, width: 100, height: 60, rotation: 90 };
    const r = applyCenterHandleDrag(rotated, 'e', { x: 0, y: 50 }, { x: 0, y: 70 }, { shift: false });
    expect(r.width).toBeCloseTo(140);
    expect(r.height).toBeCloseTo(60);
  });

  it('passes rotate drags through to applyHandleDrag unchanged', () => {
    const box: SelectionBox = { center: { x: 10, y: 20 }, width: 100, height: 60, rotation: 0 };
    const r = applyCenterHandleDrag(box, 'rotate', { x: 10, y: -80 }, { x: 110, y: 20 }, { shift: false });
    expect(r.rotation).toBeCloseTo(90);
    expect(r.width).toBe(100);
    expect(r.centerShift).toEqual({ x: 0, y: 0 });
  });
});

describe('cursorFor', () => {
  it('maps unrotated handles to the standard 4 resize cursors', () => {
    expect(cursorFor('n', 0)).toBe('ns-resize');
    expect(cursorFor('s', 0)).toBe('ns-resize');
    expect(cursorFor('e', 0)).toBe('ew-resize');
    expect(cursorFor('w', 0)).toBe('ew-resize');
    expect(cursorFor('ne', 0)).toBe('nesw-resize');
    expect(cursorFor('sw', 0)).toBe('nesw-resize');
    expect(cursorFor('nw', 0)).toBe('nwse-resize');
    expect(cursorFor('se', 0)).toBe('nwse-resize');
  });

  it('returns grab for the rotate handle regardless of rotation', () => {
    expect(cursorFor('rotate', 0)).toBe('grab');
    expect(cursorFor('rotate', 123)).toBe('grab');
  });

  it('rotates resize cursors to the nearest 45° as the box rotates', () => {
    expect(cursorFor('n', 45)).toBe('nesw-resize');
    expect(cursorFor('n', 90)).toBe('ew-resize');
    expect(cursorFor('n', 135)).toBe('nwse-resize');
    expect(cursorFor('n', 180)).toBe('ns-resize');
    expect(cursorFor('n', 360)).toBe('ns-resize');
  });
});
