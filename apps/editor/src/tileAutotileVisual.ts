/**
 * Pure per-cell visual resolution for a Tilemap's `tileAssets`, shared by
 * SceneView's renderTilemap and renderPaintPreview so both draw autotile
 * cells identically. Kept separate so the mask/frame lookup is
 * unit-testable without a DOM, matching tilemapPaint.ts/polygonEditing.ts
 * for the other SceneView math.
 *
 * A tile char resolves one of two ways (mirrors packages/runtime/src/pixi/
 * tilemapRender.ts, the runtime's equivalent):
 *   - Plain asset id (string arm): draw the whole image, no frame rect.
 *   - Autotile rule (object arm): pick the per-cell frame from the 8
 *     neighbours sharing this cell's char (@hearth/core's blob47 resolver),
 *     then look up that frame's pixel rect on the sheet asset's sliced
 *     metadata.
 *
 * Every call re-derives the mask fresh from the `grid` array passed in —
 * nothing here caches by (row, col) alone, so a repainted grid (a NEW array;
 * the paint commands never mutate a row in place) always re-resolves.
 */
import { computeMask, findSheetFrame, resolveTileFrame, type AutotileRule, type SpritesheetFrame } from '@hearth/core';
import type { TileCell } from './tilemapPaint';
import type { AssetItem } from './types';

export type TileAsset = string | AutotileRule;

export function isAutotileRule(value: TileAsset | undefined): value is AutotileRule {
  return typeof value === 'object' && value !== null;
}

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

  const mask = computeMask(grid, row, col, ch);
  const { sheet, frame: frameName } = resolveTileFrame(tile, mask);
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
  const rows = grid.map((line) => line.split(''));
  for (const cell of cells) {
    const row = rows[cell.y];
    if (row && cell.x >= 0 && cell.x < row.length) row[cell.x] = cell.char;
  }
  return rows.map((chars) => chars.join(''));
}
