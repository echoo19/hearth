/**
 * Grid reachability — the honest answer to "what can the player actually get to?"
 *
 * `buildNavGrid` marks cells solid-or-not, but it runs no connectivity pass, so a
 * walled-off pocket counts as "walkable" even though nothing can reach it. That
 * made the old coverage denominator a fiction (visited / non-solid). Here we
 * flood-fill from the avatar's spawn cell using the same orthogonal neighbor rule
 * as findPath's default (no diagonals), so coverage is measured against cells the
 * player can truly reach, and the difference — walkable minus reached — is exactly
 * the sealed-region finding.
 *
 * Pure over the NavGrid: no runtime, no rng. Static geometry only — a region a
 * door or teleport opens at runtime is not modeled here, which the finding says.
 */
import type { NavGrid } from '@hearth/core';

/** Every non-solid cell index, connectivity ignored. */
export function walkableIndices(grid: NavGrid): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < grid.solid.length; i++) if (grid.solid[i] === 0) out.add(i);
  return out;
}

/**
 * Cell indices reachable from `start` over walkable cells, 4-connected (N/E/S/W).
 * `start` is a cell index; a solid or out-of-range start yields an empty set.
 */
export function floodReachable(grid: NavGrid, start: number): Set<number> {
  const { cols, rows, solid } = grid;
  const reached = new Set<number>();
  if (start < 0 || start >= solid.length || solid[start] === 1) return reached;

  const stack = [start];
  reached.add(start);
  while (stack.length > 0) {
    const idx = stack.pop() as number;
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    // N, E, S, W — matching findPath's ORTHO neighbor set.
    const candidates = [
      [col, row - 1],
      [col + 1, row],
      [col, row + 1],
      [col - 1, row],
    ];
    for (const [c, r] of candidates) {
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const ni = r * cols + c;
      if (solid[ni] === 1 || reached.has(ni)) continue;
      reached.add(ni);
      stack.push(ni);
    }
  }
  return reached;
}

/** The world-space center of a grid cell index (for mapping to coverage keys / samples). */
export function cellCenter(grid: NavGrid, index: number): { x: number; y: number } {
  const col = index % grid.cols;
  const row = Math.floor(index / grid.cols);
  return {
    x: grid.originX + (col + 0.5) * grid.cellSize,
    y: grid.originY + (row + 0.5) * grid.cellSize,
  };
}

/** The grid cell index containing a world point, or -1 when outside the grid. */
export function cellIndexAt(grid: NavGrid, x: number, y: number): number {
  const col = Math.floor((x - grid.originX) / grid.cellSize);
  const row = Math.floor((y - grid.originY) / grid.cellSize);
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return -1;
  return row * grid.cols + col;
}

/** Walkable/reachable counts plus a few sample coords for the sealed-region finding. */
export interface ReachabilityReport {
  /** All non-solid cells. */
  walkable: number;
  /** Cells reachable from the spawn (equals `walkable` when we can't flood). */
  reachable: number;
  /** World centers of a few sealed cells, for a human-legible finding. Empty = nothing sealed. */
  sealedSamples: { x: number; y: number }[];
  /** Cell keys ("cx,cy" at 32px) reachable from spawn — the honest coverage denominator. */
  reachableKeys: Set<string>;
}

/** 32px world-grid cell size — matches runBotRun's novelty grid and the coverage keys. */
const COVERAGE_CELL = 32;

function coverageKey(x: number, y: number): string {
  return `${Math.floor(x / COVERAGE_CELL)},${Math.floor(y / COVERAGE_CELL)}`;
}

/**
 * Analyze a nav grid for coverage and sealed regions. When the spawn is unknown
 * or falls outside the grid, connectivity can't be established, so we treat every
 * walkable cell as reachable and report nothing sealed — a conservative choice
 * that never invents a false "walled off" finding. Only a spawn inside the grid
 * yields a real reachable set and a real sealed difference.
 */
export function analyzeReachability(
  grid: NavGrid,
  spawn: { x: number; y: number } | null,
  maxSamples = 3,
): ReachabilityReport {
  const walkable = walkableIndices(grid);
  const start = spawn ? cellIndexAt(grid, spawn.x, spawn.y) : -1;

  const keysOf = (indices: Iterable<number>): Set<string> => {
    const keys = new Set<string>();
    for (const i of indices) {
      const c = cellCenter(grid, i);
      keys.add(coverageKey(c.x, c.y));
    }
    return keys;
  };

  if (start < 0 || grid.solid[start] === 1) {
    return {
      walkable: walkable.size,
      reachable: walkable.size,
      sealedSamples: [],
      reachableKeys: keysOf(walkable),
    };
  }

  const reached = floodReachable(grid, start);
  const sealedSamples: { x: number; y: number }[] = [];
  for (const i of walkable) {
    if (reached.has(i)) continue;
    if (sealedSamples.length < maxSamples) {
      const c = cellCenter(grid, i);
      sealedSamples.push({ x: Math.round(c.x), y: Math.round(c.y) });
    }
  }
  return {
    walkable: walkable.size,
    reachable: reached.size,
    sealedSamples,
    reachableKeys: keysOf(reached),
  };
}
