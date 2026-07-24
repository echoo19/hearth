/**
 * buildTilemapContainer: the pure(-ish) Tilemap display-graph builder split
 * out of PixiSceneView specifically so it's testable without a real
 * canvas/WebGL Application (see ../src/pixi/tilemapRender.ts's header for
 * why — same reason fonts.test.ts only tests loadFontFaces() and not
 * PixiSceneView.mount() directly).
 *
 * Pixi's Container/Sprite/Graphics/Texture classes construct fine in plain
 * Node (no canvas needed until something actually renders to screen), so
 * this suite runs in this workspace's default "node" vitest environment.
 */
import { describe, it, expect, vi } from 'vitest';

// PixiJS v8's GL video-texture uploader calls isSafari() at module scope,
// which reads the bare `navigator` global to sniff the UA string. Node has
// had a global `navigator` since v21, but this workspace's CI matrix also
// runs Node 20, where the bare reference throws a ReferenceError the moment
// `pixi.js` is imported below — before any test in this file even runs.
// vi.hoisted lifts this stub above that static import (same hoisting this
// repo already relies on for vi.mock in apps/editor/tests/nudgeLifecycle.test.ts),
// and only fills in the property when it's actually missing, so newer Node
// keeps using its real global untouched.
vi.hoisted(() => {
  if (typeof globalThis.navigator === 'undefined') {
    (globalThis as { navigator?: Navigator }).navigator = { userAgent: 'node' } as Navigator;
  }
});

import { Container, Sprite, Graphics, Texture } from 'pixi.js';
import { computeMask, resolveTileFrame, type TilemapComponent, type AutotileRule } from '@hearth/core';
import { buildTilemapContainer, type TilemapRenderDeps } from '../src/pixi/tilemapRender.js';

/** A real, canvas-free Texture (Texture.WHITE needs no GPU/canvas) standing in for a loaded sheet/tile texture. */
const BASE_TEXTURE = Texture.WHITE;

/** Records every (assetId, frameName) resolveFrameTexture is asked for, in call order — the thing under test. */
function makeDeps(textures: Record<string, Texture | undefined>): TilemapRenderDeps & {
  calls: Array<{ assetId: string; frame: string }>;
} {
  const calls: Array<{ assetId: string; frame: string }> = [];
  return {
    calls,
    getTexture: (assetId) => textures[assetId],
    resolveFrameTexture: (assetId, frame) => {
      calls.push({ assetId, frame });
      return BASE_TEXTURE;
    },
  };
}

function tilemap(overrides: Partial<TilemapComponent>): TilemapComponent {
  return {
    tileSize: 16,
    tileAssets: {},
    grid: [],
    solid: false,
    layer: 0,
    ...overrides,
  } as TilemapComponent;
}

const RULE: AutotileRule = { sheet: 'ast_sheet', template: 'blob47' };

describe('buildTilemapContainer: plain string tiles (unchanged behavior)', () => {
  it('draws the preloaded texture for a plain asset-id tile, skipping "." and " "', () => {
    const deps = makeDeps({ ast_grass: BASE_TEXTURE });
    const tm = tilemap({ grid: ['G.G', ' GG'], tileAssets: { G: 'ast_grass' } });
    const container = buildTilemapContainer(tm, deps);
    // 2 rows x 3 cols, minus the '.' and ' ' cells: (0,0) (0,2) (1,1) (1,2) = 4 tiles.
    expect(container.children).toHaveLength(4);
    expect(container.children.every((c) => c instanceof Sprite)).toBe(true);
    expect(deps.calls).toHaveLength(0); // string arm never touches resolveFrameTexture
  });

  it('falls back to a placeholder Graphics box when the tile texture failed to load', () => {
    const deps = makeDeps({}); // nothing preloaded
    const tm = tilemap({ grid: ['G'], tileAssets: { G: 'ast_missing' } });
    const container = buildTilemapContainer(tm, deps);
    expect(container.children).toHaveLength(1);
    expect(container.children[0]).toBeInstanceOf(Graphics);
  });
});

