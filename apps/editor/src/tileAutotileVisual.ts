/**
 * Pure per-cell visual resolution for a Tilemap's `tileAssets`, shared by
 * SceneView's renderTilemap and renderPaintPreview so both draw autotile
 * cells identically. Kept separate so the mask/frame lookup is
 * unit-testable without a DOM, matching tilemapPaint.ts/polygonEditing.ts
 * for the other SceneView math.
 *
 * A tile char resolves one of three ways (mirrors packages/runtime/src/pixi/
 * tilemapRender.ts, the runtime's equivalent):
 *   - Plain asset id (string arm): draw the whole image, no frame rect.
 *   - Fixed frame: draw the named sliced-sheet frame unchanged.
 *   - Autotile rule: pick the per-cell frame from the 8
 *     neighbours sharing this cell's char (@hearth/core's blob47 resolver),
 *     then look up that frame's pixel rect on the sheet asset's sliced
 *     metadata.
 *
 * Every call re-derives the mask fresh from the `grid` array passed in —
 * nothing here caches by (row, col) alone, so a repainted grid (a NEW array;
 * the paint commands never mutate a row in place) always re-resolves.
 */
import {
  computeMask,
  findSheetFrame,
  isTileFrameSource,
  resolveTileFrame,
  type SpritesheetFrame,
  type TileAsset,
} from '@hearth/core';
import type { TileCell } from './tilemapPaint';
import type { AssetItem } from './types';

export type { TileAsset } from '@hearth/core';

export interface TileVisual {
  /** Sheet/image asset id to draw from. */
  assetId: string;
  /** Pixel rect within that asset's sheet metadata to crop to; absent = draw the whole image. */
  frame?: Pick<SpritesheetFrame, 'x' | 'y' | 'width' | 'height'>;
}

/**
 * What to draw for the tile at (row, col), or null for an empty/unmapped
 * cell (the caller falls back to its own placeholder, same as an unresolved
 * plain asset id today).
 */
export function resolveTileVisual(
  grid: readonly string[],
  row: number,
  col: number,
  tileAssets: Record<string, TileAsset>,
  assetById: Map<string, AssetItem>,
): TileVisual | null {
  const ch = grid[row]?.[col];
  if (ch === undefined || ch === '.' || ch === ' ') return null;
  const tile = tileAssets[ch];
  if (tile === undefined) return null;
  if (typeof tile === 'string') return { assetId: tile };

  const { sheet, frame: frameName } = isTileFrameSource(tile)
    ? tile
    : resolveTileFrame(tile, computeMask(grid, row, col, ch));
  const asset = assetById.get(sheet);
  const rect = asset ? findSheetFrame(asset, frameName) : null;
  return rect ? { assetId: sheet, frame: rect } : { assetId: sheet };
}

/**
 * A tentative grid with an in-progress paint stroke's cells overlaid —
 * preview-only, never written back. Used so a freehand stroke's preview can
 * show autotile neighbours reacting to tiles the stroke itself just placed,
 * exactly like they will once the stroke commits.
 */
export function overlayStrokeCells(grid: readonly string[], cells: readonly TileCell[]): string[] {
  if (cells.length === 0) return grid.slice();
  // Copy-on-write per row: a stroke is at most FREEHAND_AUTOTILE_PREVIEW_CAP
  // cells, but the grid can be huge, so touching every row on every
  // pointermove (a prior version did `grid.map(line => line.split(''))`)
  // makes preview cost scale with map size instead of stroke size. Only
  // rows containing a stroke cell get split/rebuilt; every other row keeps
  // its original string in the result array untouched.
  const rows = grid.slice();
  const dirtyRows = new Map<number, string[]>();
  for (const cell of cells) {
    const original = rows[cell.y];
    if (original === undefined || cell.x < 0 || cell.x >= original.length) continue;
    let chars = dirtyRows.get(cell.y);
    if (!chars) {
      chars = original.split('');
      dirtyRows.set(cell.y, chars);
    }
    chars[cell.x] = cell.char;
  }
  for (const [y, chars] of dirtyRows) rows[y] = chars.join('');
  return rows;
}
