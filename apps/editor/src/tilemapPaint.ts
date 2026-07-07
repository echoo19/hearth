/**
 * Pure math for the Scene view's tilemap paint tool: shared by SceneView's
 * pointer handlers and TilemapPainter's palette. Kept separate so the
 * cell-coordinate math and stroke-accumulation logic are unit-testable
 * without a DOM (same split as polygonEditing.ts for the point editor).
 */
import type { Vec2 } from './types';

export interface Cell {
  x: number;
  y: number;
}

export interface TileCell extends Cell {
  char: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * World position → grid cell. Row 0 is the top of the grid (matching
 * renderTilemap's `y={ry * size}`), so this is a plain floored division
 * against the entity's world position — no rotation/scale correction (the
 * paint tool only supports axis-aligned tilemaps, like renderTilemap itself).
 */
export function worldToCell(world: Vec2, origin: Vec2, tileSize: number): Cell {
  return {
    x: Math.floor((world.x - origin.x) / tileSize),
    y: Math.floor((world.y - origin.y) / tileSize),
  };
}

/** Stable dedup key for a cell. */
export function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

/** True when a cell falls within the tilemap's actual grid (row-length aware). */
export function isCellInBounds(cell: Cell, grid: readonly string[]): boolean {
  const row = grid[cell.y];
  return cell.y >= 0 && cell.y < grid.length && row !== undefined && cell.x >= 0 && cell.x < row.length;
}

/**
 * Appends a cell to an in-progress stroke, deduping by (x, y): a cell
 * revisited mid-drag (e.g. the pointer doubles back) just updates its char
 * in place rather than appending a second entry, so a stroke never dispatches
 * more `paintTiles` cells than there are unique grid squares touched.
 */
export function addStrokeCell(cells: readonly TileCell[], cell: TileCell): TileCell[] {
  const key = cellKey(cell);
  const index = cells.findIndex((c) => cellKey(c) === key);
  if (index === -1) return [...cells, cell];
  const next = cells.slice();
  next[index] = cell;
  return next;
}

/**
 * Filters a stroke's cells down to ones actually inside the grid. Used so an
 * out-of-bounds cell touched mid-drag is silently skipped rather than
 * aborting (or erroring) the whole stroke — growing the grid is the
 * palette's "Resize…" affordance, not something a stroke should surface.
 */
export function filterInBounds(cells: readonly TileCell[], grid: readonly string[]): TileCell[] {
  return cells.filter((c) => isCellInBounds(c, grid));
}

/** Normalizes two corner cells (in either order) into a top-left rect, inclusive of both corners. */
export function normalizeRect(a: Cell, b: Cell): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x) + 1;
  const height = Math.abs(a.y - b.y) + 1;
  return { x, y, width, height };
}

/**
 * Clamps a rect to the grid's actual bounds (assumes a uniform grid — the
 * shape produced by resizeTilemap — using row 0's length as the column
 * count). Returns null when the rect doesn't overlap the grid at all, so
 * the caller can skip dispatching `fillTilemapRect` entirely rather than
 * risk a `TILE_OUT_OF_BOUNDS` error on a shift-drag that went off the edge.
 */
export function clampRectToGrid(rect: Rect, grid: readonly string[]): Rect | null {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return null;
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(cols, rect.x + rect.width);
  const y1 = Math.min(rows, rect.y + rect.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
