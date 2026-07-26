/**
 * Grid pathing for the steering policies.
 *
 * @hearth/playtest steered along an A* path from @hearth/core. probe-core must
 * stand alone, and it needs less: a breadth-first sweep from the avatar's cell
 * gives, in one pass, both the shortest 4-connected route to any cell AND the
 * distance ordering wander uses to pick its next frontier. Uniform cost means
 * BFS is optimal, so nothing is lost by dropping A*.
 *
 * Pure over the NavGrid: no game, no rng.
 */
import type { NavGrid } from './contract.js';
import { cellCenter, cellIndexAt } from './reachability.js';

export interface Point {
  x: number;
  y: number;
}

/** A direction in world space, normally unit length. */
export interface Direction {
  dx: number;
  dy: number;
}

/** Distances (in cells) and parent links from one start cell. */
export interface NavField {
  start: number;
  /** -1 where unreachable. */
  dist: Int32Array;
  /** -1 at the start and where unreachable. */
  parent: Int32Array;
}

/** Breadth-first sweep over walkable cells, 4-connected. */
export function navField(grid: NavGrid, start: number): NavField {
  const { cols, rows, solid } = grid;
  const dist = new Int32Array(solid.length).fill(-1);
  const parent = new Int32Array(solid.length).fill(-1);
  if (start < 0 || start >= solid.length || solid[start]) return { start, dist, parent };

  dist[start] = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const candidates = [
      [col, row - 1],
      [col + 1, row],
      [col, row + 1],
      [col - 1, row],
    ];
    for (const [c, r] of candidates) {
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const ni = r * cols + c;
      if (solid[ni] || dist[ni] !== -1) continue;
      dist[ni] = dist[idx] + 1;
      parent[ni] = idx;
      queue.push(ni);
    }
  }
  return { start, dist, parent };
}

/** Cell-center waypoints from the field's start to `goal`, or null when unreachable. */
export function pathToCell(grid: NavGrid, field: NavField, goal: number): Point[] | null {
  if (goal < 0 || goal >= grid.solid.length || field.dist[goal] === -1) return null;
  const cells: number[] = [];
  for (let at = goal; at !== -1; at = field.parent[at]) {
    cells.push(at);
    if (at === field.start) break;
  }
  cells.reverse();
  return cells.map((index) => cellCenter(grid, index));
}

/**
 * Shortest cell-center path between two world points, or null when the goal is
 * unreachable (or either end is outside/inside geometry). The first waypoint is
 * the start cell's center; callers usually skip it.
 */
export function findPath(grid: NavGrid, from: Point, to: Point): Point[] | null {
  const start = cellIndexAt(grid, from.x, from.y);
  const goal = cellIndexAt(grid, to.x, to.y);
  if (start < 0 || goal < 0) return null;
  return pathToCell(grid, navField(grid, start), goal);
}

/**
 * The nearest reachable cell whose coverage key is not in `visited`, or null
 * when everything reachable has been seen. Ties break by cell index so the
 * choice is deterministic.
 */
export function nearestUnvisited(
  grid: NavGrid,
  field: NavField,
  visited: ReadonlySet<string>,
  keyOf: (point: Point) => string,
): number | null {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < field.dist.length; i++) {
    const d = field.dist[i];
    if (d === -1 || d === 0) continue;
    if (d >= bestDist) continue;
    if (visited.has(keyOf(cellCenter(grid, i)))) continue;
    best = i;
    bestDist = d;
  }
  return best === -1 ? null : best;
}

/** Every reachable cell index in the field, in index order. */
export function reachableCells(field: NavField): number[] {
  const out: number[] = [];
  for (let i = 0; i < field.dist.length; i++) if (field.dist[i] > 0) out.push(i);
  return out;
}
