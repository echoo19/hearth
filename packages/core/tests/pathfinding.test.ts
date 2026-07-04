import { describe, it, expect } from 'vitest';
import { buildNavGrid, findPath, collectNavSolids } from '@hearth/core';

const wall = (x: number, y: number, w = 32, h = 32) => ({ x, y, width: w, height: h });

describe('buildNavGrid', () => {
  it('marks cells solid on >1% area overlap, not edge contact', () => {
    const grid = buildNavGrid({ cellSize: 32, solids: [wall(32, 32)] });
    const cellAt = (wx: number, wy: number) => {
      const col = Math.floor((wx - grid.originX) / grid.cellSize);
      const row = Math.floor((wy - grid.originY) / grid.cellSize);
      return grid.solid[row * grid.cols + col];
    };
    expect(cellAt(48, 48)).toBe(1);  // fully covered cell
    expect(cellAt(16, 48)).toBe(0);  // edge-adjacent cell (exact edge contact) stays walkable
  });
  it('pads bounds by 2 cells and includes query points', () => {
    const grid = buildNavGrid({ cellSize: 32, solids: [wall(0, 0)], include: [{ x: 500, y: 0 }] });
    expect(grid.originX).toBeLessThanOrEqual(-64);
    expect(grid.originX + grid.cols * 32).toBeGreaterThan(500);
  });
  it('throws over 512x512 cells', () => {
    expect(() =>
      buildNavGrid({ cellSize: 1, solids: [wall(0, 0, 1, 1), wall(600, 600, 1, 1)] }),
    ).toThrow(/max 512x512/);
  });
});

describe('findPath', () => {
  // 5x5 open field with a full-height vertical wall at col 2, gap at row 4 (bottom)
  const solids = [wall(64, 0, 32, 32), wall(64, 32), wall(64, 64), wall(64, 96)];
  const grid = buildNavGrid({ cellSize: 32, solids, include: [{ x: 16, y: 16 }, { x: 144, y: 16 }] });
  it('routes around the wall, 4-directional', () => {
    const path = findPath(grid, { x: 16, y: 16 }, { x: 144, y: 16 });
    expect(path).not.toBeNull();
    // Waypoints are cell centers: every step differs by exactly one axis, 32px
    for (let i = 1; i < path!.length; i++) {
      const dx = Math.abs(path![i].x - path![i - 1].x);
      const dy = Math.abs(path![i].y - path![i - 1].y);
      expect(dx + dy).toBe(32);
    }
    expect(path![0]).toEqual({ x: 16, y: 16 });
    expect(path![path!.length - 1]).toEqual({ x: 144, y: 16 });
  });
  it('diagonals shorten the path and never cut corners', () => {
    const p4 = findPath(grid, { x: 16, y: 16 }, { x: 144, y: 16 })!;
    const p8 = findPath(grid, { x: 16, y: 16 }, { x: 144, y: 16 }, { diagonals: true })!;
    expect(p8.length).toBeLessThan(p4.length);
    for (let i = 1; i < p8.length; i++) {
      const isDiagonal = p8[i].x !== p8[i - 1].x && p8[i].y !== p8[i - 1].y;
      if (isDiagonal) {
        // both orthogonal neighbors of the diagonal step must be walkable
        const cell = (wx: number, wy: number) =>
          grid.solid[Math.floor((wy - grid.originY) / 32) * grid.cols + Math.floor((wx - grid.originX) / 32)];
        expect(cell(p8[i].x, p8[i - 1].y)).toBe(0);
        expect(cell(p8[i - 1].x, p8[i].y)).toBe(0);
      }
    }
  });
  it('returns null when from/to are solid or unreachable', () => {
    expect(findPath(grid, { x: 80, y: 16 }, { x: 144, y: 16 })).toBeNull(); // from inside wall
    const sealed = buildNavGrid({
      cellSize: 32,
      solids: [wall(32, 0), wall(32, 32), wall(32, 64), wall(0, 64), wall(-32, 64), wall(-32, 32), wall(-32, 0), wall(0, -32), wall(32, -32), wall(-32, -32)],
      include: [{ x: 16, y: 16 }, { x: 300, y: 300 }],
    });
    expect(findPath(sealed, { x: 16, y: 16 }, { x: 300, y: 300 })).toBeNull();
  });
  it('same-cell from/to returns the single cell center', () => {
    const p = findPath(grid, { x: 10, y: 10 }, { x: 20, y: 20 });
    expect(p).toEqual([{ x: 16, y: 16 }]);
  });
  it('is deterministic', () => {
    const a = findPath(grid, { x: 16, y: 16 }, { x: 144, y: 112 }, { diagonals: true });
    const b = findPath(grid, { x: 16, y: 16 }, { x: 144, y: 112 }, { diagonals: true });
    expect(a).toEqual(b);
  });
});

describe('collectNavSolids', () => {
  it('uses first solid tilemap tileSize, static colliders, skips triggers and movers', () => {
    const { cellSize, solids } = collectNavSolids([
      { position: { x: 0, y: 0 }, bodyType: 'static',
        tilemap: { tileSize: 16, tileAssets: {}, grid: ['#.', '.#'], solid: true, layer: 0 } as any },
      { position: { x: 100, y: 100 }, bodyType: 'static',
        collider: { shape: 'box', width: 32, height: 32, radius: 16, points: [], offset: { x: 0, y: 0 }, isTrigger: false } as any },
      { position: { x: 200, y: 200 }, bodyType: 'static',
        collider: { shape: 'box', width: 32, height: 32, radius: 16, points: [], offset: { x: 0, y: 0 }, isTrigger: true } as any },
      { position: { x: 300, y: 300 }, bodyType: 'dynamic',
        collider: { shape: 'box', width: 32, height: 32, radius: 16, points: [], offset: { x: 0, y: 0 }, isTrigger: false } as any },
    ]);
    expect(cellSize).toBe(16);
    expect(solids).toHaveLength(3); // 2 tilemap cells + 1 static collider
    expect(solids.some((r) => r.x === 84 && r.y === 84)).toBe(true); // box centered at 100 → top-left 84
  });
  it('defaults cellSize to 32 with no solid tilemap', () => {
    expect(collectNavSolids([]).cellSize).toBe(32);
  });
  it('collects solid tilemap cells even on non-static bodies', () => {
    const { solids } = collectNavSolids([
      { position: { x: 0, y: 0 }, bodyType: 'kinematic',
        tilemap: { tileSize: 16, tileAssets: {}, grid: ['#.', '.#'], solid: true, layer: 0 } as any },
    ]);
    expect(solids).toHaveLength(2);
    expect(solids).toContainEqual({ x: 0, y: 0, width: 16, height: 16 });
    expect(solids).toContainEqual({ x: 16, y: 16, width: 16, height: 16 });
  });
});
