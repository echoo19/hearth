/**
 * Pure(-ish) Tilemap display-graph builder, split out of PixiSceneView so it
 * can be unit tested without a real canvas/WebGL Application (see
 * ../../tests/tilemapRender.test.ts — PixiSceneView.mount() needs a real
 * browser canvas, same reason font-face loading is split into fonts.ts).
 *
 * A tile char resolves to a texture one of three ways:
 *   - Plain asset id (string arm): the whole preloaded texture, unchanged.
 *   - Fixed frame: the named sliced-sheet frame, unchanged per cell.
 *   - Autotile rule: the per-cell frame is picked from the 8
 *     neighbours sharing this cell's char (see @hearth/core's
 *     computeMask/resolveTileFrame — the blob47 resolver), then cropped from
 *     the rule's sheet texture exactly like a sliced SpriteRenderer frame.
 *
 * Every call walks `tilemap.grid` fresh — nothing here caches by (row, col)
 * alone, so a repainted grid (a NEW grid array; painting never mutates rows
 * in place) always re-resolves every neighbour mask from the grid passed in.
 * `deps` is dependency-injected (not read from a class) specifically so this
 * function has no hidden state to go stale across calls.
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { computeMask, isTileFrameSource, resolveTileFrame, type TilemapComponent } from '@hearth/core';

export interface TilemapRenderDeps {
  /** Preloaded whole texture for a plain asset id or an object source's `sheet`. Undefined = not loaded / missing. */
  getTexture(assetId: string): Texture | undefined;
  /** Crop `base` to `frameName` on `assetId`'s sliced sheet metadata; falls back to `base` (whole image) when the frame isn't found. */
  resolveFrameTexture(assetId: string, frameName: string, base: Texture): Texture;
}

const EMPTY_TILE_COLOR = '#888888';

/** Builds one Container of tile Sprites (or gray placeholder Graphics for an unresolved tile), local-positioned by tileSize. */
export function buildTilemapContainer(tilemap: TilemapComponent, deps: TilemapRenderDeps): Container {
  const container = new Container();
  const ts = tilemap.tileSize;
  for (let row = 0; row < tilemap.grid.length; row++) {
    const line = tilemap.grid[row];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === '.' || ch === ' ') continue;
      const tile = tilemap.tileAssets[ch];
      let texture: Texture | undefined;
      if (typeof tile === 'string') {
        texture = deps.getTexture(tile);
      } else if (isTileFrameSource(tile)) {
        const base = deps.getTexture(tile.sheet);
        if (base) texture = deps.resolveFrameTexture(tile.sheet, tile.frame, base);
      } else if (tile) {
        const base = deps.getTexture(tile.sheet);
        if (base) {
          const mask = computeMask(tilemap.grid, row, col, ch);
          const { frame } = resolveTileFrame(tile, mask);
          texture = deps.resolveFrameTexture(tile.sheet, frame, base);
        }
      }
      if (texture) {
        const s = new Sprite(texture);
        s.position.set(col * ts, row * ts);
        s.width = ts;
        s.height = ts;
        container.addChild(s);
      } else {
        const g = new Graphics();
        g.rect(col * ts, row * ts, ts, ts).fill(EMPTY_TILE_COLOR);
        container.addChild(g);
      }
    }
  }
  return container;
}
