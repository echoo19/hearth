import { describe, it, expect } from 'vitest';
import type { AutotileRule } from '@hearth/core';
import { isAutotileRule, overlayStrokeCells, resolveTileVisual, type TileAsset } from '../src/tileAutotileVisual';
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
});

describe('TileAsset type sanity (compile-time only, asserted at runtime for coverage)', () => {
  it('accepts both arms', () => {
    const a: TileAsset = 'ast_grass';
    const b: TileAsset = RULE;
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('object');
  });
});
