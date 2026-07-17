/**
 * buildSpriteRenderable + the pixel-art helpers: the pure(-ish) SpriteRenderer
 * display builder split out of PixiSceneView so the tile/sliced/stretch fills
 * and the NEAREST-filtering rule are testable without a real canvas/WebGL
 * Application — exact same setup as pixi-tilemapRender.test.ts (including the
 * vi.hoisted navigator shim that lets `pixi.js` import under Node 20).
 */
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.navigator === 'undefined') {
    (globalThis as { navigator?: Navigator }).navigator = { userAgent: 'node' } as Navigator;
  }
});

import { NineSliceSprite, Sprite, TilingSprite, Texture, TextureSource } from 'pixi.js';
import { SpriteRendererSchema, type SpriteRendererComponent } from '@hearth/core';
import {
  buildSpriteRenderable,
  clampNineSliceInsets,
  pixelArtScaleMode,
  resolvePixelArt,
  snapPixelScale,
  type SpriteRenderDeps,
} from '../src/pixi/spriteRender.js';

/**
 * A real, canvas-free 16x16 Texture standing in for a loaded 16px tile.
 * (Texture.WHITE is only 1x1 in Pixi v8, too small to see repeat/inset math —
 * a bare TextureSource constructs fine in Node with no GPU/canvas.)
 */
const BASE_TEXTURE = new Texture({ source: new TextureSource({ width: 16, height: 16 }) });

function sprite(overrides: Partial<SpriteRendererComponent>): SpriteRendererComponent {
  return SpriteRendererSchema.parse({ assetId: 'ast_tile', ...overrides });
}

function makeDeps(textures: Record<string, Texture | undefined>): SpriteRenderDeps {
  return {
    getTexture: (assetId) => textures[assetId],
    resolveFrameTexture: (_assetId, _frame, base) => base,
  };
}

describe('buildSpriteRenderable: stretch mode (unchanged historical behavior)', () => {
  it('a textured stretch sprite is a plain Sprite scaled to width×height', () => {
    const node = buildSpriteRenderable(
      sprite({ renderMode: 'stretch', width: 200, height: 18 }),
      makeDeps({ ast_tile: BASE_TEXTURE }),
    );
    expect(node).toBeInstanceOf(Sprite);
    expect(node).not.toBeInstanceOf(TilingSprite);
    expect(node).not.toBeInstanceOf(NineSliceSprite);
    const s = node as Sprite;
    expect(s.width).toBe(200);
    expect(s.height).toBe(18);
    expect(s.anchor.x).toBe(0.5);
  });

  it('the default renderMode is stretch (back-compat for old projects)', () => {
    expect(SpriteRendererSchema.parse({}).renderMode).toBe('stretch');
  });
});

describe('buildSpriteRenderable: tile mode (native texels, no distortion)', () => {
  it('is a TilingSprite whose texture keeps its native size (tileScale 1)', () => {
    const node = buildSpriteRenderable(
      sprite({ renderMode: 'tile', width: 160, height: 16 }),
      makeDeps({ ast_tile: BASE_TEXTURE }),
    );
    expect(node).toBeInstanceOf(TilingSprite);
    const t = node as TilingSprite;
    // tileScale 1 in both axes = the texture is drawn at its NATIVE pixel size
    // and repeated, never squashed to fit the box.
    expect(t.tileScale.x).toBe(1);
    expect(t.tileScale.y).toBe(1);
    expect(t.texture.width).toBe(BASE_TEXTURE.width); // native texel size preserved
  });

  it('fills the box by repeating: repeat count = box width / native texel width', () => {
    const box = 160;
    const node = buildSpriteRenderable(
      sprite({ renderMode: 'tile', width: box, height: 16 }),
      makeDeps({ ast_tile: BASE_TEXTURE }),
    ) as TilingSprite;
    expect(node.width).toBe(box);
    // A 160px-wide platform built from a 16px tile shows exactly 10 whole
    // repeats (connected tiles), not one 10x-stretched smear.
    const repeats = node.width / (node.texture.width * node.tileScale.x);
    expect(repeats).toBe(10);
  });
});

