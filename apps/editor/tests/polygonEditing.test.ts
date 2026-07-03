/**
 * The polygon editor's local↔world math must match the runtime's
 * colliderShape() transform (scale, then rotation, then worldPos + offset,
 * with the offset untransformed).
 */
import { describe, it, expect } from 'vitest';
import {
  polygonLocalToWorld,
  polygonWorldToLocal,
  edgeMidpoints,
  insertVertexOnEdge,
  removeVertex,
  roundPoints,
  type PolygonFrame,
} from '../src/polygonEditing';

const IDENTITY: PolygonFrame = {
  worldPos: { x: 0, y: 0 },
  offset: { x: 0, y: 0 },
  rotation: 0,
  scale: { x: 1, y: 1 },
};

describe('polygonLocalToWorld', () => {
  it('translates by worldPos + offset with an identity transform', () => {
    const frame: PolygonFrame = { ...IDENTITY, worldPos: { x: 100, y: 50 }, offset: { x: 4, y: -6 } };
    expect(polygonLocalToWorld({ x: 10, y: 20 }, frame)).toEqual({ x: 114, y: 64 });
  });

  it('applies scale before rotation, like the runtime', () => {
    // Runtime math: x' = cx + (px·sx)cosθ - (py·sy)sinθ ; y' = cy + (px·sx)sinθ + (py·sy)cosθ
    const frame: PolygonFrame = {
      worldPos: { x: 10, y: 10 },
      offset: { x: 0, y: 0 },
      rotation: 90,
      scale: { x: 2, y: 3 },
    };
    const w = polygonLocalToWorld({ x: 1, y: 0 }, frame);
    // (1,0) scaled → (2,0), rotated 90° → (0,2), translated → (10,12)
    expect(w.x).toBeCloseTo(10);
    expect(w.y).toBeCloseTo(12);
  });

  it('does not rotate or scale the collider offset', () => {
    const frame: PolygonFrame = {
      worldPos: { x: 0, y: 0 },
      offset: { x: 5, y: 0 },
      rotation: 180,
      scale: { x: 2, y: 2 },
    };
    const w = polygonLocalToWorld({ x: 0, y: 0 }, frame);
    expect(w.x).toBeCloseTo(5); // offset stays +5, not rotated to -5 or doubled
    expect(w.y).toBeCloseTo(0);
  });

  it('treats a zero scale component as 1 so handles stay editable', () => {
    const frame: PolygonFrame = { ...IDENTITY, scale: { x: 0, y: 2 } };
    const w = polygonLocalToWorld({ x: 3, y: 4 }, frame);
    expect(w).toEqual({ x: 3, y: 8 });
  });
});

describe('polygonWorldToLocal', () => {
  it('round-trips with local→world across rotation, scale, and offset', () => {
    const frame: PolygonFrame = {
      worldPos: { x: -40, y: 120 },
      offset: { x: 8, y: -3 },
      rotation: 37,
      scale: { x: 1.5, y: 0.75 },
    };
    for (const p of [
      { x: 0, y: -16 },
      { x: 16, y: 16 },
      { x: -16, y: 16 },
      { x: 123.4, y: -56.7 },
    ]) {
      const back = polygonWorldToLocal(polygonLocalToWorld(p, frame), frame);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('round-trips with negative scale (flipped entities)', () => {
    const frame: PolygonFrame = { ...IDENTITY, rotation: -90, scale: { x: -1, y: 2 } };
    const p = { x: 7, y: -9 };
    const back = polygonWorldToLocal(polygonLocalToWorld(p, frame), frame);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });
});

describe('edge helpers', () => {
  const triangle = [
    { x: 0, y: -16 },
    { x: 16, y: 16 },
    { x: -16, y: 16 },
  ];

  it('computes one midpoint per edge, wrapping the last edge', () => {
    const mids = edgeMidpoints(triangle);
    expect(mids).toHaveLength(3);
    expect(mids[0]).toEqual({ x: 8, y: 0 });
    expect(mids[2]).toEqual({ x: -8, y: 0 }); // last → first
  });

  it('insertVertexOnEdge puts the midpoint between the edge endpoints', () => {
    const next = insertVertexOnEdge(triangle, 0);
    expect(next).toHaveLength(4);
    expect(next[1]).toEqual({ x: 8, y: 0 });
    expect(next[0]).toEqual(triangle[0]);
    expect(next[2]).toEqual(triangle[1]);
    // Source array is untouched.
    expect(triangle).toHaveLength(3);
  });

  it('removeVertex refuses to go below 3 points', () => {
    expect(removeVertex(triangle, 0)).toBeNull();
    const square = [...triangle, { x: 0, y: 32 }];
    const next = removeVertex(square, 3);
    expect(next).toEqual(triangle);
  });

  it('roundPoints keeps two decimals', () => {
    expect(roundPoints([{ x: 1.23456, y: -0.006 }])).toEqual([{ x: 1.23, y: -0.01 }]);
  });
});
