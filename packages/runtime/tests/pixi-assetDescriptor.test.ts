import { describe, expect, it } from 'vitest';
import type { Asset } from '@hearth/core';
import { pixiTextureAssetDescriptor } from '../src/pixi/assetDescriptor.js';

function asset(path: string, type: Asset['type'] = 'sprite'): Asset {
  return {
    id: 'ast_test',
    name: 'test',
    type,
    path,
    metadata: {},
  };
}

describe('pixiTextureAssetDescriptor', () => {
  it('passes Pixi an explicit parser hint from the real asset path when the URL has no extension', () => {
    expect(pixiTextureAssetDescriptor(asset('assets/sprites/wisp.svg'), '/api/file?project=p&path=assets%2Fsprites%2Fwisp.svg')).toEqual({
      src: '/api/file?project=p&path=assets%2Fsprites%2Fwisp.svg',
      parser: 'svg',
    });

    expect(pixiTextureAssetDescriptor(asset('assets/sprites/hero.PNG'), '/api/file?project=p&path=assets%2Fsprites%2Fhero.PNG')).toEqual({
      src: '/api/file?project=p&path=assets%2Fsprites%2Fhero.PNG',
      parser: 'texture',
    });
  });

  it('leaves non-image asset paths as plain URLs', () => {
    expect(pixiTextureAssetDescriptor(asset('assets/data/loot.json', 'data'), '/api/file?project=p&path=assets%2Fdata%2Floot.json')).toBe(
      '/api/file?project=p&path=assets%2Fdata%2Floot.json',
    );
  });
});
