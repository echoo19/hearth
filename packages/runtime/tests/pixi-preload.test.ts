/**
 * collectPreloadAssetIds — resolves the full set of texture asset ids to load
 * up front. Regression cover for the "runtime-switched animation clip renders
 * white" bug: previously only animations statically referenced by a
 * SpriteAnimator.assetId were preloaded, so a clip switched at runtime via
 * ctx.animate() had never loaded its sheet and drew solid white. The fix
 * preloads EVERY animation asset's frame textures regardless of reference.
 */
import { describe, it, expect } from 'vitest';
import type { Asset } from '@hearth/core';
import {
  collectPreloadAssetIds,
  frameTextureAssetId,
  type PreloadComponents,
} from '../src/pixi/preload.js';

function animAsset(id: string, name: string): Asset {
  return { id, name, type: 'animation', path: `animations/${name}.json` } as Asset;
}

describe('frameTextureAssetId', () => {
  it('returns a plain sprite-asset id unchanged', () => {
    expect(frameTextureAssetId('ast_sprite')).toBe('ast_sprite');
  });
  it('takes the sheet id before the FIRST # for a sheet-frame ref', () => {
    expect(frameTextureAssetId('ast_sheet#walk_0')).toBe('ast_sheet');
    expect(frameTextureAssetId('ast_sheet#odd#name')).toBe('ast_sheet');
  });
});

describe('collectPreloadAssetIds', () => {
  const framesByAsset: Record<string, string[]> = {
    ast_walk: ['ast_walk_sheet#w0', 'ast_walk_sheet#w1'],
    ast_jump: ['ast_jump_sheet#j0'],
  };
  const readAnimationFrames = async (asset: Asset): Promise<string[]> =>
    framesByAsset[asset.id] ?? [];

  it('preloads textures for an animation NOT referenced by any SpriteAnimator', async () => {
    // Only ast_walk is referenced by a component; ast_jump is a runtime-only
    // clip (switched via ctx.animate). Both sheets must be preloaded.
    const componentSets: PreloadComponents[] = [
      { SpriteAnimator: { assetId: 'ast_walk' } },
    ];
    const ids = await collectPreloadAssetIds({
      componentSets,
      assets: [animAsset('ast_walk', 'walk'), animAsset('ast_jump', 'jump')],
      readAnimationFrames,
    });
    expect(ids.has('ast_walk_sheet')).toBe(true);
    expect(ids.has('ast_jump_sheet')).toBe(true);
  });

  it('includes sprite and tilemap textures referenced by components', async () => {
    const componentSets: PreloadComponents[] = [
      { SpriteRenderer: { assetId: 'ast_hero' } },
      { Tilemap: { tileAssets: { a: 'ast_tile', b: { sheet: 'ast_terrain' } } } },
    ];
    const ids = await collectPreloadAssetIds({
      componentSets,
      assets: [],
      readAnimationFrames,
    });
    expect(ids.has('ast_hero')).toBe(true);
    expect(ids.has('ast_tile')).toBe(true);
    expect(ids.has('ast_terrain')).toBe(true);
  });

  it('warns (not throws) when an animation asset fails to read', async () => {
    const warnings: string[] = [];
    const ids = await collectPreloadAssetIds({
      componentSets: [],
      assets: [animAsset('ast_bad', 'bad')],
      readAnimationFrames: async () => {
        throw new Error('boom');
      },
      onWarn: (m) => warnings.push(m),
    });
    expect(ids.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bad');
  });
});
