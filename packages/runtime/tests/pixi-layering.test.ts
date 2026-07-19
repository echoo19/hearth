/**
 * resolveEntityZIndex — the per-entity container zIndex. Regression cover for
 * the negative-layer flattening bug: an entity authored at a negative `layer`
 * (backgrounds/parallax at -2/-1) must keep its negative zIndex instead of
 * being clamped to 0 by a phantom `?? 0` folded in for every absent component.
 */
import { describe, it, expect } from 'vitest';
import {
  SpriteRendererSchema,
  TextSchema,
  TilemapSchema,
} from '@hearth/core';
import { resolveEntityZIndex } from '../src/pixi/layering.js';

describe('resolveEntityZIndex', () => {
  it('preserves a negative layer instead of clamping it to 0', () => {
    const bg = { SpriteRenderer: SpriteRendererSchema.parse({ assetId: 'a', layer: -2 }) };
    const mg = { SpriteRenderer: SpriteRendererSchema.parse({ assetId: 'a', layer: -1 }) };
    expect(resolveEntityZIndex(bg)).toBe(-2);
    expect(resolveEntityZIndex(mg)).toBe(-1);
  });

  it('orders entities at layers -2, -1, 0, 1 monotonically', () => {
    const at = (layer: number) => ({ SpriteRenderer: SpriteRendererSchema.parse({ assetId: 'a', layer }) });
    const zs = [-2, -1, 0, 1].map((l) => resolveEntityZIndex(at(l)));
    expect(zs).toEqual([-2, -1, 0, 1]);
    // Strictly increasing, so Pixi's sortableChildren draws them back-to-front.
    for (let i = 1; i < zs.length; i++) expect(zs[i]).toBeGreaterThan(zs[i - 1]);
  });

  it('ignores absent components rather than folding a 0 into the max', () => {
    // A lone Text at layer -5 must NOT be lifted to 0 by the missing sprite/
    // tilemap/line/slider/toggle each contributing a phantom 0.
    const text = { Text: TextSchema.parse({ layer: -5 }) };
    expect(resolveEntityZIndex(text)).toBe(-5);
  });

  it('takes the max layer among the renderable components actually present', () => {
    const both = {
      Tilemap: TilemapSchema.parse({ layer: -3 }),
      Text: TextSchema.parse({ layer: 7 }),
    };
    expect(resolveEntityZIndex(both)).toBe(7);
  });

  it('defaults to 0 when the entity has no layered renderable', () => {
    expect(resolveEntityZIndex({})).toBe(0);
  });
});