describe('buildTilemapContainer: fixed frame tiles', () => {
  it('resolves the named frame directly without blob47 neighbor resolution', () => {
    const deps = makeDeps({ ast_sheet: BASE_TEXTURE });
    const tm = tilemap({
      grid: ['GG'],
      tileAssets: { G: { sheet: 'ast_sheet', frame: 'floor_7' } },
    });
    const container = buildTilemapContainer(tm, deps);

    expect(container.children).toHaveLength(2);
    expect(container.children.every((child) => child instanceof Sprite)).toBe(true);
    expect(deps.calls).toEqual([
      { assetId: 'ast_sheet', frame: 'floor_7' },
      { assetId: 'ast_sheet', frame: 'floor_7' },
    ]);
  });
});

describe('buildTilemapContainer: autotile tiles resolve per neighbor mask', () => {
  // A 3x3 block of 'G' inside a '.' background — gives every position in the
  // block (center / edge / corner) a genuinely different neighbor mask,
  // unlike an all-G grid where every cell's off-grid neighbors count as
  // "same" and everything degenerates to mask 255.
  const GRID = ['.....', '.GGG.', '.GGG.', '.GGG.', '.....'];

  it('resolves each tile to resolveTileFrame(rule, computeMask(...)) for its own cell', () => {
    const deps = makeDeps({ ast_sheet: BASE_TEXTURE });
    const tm = tilemap({ grid: GRID, tileAssets: { G: RULE } });
    const container = buildTilemapContainer(tm, deps);

    // 3x3 = 9 'G' cells, each drawn as a Sprite (the sheet texture loaded).
    expect(container.children).toHaveLength(9);
    expect(container.children.every((c) => c instanceof Sprite)).toBe(true);

    // Re-derive the expected (row, col) iteration order and expected frame
    // independently via the same core resolver the implementation calls,
    // so this checks the WIRING (grid -> computeMask -> resolveTileFrame ->
    // resolveFrameTexture, in row-major cell order) rather than
    // re-implementing the mask math (already covered by
    // packages/core/tests/tilemapAutotile.test.ts).
    const expected: Array<{ assetId: string; frame: string }> = [];
    for (let row = 0; row < GRID.length; row++) {
      for (let col = 0; col < GRID[row].length; col++) {
        if (GRID[row][col] !== 'G') continue;
        const mask = computeMask(GRID, row, col, 'G');
        expected.push({ assetId: RULE.sheet, frame: resolveTileFrame(RULE, mask).frame });
      }
    }
    expect(deps.calls).toEqual(expected);

    // Concrete, human-checkable spot values: the block's dead center has all
    // 8 neighbours as 'G' (mask 255); a corner of the block only has its 3
    // interior-facing neighbours as 'G'.
    const centerMask = computeMask(GRID, 2, 2, 'G');
    expect(centerMask).toBe(255);
    expect(resolveTileFrame(RULE, centerMask).frame).toBe('blob_255');

    const cornerMask = computeMask(GRID, 1, 1, 'G'); // top-left of the block: only E, SE, S are 'G'
    expect(cornerMask).toBe(4 | 8 | 16);
    expect(deps.calls).toContainEqual({ assetId: 'ast_sheet', frame: resolveTileFrame(RULE, cornerMask).frame });
  });

  it('draws a placeholder when the rule\'s sheet texture is not loaded', () => {
    const deps = makeDeps({}); // sheet never preloaded
    const tm = tilemap({ grid: ['G'], tileAssets: { G: RULE } });
    const container = buildTilemapContainer(tm, deps);
    expect(container.children[0]).toBeInstanceOf(Graphics);
    expect(deps.calls).toHaveLength(0); // never asked to resolve a frame with no base texture
  });

  it('an isolated single tile (no same-char neighbours anywhere) resolves to the lone shape', () => {
    const deps = makeDeps({ ast_sheet: BASE_TEXTURE });
    const tm = tilemap({ grid: ['...', '.G.', '...'], tileAssets: { G: RULE } });
    buildTilemapContainer(tm, deps);
    expect(deps.calls).toEqual([{ assetId: 'ast_sheet', frame: 'blob_0' }]);
  });

  it('a custom mapping overrides the template frame name for the resolved shape', () => {
    const rule: AutotileRule = { sheet: 'ast_sheet', template: 'blob47', mapping: { '0': 'lone_g' } };
    const deps = makeDeps({ ast_sheet: BASE_TEXTURE });
    const tm = tilemap({ grid: ['...', '.G.', '...'], tileAssets: { G: rule } });
    buildTilemapContainer(tm, deps);
    expect(deps.calls).toEqual([{ assetId: 'ast_sheet', frame: 'lone_g' }]);
  });
});

