/**
 * Grid math: reachability (the sealed-region evidence) and the BFS pathing the
 * steering policies follow.
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeReachability,
  cellCenter,
  cellIndexAt,
  findPath,
  floodReachable,
  navField,
  nearestUnvisited,
  pathToCell,
  reachableCells,
  walkableIndices,
  type NavGrid,
} from '@hearth/probe-core';

/** 5x4 grid from an ASCII map: '#' solid, '.' open. */
function grid(rows: string[], cellSize = 10, originX = 0, originY = 0): NavGrid {
  const cols = rows[0].length;
  const solid: boolean[] = [];
  for (const row of rows) for (const ch of row) solid.push(ch === '#');
  return { originX, originY, cellSize, cols, rows: rows.length, solid };
}

const OPEN = grid(['.....', '.....', '.....', '.....']);
const SPLIT = grid([
  '..#..',
  '..#..',
  '..#..',
  '..#..',
]);

describe('cell geometry', () => {
  it('maps world points to cells and back to centers', () => {
    expect(cellIndexAt(OPEN, 0, 0)).toBe(0);
    expect(cellIndexAt(OPEN, 25, 15)).toBe(1 * 5 + 2);
    expect(cellIndexAt(OPEN, -1, 0)).toBe(-1);
    expect(cellIndexAt(OPEN, 999, 0)).toBe(-1);
    expect(cellCenter(OPEN, 0)).toEqual({ x: 5, y: 5 });
    expect(cellCenter(OPEN, 7)).toEqual({ x: 25, y: 15 });
  });

  it('respects a non-zero origin', () => {
    const offset = grid(['...', '...'], 10, 100, 200);
    expect(cellIndexAt(offset, 105, 205)).toBe(0);
    expect(cellCenter(offset, 0)).toEqual({ x: 105, y: 205 });
  });
});

describe('flood reachability', () => {
  it('walks the whole open grid', () => {
    expect(walkableIndices(OPEN).size).toBe(20);
    expect(floodReachable(OPEN, 0).size).toBe(20);
  });

  it('stops at a wall', () => {
    expect(floodReachable(SPLIT, 0).size).toBe(8);
    expect(walkableIndices(SPLIT).size).toBe(16);
  });

  it('returns nothing from a solid or out-of-range start', () => {
    expect(floodReachable(SPLIT, 2).size).toBe(0);
    expect(floodReachable(SPLIT, 999).size).toBe(0);
  });
});

describe('analyzeReachability', () => {
  it('reports the sealed half with sample coordinates', () => {
    const report = analyzeReachability(SPLIT, { x: 5, y: 5 }, { cellSize: 10 });
    expect(report.walkable).toBe(16);
    expect(report.reachable).toBe(8);
    expect(report.sealedSamples.length).toBeGreaterThan(0);
    expect(report.sealedSamples.length).toBeLessThanOrEqual(3);
    // Samples land in the sealed half (x greater than the dividing wall).
    for (const s of report.sealedSamples) expect(s.x).toBeGreaterThan(25);
  });

  it('never invents a sealed region when the spawn is unknown', () => {
    const report = analyzeReachability(SPLIT, null);
    expect(report.reachable).toBe(report.walkable);
    expect(report.sealedSamples).toEqual([]);
  });

  it('treats a spawn inside geometry as unknown rather than guessing', () => {
    const report = analyzeReachability(SPLIT, { x: 25, y: 5 });
    expect(report.reachable).toBe(report.walkable);
    expect(report.sealedSamples).toEqual([]);
  });

  it('keys coverage at the requested cell size rather than the grid cell size', () => {
    const coarse = analyzeReachability(OPEN, { x: 5, y: 5 }, { cellSize: 20 });
    const fine = analyzeReachability(OPEN, { x: 5, y: 5 }, { cellSize: 10 });
    expect(coarse.reachableKeys.size).toBeLessThan(fine.reachableKeys.size);
  });
});

describe('pathing', () => {
  it('finds a shortest orthogonal route', () => {
    const path = findPath(OPEN, { x: 5, y: 5 }, { x: 45, y: 35 });
    expect(path).not.toBeNull();
    expect(path?.[0]).toEqual({ x: 5, y: 5 });
    expect(path?.[path.length - 1]).toEqual({ x: 45, y: 35 });
    // 4 columns + 3 rows of travel, plus the start cell.
    expect(path).toHaveLength(8);
  });

  it('returns null when the goal is walled off', () => {
    expect(findPath(SPLIT, { x: 5, y: 5 }, { x: 45, y: 5 })).toBeNull();
  });

  it('routes around an obstacle instead of through it', () => {
    const maze = grid(['.....', '###.#', '.....']);
    const path = findPath(maze, { x: 5, y: 5 }, { x: 5, y: 25 });
    expect(path).not.toBeNull();
    for (const point of path ?? []) {
      const index = cellIndexAt(maze, point.x, point.y);
      expect(maze.solid[index]).toBe(false);
    }
  });

  it('picks the nearest unvisited cell as the wander frontier', () => {
    const field = navField(OPEN, 0);
    const visited = new Set<string>();
    const keyOf = (p: { x: number; y: number }): string => `${Math.floor(p.x / 10)},${Math.floor(p.y / 10)}`;
    const first = nearestUnvisited(OPEN, field, visited, keyOf);
    expect(first).not.toBeNull();
    expect(field.dist[first as number]).toBe(1);

    // Mark everything visited: there is no frontier left, only roaming.
    for (const index of reachableCells(field)) visited.add(keyOf(cellCenter(OPEN, index)));
    expect(nearestUnvisited(OPEN, field, visited, keyOf)).toBeNull();
    expect(reachableCells(field)).toHaveLength(19);
  });

  it('pathToCell refuses unreachable goals', () => {
    const field = navField(SPLIT, 0);
    expect(pathToCell(SPLIT, field, 4)).toBeNull();
    expect(pathToCell(SPLIT, field, 1)).toHaveLength(2);
  });
});
