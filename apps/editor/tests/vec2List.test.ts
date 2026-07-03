import { describe, it, expect } from 'vitest';
import { setPointAxis, removePoint, addPoint } from '../src/vec2List';

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
  it('removes the point at index, no minimum enforced here', () => {
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }];
    expect(removePoint(points, 1)).toEqual([{ x: 0, y: 0 }, { x: 2, y: 2 }]);
  });

  it('can empty the list — Vec2ListField, unlike the canvas editor, has no floor', () => {
    expect(removePoint([{ x: 0, y: 0 }], 0)).toEqual([]);
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
