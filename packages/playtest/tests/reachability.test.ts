/**
 * Reachability flood-fill — the honest denominator for coverage and the basis
 * for the sealed-region finding. Pure grid logic, tested on synthetic NavGrids.
 */
import { describe, it, expect } from 'vitest';
import type { NavGrid } from '@hearth/core';
import { floodReachable, walkableIndices, analyzeReachability } from '@hearth/playtest';

/** Build a NavGrid from an ASCII map: '#' solid, '.' walkable. One string per row. */
function grid(rows: string[], cellSize = 32): NavGrid {
  const cols = rows[0].length;
  const solid = new Uint8Array(cols * rows.length);
  rows.forEach((line, r) => {
    for (let c = 0; c < cols; c++) solid[r * cols + c] = line[c] === '#' ? 1 : 0;
  });
  return { cellSize, originX: 0, originY: 0, cols, rows: rows.length, solid };
}

describe('floodReachable', () => {
  it('does not cross a solid wall', () => {
    // col 2 is a wall; from the left, only cols 0 and 1 are reachable.
    const g = grid(['..#..']);
    const reached = floodReachable(g, 0); // start index = col 0
    expect([...reached].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('reaches every walkable cell in an open room', () => {
    const g = grid(['...', '...']);
    const reached = floodReachable(g, 0);
    expect(reached.size).toBe(6);
  });

  it('walkableIndices counts all non-solid cells regardless of connectivity', () => {
    const g = grid(['..#..']); // 4 walkable, 1 solid
    expect(walkableIndices(g).size).toBe(4);
  });

  it('a sealed pocket is walkable but not reached', () => {
    // Two open cells on the right are walled off from the left start.
    const g = grid(['.#..']);
    const walkable = walkableIndices(g); // {0, 2, 3}
    const reached = floodReachable(g, 0); // {0}
    const sealed = [...walkable].filter((i) => !reached.has(i));
    expect(sealed.sort((a, b) => a - b)).toEqual([2, 3]);
  });
});

describe('analyzeReachability', () => {
  it('reports sealed cells when the spawn is inside the grid', () => {
    // Spawn in cell 0 (world x≈16); cells 2,3 are walled off.
    const g = grid(['.#..']);
    const r = analyzeReachability(g, { x: 16, y: 16 });
    expect(r.walkable).toBe(3);
    expect(r.reachable).toBe(1);
    expect(r.sealedSamples.length).toBeGreaterThan(0);
  });

  it('does NOT flag anything when the spawn is outside the grid (unknown connectivity)', () => {
    // Spawn far outside the grid bounds — we cannot flood, so fall back to
    // walkable=reachable and emit no sealed report rather than a false positive.
    const g = grid(['.#..']);
    const r = analyzeReachability(g, { x: 10_000, y: 10_000 });
    expect(r.reachable).toBe(r.walkable);
    expect(r.sealedSamples).toEqual([]);
  });

  it('does NOT flag anything when there is no spawn', () => {
    const g = grid(['.#..']);
    const r = analyzeReachability(g, null);
    expect(r.reachable).toBe(r.walkable);
    expect(r.sealedSamples).toEqual([]);
  });
});
