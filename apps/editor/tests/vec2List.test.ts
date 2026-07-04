import { describe, it, expect } from 'vitest';
import { setPointAxis, removePoint, addPoint, shouldHideField } from '../src/vec2List';

describe('setPointAxis', () => {
  it('updates one axis of one point, leaving the rest untouched', () => {
    const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
    expect(setPointAxis(points, 1, 'y', 40)).toEqual([{ x: 1, y: 2 }, { x: 3, y: 40 }]);
    // source array untouched
    expect(points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  });

  it('updates the x axis', () => {
    const points = [{ x: 1, y: 2 }];
    expect(setPointAxis(points, 0, 'x', 99)).toEqual([{ x: 99, y: 2 }]);
  });
});

describe('removePoint', () => {
  it('removes the point at index', () => {
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }];
    expect(removePoint(points, 1)).toEqual([{ x: 0, y: 0 }, { x: 2, y: 2 }]);
  });

  it('can empty the list when no minimum is given', () => {
    expect(removePoint([{ x: 0, y: 0 }], 0)).toEqual([]);
  });

  it('clamps at the per-component floor, matching the canvas editor', () => {
    const triangle = [{ x: 0, y: -16 }, { x: 16, y: 16 }, { x: -16, y: 16 }];
    // Polygon collider floor (3): removal refused at exactly 3 points.
    expect(removePoint(triangle, 0, 3)).toBeNull();
    expect(removePoint([...triangle, { x: 0, y: 32 }], 3, 3)).toEqual(triangle);
    // LineRenderer floor (2): removal refused at exactly 2 points.
    const pair = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(removePoint(pair, 0, 2)).toBeNull();
    expect(removePoint([...pair, { x: 20, y: 0 }], 2, 2)).toEqual(pair);
  });
});

describe('addPoint', () => {
  it('appends a copy of the last point', () => {
    const points = [{ x: 5, y: 6 }];
    const next = addPoint(points);
    expect(next).toEqual([{ x: 5, y: 6 }, { x: 5, y: 6 }]);
    // the appended point is a distinct object, not an alias of the source
    expect(next[1]).not.toBe(points[0]);
  });

  it('appends the origin when the list is empty', () => {
    expect(addPoint([])).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('shouldHideField', () => {
  it('hides Collider.points for box and circle shapes', () => {
    expect(shouldHideField('Collider', 'points', { shape: 'box' })).toBe(true);
    expect(shouldHideField('Collider', 'points', { shape: 'circle' })).toBe(true);
  });

  it('shows Collider.points for a polygon shape', () => {
    expect(shouldHideField('Collider', 'points', { shape: 'polygon' })).toBe(false);
  });

  it('never hides other components points field, e.g. LineRenderer', () => {
    expect(shouldHideField('LineRenderer', 'points', {})).toBe(false);
  });

  it('never hides other Collider fields', () => {
    expect(shouldHideField('Collider', 'width', { shape: 'box' })).toBe(false);
  });
});