describe('buildSpriteRenderable: sliced mode (9-slice, corners un-stretched)', () => {
  it('is a NineSliceSprite carrying the slice insets and the box size', () => {
    const node = buildSpriteRenderable(
      sprite({ renderMode: 'sliced', width: 120, height: 40, slice: { top: 4, right: 5, bottom: 4, left: 5 } }),
      makeDeps({ ast_tile: BASE_TEXTURE }),
    );
    expect(node).toBeInstanceOf(NineSliceSprite);
    const n = node as NineSliceSprite;
    expect(n.leftWidth).toBe(5);
    expect(n.rightWidth).toBe(5);
    expect(n.topHeight).toBe(4);
    expect(n.bottomHeight).toBe(4);
    expect(n.width).toBe(120);
    expect(n.height).toBe(40);
  });
});

describe('clampNineSliceInsets', () => {
  it('leaves in-range insets untouched', () => {
    expect(clampNineSliceInsets({ left: 3, right: 4, top: 2, bottom: 5 }, 16, 16)).toEqual({
      left: 3,
      right: 4,
      top: 2,
      bottom: 5,
    });
  });

  it('clamps so left+right never exceed the texture width (corners stay intact)', () => {
    const out = clampNineSliceInsets({ left: 20, right: 20, top: 0, bottom: 0 }, 16, 16);
    expect(out.left).toBe(16);
    expect(out.right).toBe(0);
    expect(out.left + out.right).toBeLessThanOrEqual(16);
  });

  it('clamps negative insets up to 0', () => {
    expect(clampNineSliceInsets({ left: -5, right: -5, top: -1, bottom: -1 }, 16, 16)).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
  });
});

describe('buildSpriteRenderable: primitive fallback (unchanged)', () => {
  it('returns null for a bare shape:none with no asset', () => {
    expect(buildSpriteRenderable(sprite({ assetId: null, shape: 'none' }), makeDeps({}))).toBeNull();
  });

  it('draws a primitive (not a Sprite) when no texture is loaded', () => {
    const node = buildSpriteRenderable(sprite({ assetId: null, shape: 'rectangle' }), makeDeps({}));
    expect(node).not.toBeNull();
    expect(node).not.toBeInstanceOf(Sprite);
  });
});

describe('resolvePixelArt', () => {
  it('inherits the project default when the asset has no override', () => {
    expect(resolvePixelArt(undefined, true)).toBe(true);
    expect(resolvePixelArt(null, false)).toBe(false);
  });

  it('lets a per-asset flag override the project default either way', () => {
    expect(resolvePixelArt(false, true)).toBe(false);
    expect(resolvePixelArt(true, false)).toBe(true);
  });
});

describe('pixel-art filtering / scale snapping', () => {
  it('maps pixel art to NEAREST and non-pixel to linear', () => {
    expect(pixelArtScaleMode(true)).toBe('nearest');
    expect(pixelArtScaleMode(false)).toBe('linear');
  });

  it('actually applies NEAREST to a real texture source (the render-path target)', () => {
    const source = new TextureSource({ width: 8, height: 8 });
    source.scaleMode = pixelArtScaleMode(resolvePixelArt(undefined, true));
    expect(source.scaleMode).toBe('nearest');
    source.scaleMode = pixelArtScaleMode(resolvePixelArt(false, true));
    expect(source.scaleMode).toBe('linear');
    source.destroy();
  });

  it('snaps a fractional upscale to the nearest whole factor (min 1x)', () => {
    expect(snapPixelScale(2.5)).toBe(3); // Math.round half-up
    expect(snapPixelScale(2.4)).toBe(2);
    expect(snapPixelScale(1)).toBe(1);
    expect(snapPixelScale(0.5)).toBe(1); // downscale clamps to 1x
    expect(snapPixelScale(0)).toBe(1);
    expect(snapPixelScale(Number.NaN)).toBe(1);
    expect(snapPixelScale(-3)).toBe(1);
  });
});
