/**
 * Spatial-hash broadphase for stepPhysics's pair loops (Task 10).
 *
 * The contract is strict: the broadphase may only PRUNE pairs relative to
 * the naive O(n²) loops, never reorder the survivors. `query()` therefore
 * returns candidate indices ASCENDING and deduped, so per mover the
 * obstacle candidates are visited in ascending collection index and
 * mover×mover pairs are visited in ascending (i, j) with j > i — exactly
 * the naive visit order for every surviving pair.
 *
 * Pruning is conservative relative to `computeShapePush`: every shape pair
 * kind requires strict AABB overlap to produce a push (box/box and the
 * circle paths need strict geometric overlap; polygon pairs hit the `>=`
 * AABB reject at physics.ts:176-182), so any pair whose AABBs don't even
 * share a hash cell can never collide. On top of that, stepPhysics queries
 * with the mover's current AABB inflated by a full cellSize and REQUERIES
 * whenever mid-loop `applyPush` displacement could exceed that inflation,
 * making the pruning exact rather than heuristic — see the broadphase
 * block in stepPhysics for the invariant.
 *
 * Determinism: no RNG anywhere; results depend only on the inserted AABBs
 * and the (deterministic) cell size. Non-finite AABBs (degenerate polygons,
 * script-corrupted values) can't be placed in cells, so they are treated as
 * candidates for every query — never pruned — matching whatever
 * computeShapePush would do with them.
 */

import type { CollisionShape } from './physics.js';

export interface Aabb {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * TEST-ONLY escape hatch: when `forceNaive` is true, stepPhysics visits
 * every pair like the pre-broadphase O(n²) loops. broadphase.test.ts uses
 * it to prove full-run naive-vs-broadphase equivalence; never set it in
 * production code.
 */
export const broadphaseTestHooks = { forceNaive: false };

const ascending = (a: number, b: number): number => a - b;

/**
 * World AABB of a collision shape. Every CollisionShape carries a `box`
 * (center + half extents) that already bounds it: box colliders trivially,
 * circles as center ± radius (colliderBox sets hw = hh = radius), polygons
 * via polygonBounds over their world-space points — and translateShape
 * keeps all three in sync when resolution moves a mover.
 */
export function shapeAabb(shape: CollisionShape): Aabb {
  const b = shape.box;
  return { minX: b.cx - b.hw, minY: b.cy - b.hh, maxX: b.cx + b.hw, maxY: b.cy + b.hh };
}

/**
 * Cell size for a frame's hash: the 90th-percentile shape extent (each
 * shape's max(width, height)), floored at 32.
 *
 * The task brief suggested the MAX extent, but that degrades to O(n²): one
 * giant collider (bench arenas are enclosed by ~2000px wall boxes) makes
 * the cell as large as the whole world, so every query returns every
 * shape. A high percentile tracks the typical object size instead —
 * outlier giants simply span many cells (insert cost is a handful of list
 * pushes) and are found by exactly the queries that can reach them.
 *
 * Correctness does not depend on this choice: cell-overlap pruning is
 * conservative for ANY positive cell size, and stepPhysics covers mid-loop
 * applyPush displacement with an exact requery/rebuild rule (see the
 * broadphase block in stepPhysics) rather than relying on cellSize being
 * "big enough". Non-finite extents (degenerate polygons) are ignored here
 * — those shapes go through SpatialHash's always-candidate path.
 */
export function chooseCellSize(aabbs: Aabb[]): number {
  const extents: number[] = [];
  for (const a of aabbs) {
    const w = a.maxX - a.minX;
    const h = a.maxY - a.minY;
    const extent = w > h ? w : h;
    if (Number.isFinite(extent)) extents.push(extent);
  }
  if (extents.length === 0) return 32;
  extents.sort(ascending);
  const idx = Math.min(extents.length - 1, Math.ceil(0.9 * extents.length) - 1);
  return Math.max(32, extents[idx]);
}

function isFiniteAabb(a: Aabb): boolean {
  return (
    Number.isFinite(a.minX) &&
    Number.isFinite(a.minY) &&
    Number.isFinite(a.maxX) &&
    Number.isFinite(a.maxY)
  );
}

/**
 * Cell coordinates are clamped to ±CELL_LIMIT before packing into a
 * numeric map key. Clamping is monotone, so two AABBs whose real cell
 * ranges intersect still intersect after clamping — far-out shapes just
 * pile into the border cells (extra candidates, never missed ones).
 */
const CELL_LIMIT = 1 << 20;
const KEY_STRIDE = 2 * CELL_LIMIT + 1;

/**
 * A per-frame spatial hash over indices into a collection array. Rebuilt
 * every physics step via `reset()` (the mover/obstacle arrays it indexes
 * are themselves rebuilt per frame); the instance is reused across frames
 * so the stamp table and scratch array don't reallocate.
 */
export class SpatialHash {
  private cellSize: number;
  private readonly cells = new Map<number, number[]>();
  /** Every inserted index, in insert order (ascending in stepPhysics usage). */
  private readonly all: number[] = [];
  /** Indices whose AABB is non-finite — candidates for every query. */
  private readonly always: number[] = [];
  /** Dedup stamps per index; a query's generation marks indices already collected. */
  private readonly stamps: number[] = [];
  private generation = 0;
  /** Reused query-result buffer — valid only until the next query() on this instance. */
  private readonly scratch: number[] = [];