describe('buildTilemapContainer: repaint (new grid identity) re-resolves neighbours', () => {
  it('a repainted neighbour cell changes the affected tile\'s resolved frame on the very next build', () => {
    const deps = makeDeps({ ast_sheet: BASE_TEXTURE });
    const gridA = ['.....', '.GGG.', '.GGG.', '.GGG.', '.....'];
    const tmA = tilemap({ grid: gridA, tileAssets: { G: RULE } });
    buildTilemapContainer(tmA, deps);
    // (row=1,col=2): top-middle of the block. Its N neighbour (0,2) is '.'
    // in gridA, so N is NOT one of its bits yet.
    const frameAtTopMiddleBefore = resolveTileFrame(RULE, computeMask(gridA, 1, 2, 'G')).frame;
    expect(deps.calls).toContainEqual({ assetId: 'ast_sheet', frame: frameAtTopMiddleBefore });

    // Painting never mutates a grid row in place (see tilemapCommands.ts's
    // paintCells) — it always returns a brand-new grid array, which is what
    // the runtime's OTHER grid-identity cache (colliders) also relies on.
    // Simulate that: a fresh array/rows, one cell added directly above the
    // block's top-middle tile — (1,2)'s N neighbour is now 'G' too.
    const gridB = [...gridA];
    gridB[0] = '..G..';
    expect(gridB).not.toBe(gridA); // new identity
    expect(gridB[0]).not.toBe(gridA[0]);

    const deps2 = makeDeps({ ast_sheet: BASE_TEXTURE });
    const tmB = tilemap({ grid: gridB, tileAssets: { G: RULE } });
    buildTilemapContainer(tmB, deps2);
    const frameAtTopMiddleAfter = resolveTileFrame(RULE, computeMask(gridB, 1, 2, 'G')).frame;
    expect(deps2.calls).toContainEqual({ assetId: 'ast_sheet', frame: frameAtTopMiddleAfter });

    expect(frameAtTopMiddleAfter).not.toBe(frameAtTopMiddleBefore);

    // The render path never clones/mutates the grid it was given — the
    // runtime's tilemap collider cache keys on grid array identity.
    expect(tmA.grid).toBe(gridA);
    expect(tmB.grid).toBe(gridB);
  });
});

describe('buildTilemapContainer: mixed string + autotile tileAssets in one grid', () => {
  it('renders string tiles and autotile tiles side by side, each via their own arm', () => {
    const deps = makeDeps({ ast_grass: BASE_TEXTURE, ast_sheet: BASE_TEXTURE });
    const tm = tilemap({
      grid: ['GW'],
      tileAssets: { G: 'ast_grass', W: RULE },
    });
    const container = buildTilemapContainer(tm, deps);
    expect(container.children).toHaveLength(2);
    // Only the autotile char ('W') goes through resolveFrameTexture.
    expect(deps.calls).toEqual([{ assetId: 'ast_sheet', frame: resolveTileFrame(RULE, computeMask(['GW'], 0, 1, 'W')).frame }]);
  });
});
