/**
 * Cell-coordinate math and stroke-accumulation for the Scene view's tilemap
 * paint tool (see tilemapPaint.ts's module doc).
 */
import { describe, it, expect } from 'vitest';
import {
  worldToCell,
  cellKey,
  isCellInBounds,
  addStrokeCell,
  filterInBounds,
  normalizeRect,
  clampRectToGrid,
  type TileCell,
} from '../src/tilemapPaint';

describe('worldToCell', () => {
  it('maps the entity origin to cell (0, 0)', () => {
    expect(worldToCell({ x: 0, y: 0 }, { x: 0, y: 0 }, 32)).toEqual({ x: 0, y: 0 });
  });

  it('floors within a cell rather than rounding', () => {
    expect(worldToCell({ x: 31, y: 31 }, { x: 0, y: 0 }, 32)).toEqual({ x: 0, y: 0 });
    expect(worldToCell({ x: 32, y: 32 }, { x: 0, y: 0 }, 32)).toEqual({ x: 1, y: 1 });
  });

  it('offsets by the entity world position', () => {
    expect(worldToCell({ x: 164, y: 96 }, { x: 100, y: 32 }, 32)).toEqual({ x: 2, y: 2 });
  });

  it('floors toward negative infinity left/above the origin (never toward zero)', () => {
    expect(worldToCell({ x: -1, y: -1 }, { x: 0, y: 0 }, 32)).toEqual({ x: -1, y: -1 });
    expect(worldToCell({ x: -32, y: -33 }, { x: 0, y: 0 }, 32)).toEqual({ x: -1, y: -2 });
  });

  it('row 0 is the top: a world y just below origin.y is row 0, not negative', () => {
    expect(worldToCell({ x: 5, y: 5 }, { x: 0, y: 0 }, 32)).toEqual({ x: 0, y: 0 });
  });
});

describe('cellKey / isCellInBounds', () => {
  const grid = ['GGGG', 'G..G', 'GGGG'];

  it('formats a stable "x,y" key', () => {
    expect(cellKey({ x: 3, y: 5 })).toBe('3,5');
  });

  it('accepts cells within the grid rows', () => {
    expect(isCellInBounds({ x: 0, y: 0 }, grid)).toBe(true);
    expect(isCellInBounds({ x: 3, y: 2 }, grid)).toBe(true);
  });

  it('rejects negative coordinates', () => {
    expect(isCellInBounds({ x: -1, y: 0 }, grid)).toBe(false);
    expect(isCellInBounds({ x: 0, y: -1 }, grid)).toBe(false);
  });

  it('rejects coordinates past the row/grid extent', () => {
    expect(isCellInBounds({ x: 4, y: 0 }, grid)).toBe(false);
    expect(isCellInBounds({ x: 0, y: 3 }, grid)).toBe(false);
  });

  it('is row-length aware for a ragged grid', () => {
    const ragged = ['GGGG', 'GG'];
    expect(isCellInBounds({ x: 3, y: 1 }, ragged)).toBe(false);
    expect(isCellInBounds({ x: 1, y: 1 }, ragged)).toBe(true);
  });
});

describe('addStrokeCell', () => {
  it('appends a new cell', () => {
    const result = addStrokeCell([], { x: 0, y: 0, char: 'G' });
    expect(result).toEqual([{ x: 0, y: 0, char: 'G' }]);
  });

  it('dedups a revisited cell, updating its char rather than appending a duplicate', () => {
    const first: TileCell[] = [{ x: 0, y: 0, char: 'G' }, { x: 1, y: 0, char: 'G' }];
    const result = addStrokeCell(first, { x: 0, y: 0, char: '.' });
    expect(result).toHaveLength(2);
    expect(result).toEqual([
      { x: 0, y: 0, char: '.' },
      { x: 1, y: 0, char: 'G' },
    ]);
  });

  it('does not mutate the input array', () => {
    const first: TileCell[] = [{ x: 0, y: 0, char: 'G' }];
    addStrokeCell(first, { x: 1, y: 0, char: 'G' });
    expect(first).toHaveLength(1);
  });
});

describe('filterInBounds', () => {
  it('drops cells outside the grid, keeping the rest', () => {
    const grid = ['GGGG', 'GGGG'];
    const cells: TileCell[] = [
      { x: 0, y: 0, char: 'G' },
      { x: 10, y: 0, char: 'G' },
      { x: 1, y: -1, char: 'G' },
      { x: 2, y: 1, char: 'G' },
    ];
    expect(filterInBounds(cells, grid)).toEqual([
      { x: 0, y: 0, char: 'G' },
      { x: 2, y: 1, char: 'G' },
    ]);
  });
});

describe('normalizeRect', () => {
  it('is a no-op when a is already the top-left corner', () => {
    expect(normalizeRect({ x: 1, y: 1 }, { x: 3, y: 4 })).toEqual({ x: 1, y: 1, width: 3, height: 4 });
  });

  it('normalizes when b is the top-left corner (drag went up-left)', () => {
    expect(normalizeRect({ x: 3, y: 4 }, { x: 1, y: 1 })).toEqual({ x: 1, y: 1, width: 3, height: 4 });
  });

  it('normalizes mixed corners', () => {
    expect(normalizeRect({ x: 5, y: 0 }, { x: 0, y: 3 })).toEqual({ x: 0, y: 0, width: 6, height: 4 });
  });

  it('a single cell is a 1x1 rect', () => {
    expect(normalizeRect({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual({ x: 2, y: 2, width: 1, height: 1 });
  });
});

describe('clampRectToGrid', () => {
  const grid = ['GGGG', 'GGGG', 'GGGG', 'GGGG'];

  it('passes through a rect already fully inside the grid', () => {
    expect(clampRectToGrid({ x: 1, y: 1, width: 2, height: 2 }, grid)).toEqual({
      x: 1,
      y: 1,
      width: 2,
      height: 2,
    });
  });

  it('clamps a rect that overhangs the right/bottom edge', () => {
    expect(clampRectToGrid({ x: 2, y: 2, width: 10, height: 10 }, grid)).toEqual({
      x: 2,
      y: 2,
      width: 2,
      height: 2,
    });
  });

  it('clamps a rect that overhangs the top/left edge', () => {
    expect(clampRectToGrid({ x: -3, y: -3, width: 5, height: 5 }, grid)).toEqual({
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    });
  });

  it('returns null for a rect entirely outside the grid', () => {
    expect(clampRectToGrid({ x: 10, y: 10, width: 2, height: 2 }, grid)).toBeNull();
    expect(clampRectToGrid({ x: -5, y: 0, width: 2, height: 2 }, grid)).toBeNull();
  });

  it('returns null for an empty grid', () => {
    expect(clampRectToGrid({ x: 0, y: 0, width: 2, height: 2 }, [])).toBeNull();
  });
});