  constructor(cellSize: number) {
    this.cellSize = Math.max(1, cellSize);
  }

  /** Clear all contents and adopt a new cell size (per-frame rebuild). */
  reset(cellSize: number): void {
    this.cellSize = Math.max(1, cellSize);
    this.cells.clear();
    this.all.length = 0;
    this.always.length = 0;
  }

  private cellCoord(v: number): number {
    const c = Math.floor(v / this.cellSize);
    return c < -CELL_LIMIT ? -CELL_LIMIT : c > CELL_LIMIT ? CELL_LIMIT : c;
  }

  insert(index: number, aabb: Aabb): void {
    this.all.push(index);
    if (!isFiniteAabb(aabb)) {
      this.always.push(index);
      return;
    }
    const x0 = this.cellCoord(aabb.minX);
    const x1 = this.cellCoord(aabb.maxX);
    const y0 = this.cellCoord(aabb.minY);
    const y1 = this.cellCoord(aabb.maxY);
    for (let cx = x0; cx <= x1; cx++) {
      const rowKey = (cx + CELL_LIMIT) * KEY_STRIDE + CELL_LIMIT;
      for (let cy = y0; cy <= y1; cy++) {
        const key = rowKey + cy;
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(index);
      }
    }
  }

  /**
   * Candidate indices whose AABB might overlap `aabb`: everything sharing
   * a cell with it, plus every non-finite insert — ASCENDING and deduped.
   * Returns an internal buffer reused by the next query() on this instance.
   */
  query(aabb: Aabb): number[] {
    const out = this.scratch;
    out.length = 0;
    const gen = ++this.generation;
    const stamps = this.stamps;
    if (!isFiniteAabb(aabb)) {
      // A non-finite query AABB can't be located in the grid — pruning
      // anything would be unsound, so return every inserted index.
      for (const idx of this.all) {
        if (stamps[idx] !== gen) {
          stamps[idx] = gen;
          out.push(idx);
        }
      }
      out.sort(ascending);
      return out;
    }
    for (const idx of this.always) {
      stamps[idx] = gen;
      out.push(idx);
    }
    const x0 = this.cellCoord(aabb.minX);
    const x1 = this.cellCoord(aabb.maxX);
    const y0 = this.cellCoord(aabb.minY);
    const y1 = this.cellCoord(aabb.maxY);
    for (let cx = x0; cx <= x1; cx++) {
      const rowKey = (cx + CELL_LIMIT) * KEY_STRIDE + CELL_LIMIT;
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.cells.get(rowKey + cy);
        if (!list) continue;
        for (const idx of list) {
          if (stamps[idx] !== gen) {
            stamps[idx] = gen;
            out.push(idx);
          }
        }
      }
    }
    out.sort(ascending);
    return out;
  }
}
