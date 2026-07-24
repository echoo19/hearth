import { describe, it, expect, vi } from 'vitest';
import { isAutotileRule, type AutotileRule, type TileAsset } from '@hearth/core';
import { overlayStrokeCells, resolveTileVisual } from '../src/tileAutotileVisual';
import type { AssetItem } from '../src/types';
import type { TileCell } from '../src/tilemapPaint';

function sheetAsset(id: string, frames: Array<{ name: string; x: number; y: number; w: number; h: number }>): AssetItem {
  return {
    id,
    name: id,
    type: 'sprite',
    path: `assets/sprite/${id}.png`,
    metadata: {
      frames: frames.map((f) => ({ name: f.name, x: f.x, y: f.y, width: f.w, height: f.h })),
    },
  };
}

const RULE: AutotileRule = { sheet: 'ast_sheet', template: 'blob47' };

describe('isAutotileRule', () => {
  it('distinguishes the string arm from the object arm', () => {
    expect(isAutotileRule('ast_grass')).toBe(false);
    expect(isAutotileRule(RULE)).toBe(true);
    expect(isAutotileRule(undefined)).toBe(false);
  });
});

describe('resolveTileVisual', () => {
  it('returns null for an empty or unmapped cell', () => {
    const map = new Map<string, AssetItem>();
    expect(resolveTileVisual(['.G'], 0, 0, { G: 'ast_grass' }, map)).toBeNull();
    expect(resolveTileVisual(['XG'], 0, 0, { G: 'ast_grass' }, map)).toBeNull(); // 'X' has no tileAssets entry
  });

  it('resolves a plain string tile to its whole-image asset id, no frame rect', () => {
    const map = new Map<string, AssetItem>();
    const visual = resolveTileVisual(['G'], 0, 0, { G: 'ast_grass' }, map);
    expect(visual).toEqual({ assetId: 'ast_grass' });
  });

  it('resolves a fixed frame to that exact sheet crop regardless of neighbours', () => {
    const asset = sheetAsset('ast_sheet', [
      { name: 'floor_7', x: 32, y: 16, w: 16, h: 16 },
      { name: 'blob_255', x: 0, y: 0, w: 16, h: 16 },
    ]);
    const map = new Map([[asset.id, asset]]);
    const visual = resolveTileVisual(
      ['GGG', 'GGG', 'GGG'],
      1,
      1,
      { G: { sheet: 'ast_sheet', frame: 'floor_7' } },
      map,
    );
    expect(visual).toEqual({
      assetId: 'ast_sheet',
      frame: { name: 'floor_7', x: 32, y: 16, width: 16, height: 16 },
    });
  });

  it('resolves an autotile cell to the sheet + frame rect for its neighbor mask', () => {
    const asset = sheetAsset('ast_sheet', [
      { name: 'blob_0', x: 0, y: 0, w: 16, h: 16 },
      { name: 'blob_255', x: 16, y: 0, w: 16, h: 16 },
    ]);
    const map = new Map([[asset.id, asset]]);
    const grid = ['...', '.G.', '...']; // isolated tile: mask 0
    const visual = resolveTileVisual(grid, 1, 1, { G: RULE }, map);
    expect(visual).toEqual({ assetId: 'ast_sheet', frame: { name: 'blob_0', x: 0, y: 0, width: 16, height: 16 } });
  });

  it('re-resolves a different frame when the grid (a new array) changes a neighbour', () => {
    const asset = sheetAsset('ast_sheet', [
      { name: 'blob_0', x: 0, y: 0, w: 16, h: 16 },
      { name: 'blob_255', x: 16, y: 0, w: 16, h: 16 },
    ]);
    const map = new Map([[asset.id, asset]]);
    const before = resolveTileVisual(['...', '.G.', '...'], 1, 1, { G: RULE }, map);
    const after = resolveTileVisual(['GGG', 'GGG', 'GGG'], 1, 1, { G: RULE }, map);
    expect(before?.frame?.width).toBeDefined();
    expect(after).toEqual({ assetId: 'ast_sheet', frame: { name: 'blob_255', x: 16, y: 0, width: 16, height: 16 } });
    expect(before).not.toEqual(after);
  });

  it('falls back to the whole sheet image (no frame) when the sheet asset is missing', () => {
    const visual = resolveTileVisual(['G'], 0, 0, { G: RULE }, new Map());
    expect(visual).toEqual({ assetId: 'ast_sheet' });
  });

  it('falls back to the whole sheet image (no frame) when the resolved frame name is not on the sheet', () => {
    const asset = sheetAsset('ast_sheet', [{ name: 'other_frame', x: 0, y: 0, w: 8, h: 8 }]);
    const map = new Map([[asset.id, asset]]);
    const visual = resolveTileVisual(['G'], 0, 0, { G: RULE }, map);
    expect(visual).toEqual({ assetId: 'ast_sheet' });
  });

  it('honors a mapping override for the resolved shape', () => {
    const rule: AutotileRule = { sheet: 'ast_sheet', template: 'blob47', mapping: { '0': 'custom_lone' } };
    const asset = sheetAsset('ast_sheet', [{ name: 'custom_lone', x: 4, y: 4, w: 16, h: 16 }]);
    const map = new Map([[asset.id, asset]]);
    const visual = resolveTileVisual(['...', '.G.', '...'], 1, 1, { G: rule }, map);
    expect(visual).toEqual({ assetId: 'ast_sheet', frame: { name: 'custom_lone', x: 4, y: 4, width: 16, height: 16 } });
  });

  it('resolves a 1x1 grid through the full mask path, off-grid neighbours counting as same (fully-surrounded shape)', () => {
    // A single-cell grid has all 8 neighbours off-grid, which computeMask
    // treats as SAME -> raw mask 255 -> canonical shape '255' -> blob_255,
    // the same frame a tile fully surrounded by its own kind would get.
    // This must resolve through the real mask/frame lookup, not just hit
    // the missing-sheet fallback (which would also produce an assetId-only
    // result and mask this path being broken).
    const asset = sheetAsset('ast_sheet', [
      { name: 'blob_0', x: 0, y: 0, w: 16, h: 16 },
      { name: 'blob_255', x: 32, y: 0, w: 16, h: 16 },
    ]);
    const map = new Map([[asset.id, asset]]);
    const visual = resolveTileVisual(['G'], 0, 0, { G: RULE }, map);
    expect(visual).toEqual({ assetId: 'ast_sheet', frame: { name: 'blob_255', x: 32, y: 0, width: 16, height: 16 } });
  });
});

