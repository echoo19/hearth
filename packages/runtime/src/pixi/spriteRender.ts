/**
 * Pure(-ish) SpriteRenderer display-object builder, split out of PixiSceneView
 * so the tile/sliced/stretch modes and the pixel-art helpers can be unit
 * tested without a real canvas/WebGL Application — the exact same pattern (and
 * for the exact same reason) as ./tilemapRender.ts. Pixi's
 * Sprite/TilingSprite/NineSliceSprite/Graphics/Texture classes all construct
 * fine in plain Node; nothing here renders to a surface.
 *
 * The whole point of this module is that a textured SpriteRenderer chooses ONE
 * of three fills for its width×height box:
 *   - `stretch` (default, back-compat): a plain Sprite scaled to the box. The
 *     single texture is squashed to fit — the historical behavior, distorts
 *     pixel art when the box aspect ≠ the texture's.
 *   - `tile`: a TilingSprite that REPEATS the texture at its native pixel size
 *     (tileScale 1) to fill the box. A wide platform made from one 18px tile
 *     reads as connected tiles instead of a horizontal smear. Native texels
 *     are preserved.
 *   - `sliced`: a NineSliceSprite whose `slice` insets keep the four corners at
 *     native size while the edges/center scale. For panels/bars with distinct
 *     ends. Native corner texels are preserved.
 *
 * `deps` is dependency-injected (not read from a class) so this builder has no
 * hidden state — same contract as TilemapRenderDeps.
 */
import { Container, Graphics, NineSliceSprite, Sprite, TilingSprite, type Texture } from 'pixi.js';
import type { SpriteRendererComponent, SpriteSlice } from '@hearth/core';

export interface SpriteRenderDeps {
  /** Preloaded whole texture for an asset id, or undefined when not loaded / missing. */
  getTexture(assetId: string): Texture | undefined;
  /** Crop `base` to `frameName` on `assetId`'s sliced sheet metadata; falls back to `base` (whole image). */
  resolveFrameTexture(assetId: string, frameName: string, base: Texture): Texture;
}

/**
 * Resolves the effective pixel-art flag for a texture: the per-asset override
 * when it's set (true/false), otherwise the project's `pixelPerfect` default.
 * Kept pure so both the render path and tests agree on the rule.
 */
export function resolvePixelArt(
  assetPixelArt: boolean | null | undefined,
  projectPixelPerfect: boolean,
): boolean {
  return assetPixelArt ?? projectPixelPerfect;
}

/** Maps the resolved pixel-art flag to Pixi's SCALE_MODE string for a texture source. */
export function pixelArtScaleMode(pixelArt: boolean): 'nearest' | 'linear' {
  return pixelArt ? 'nearest' : 'linear';
}

/**
 * Snaps an upscale factor to the nearest whole number (min 1×) so a pixel-art
 * sprite drawn at, say, 2.5× lands on 2× or 3× — square texels — instead of a
 * fractional scale that smears rows/columns unevenly. Downscales and
 * non-finite inputs clamp to 1× (downscaling pixel art is never pixel-perfect;
 * that's a resampling problem, not a snapping one).
 */
export function snapPixelScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(1, Math.round(scale));
}

/**
 * Clamps nine-slice insets so left+right never exceed the texture width (and
 * top+bottom never exceed its height). Insets that overrun the texture make
 * Pixi's NineSliceGeometry produce overlapping/negative edge quads; clamping
 * keeps corners intact and degrades gracefully to "no center" instead.
 */
export function clampNineSliceInsets(
  slice: SpriteSlice,
  textureWidth: number,
  textureHeight: number,
): { left: number; right: number; top: number; bottom: number } {
  const clampPair = (a: number, b: number, max: number): [number, number] => {
    const left = Math.max(0, Math.min(a, max));
    const right = Math.max(0, Math.min(b, max - left));
    return [left, right];
  };
  const [left, right] = clampPair(slice.left, slice.right, textureWidth);
  const [top, bottom] = clampPair(slice.top, slice.bottom, textureHeight);
  return { left, right, top, bottom };
}

/** Builds the textured display object for the sprite's renderMode. */
function buildTexturedSprite(sprite: SpriteRendererComponent, texture: Texture): Container {
  switch (sprite.renderMode) {
    case 'tile': {
      // tileScale defaults to 1 → the texture repeats at its NATIVE pixel size;
      // the box (width×height) is filled with whole/partial repeats, never a
      // single squashed copy. anchor 0.5 matches the stretch Sprite's centering.
      const s = new TilingSprite({
        texture,
        width: sprite.width,
        height: sprite.height,
        anchor: 0.5,
      });
      s.tint = sprite.color;
      return s;
    }
    case 'sliced': {
      const { left, right, top, bottom } = clampNineSliceInsets(
        sprite.slice,
        texture.width,
        texture.height,
      );
      const s = new NineSliceSprite({
        texture,
        leftWidth: left,
        topHeight: top,
        rightWidth: right,
        bottomHeight: bottom,
        width: sprite.width,
        height: sprite.height,
        anchor: 0.5,
      });
      s.tint = sprite.color;
      return s;
    }
    default: {
      // 'stretch' — unchanged historical behavior: one Sprite scaled to the box.
      const s = new Sprite(texture);
      s.anchor.set(0.5);
      s.width = sprite.width;
      s.height = sprite.height;
      s.tint = sprite.color;
      return s;
    }
  }
}

/**
 * Builds the SpriteRenderer's display object: a textured Sprite/TilingSprite/
 * NineSliceSprite when the asset resolves, otherwise the colored-primitive
 * Graphics fallback (rectangle/circle/triangle, or a stroked placeholder box
 * when an asset was set but its texture failed to load). Returns null only for
 * a bare `shape:'none'` with no asset — nothing to draw.
 */
export function buildSpriteRenderable(
  sprite: SpriteRendererComponent,
  deps: SpriteRenderDeps,
): Container | null {
  const base = sprite.assetId ? deps.getTexture(sprite.assetId) : undefined;
  if (base) {
    const texture =
      sprite.frame && sprite.assetId
        ? deps.resolveFrameTexture(sprite.assetId, sprite.frame, base)
        : base;
    return buildTexturedSprite(sprite, texture);
  }
  if (sprite.shape === 'none' && !sprite.assetId) return null;
  const g = new Graphics();
  const w = sprite.width;
  const h = sprite.height;
  switch (sprite.shape) {
    case 'circle':
      g.circle(0, 0, Math.min(w, h) / 2).fill(sprite.color);
      break;
    case 'triangle':
      g.poly([-w / 2, h / 2, w / 2, h / 2, 0, -h / 2]).fill(sprite.color);
      break;
    case 'none':
      // Asset was set but its texture failed to load: visible placeholder.
      g.rect(-w / 2, -h / 2, w, h).stroke({ width: 1, color: sprite.color });
      break;
    default:
      g.rect(-w / 2, -h / 2, w, h).fill(sprite.color);
      break;
  }
  return g;
}