describe('overlayStrokeCells', () => {
  it('returns an equal-but-distinct grid when there are no cells', () => {
    const grid = ['GG', 'GG'];
    const result = overlayStrokeCells(grid, []);
    expect(result).toEqual(grid);
    expect(result).not.toBe(grid);
  });

  it('applies stroke cells onto a copy without mutating the source grid', () => {
    const grid = ['...', '...', '...'];
    const cells: TileCell[] = [{ x: 1, y: 1, char: 'G' }];
    const result = overlayStrokeCells(grid, cells);
    expect(result).toEqual(['...', '.G.', '...']);
    expect(grid).toEqual(['...', '...', '...']); // unchanged
  });

  it('ignores out-of-bounds stroke cells', () => {
    const grid = ['..', '..'];
    const cells: TileCell[] = [{ x: 5, y: 5, char: 'G' }];
    expect(overlayStrokeCells(grid, cells)).toEqual(grid);
  });

  it('lets a later cell at the same position win', () => {
    const grid = ['...'];
    const cells: TileCell[] = [
      { x: 0, y: 0, char: 'G' },
      { x: 0, y: 0, char: 'W' },
    ];
    expect(overlayStrokeCells(grid, cells)).toEqual(['W..']);
  });

  it('only rebuilds rows that contain a stroke cell, leaving every other row untouched (copy-on-write)', () => {
    // Guards against an O(grid-size) full-grid split/join copy on every
    // call: JS string primitives compare by value, so `toBe` can't tell
    // "same reference" from "freshly built identical string" -- spy on
    // String.prototype.split instead, since that's the per-row rebuild
    // operation. A stroke touching 1 of 1000 rows must only split() that
    // one row, not all 1000, so a 5-cell stroke on a huge map stays cheap.
    const rowCount = 1000;
    const grid = Array.from({ length: rowCount }, () => 'GGG');
    const cells: TileCell[] = [{ x: 1, y: 500, char: 'W' }];
    const splitSpy = vi.spyOn(String.prototype, 'split');
    const result = overlayStrokeCells(grid, cells);
    expect(splitSpy).toHaveBeenCalledTimes(1);
    expect(splitSpy).toHaveBeenCalledWith('');
    splitSpy.mockRestore();
    expect(result[500]).toBe('GWG');
    expect(result[0]).toBe(grid[0]);
    expect(result[999]).toBe(grid[999]);
    expect(result).toHaveLength(rowCount);
  });
});

describe('TileAsset type sanity (compile-time only, asserted at runtime for coverage)', () => {
  it('accepts all three arms', () => {
    const a: TileAsset = 'ast_grass';
    const b: TileAsset = { sheet: 'ast_sheet', frame: 'floor_7' };
    const c: TileAsset = RULE;
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('object');
    expect(typeof c).toBe('object');
  });
});
