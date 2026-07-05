/**
 * Pure helpers shared between the Assets panel's card/detail previews and
 * the Slice dialog: reading the numeric bits of asset.metadata safely
 * (metadata is Record<string, unknown> — never trust it blindly, it's
 * user/agent-writable via setAssetMetadata) and cropping one spritesheet
 * frame to a CSS background-position box.
 */
import type { CSSProperties } from 'react';
import type { SpritesheetFrame } from '@hearth/core';
import type { AssetItem } from './types';

/** Same checkerboard pattern used behind every transparent-image thumbnail
 * (asset-thumb in styles.css) so previews read as one consistent surface. */
export const CHECKERBOARD_BG =
  'repeating-conic-gradient(oklch(0.28 0.008 55) 0% 25%, oklch(0.23 0.008 55) 0% 50%) 0 0 / 16px 16px';

export interface SheetGrid {
  frameWidth: number;
  frameHeight: number;
  margin: number;
  spacing: number;
}

/** asset.metadata.grid, written by sliceSpritesheet. Null when absent/malformed. */
export function readSheetGrid(asset: AssetItem): SheetGrid | null {
  const g = asset.metadata.grid;
  if (!g || typeof g !== 'object') return null;
  const rec = g as Record<string, unknown>;
  if (typeof rec.frameWidth !== 'number' || typeof rec.frameHeight !== 'number') return null;
  return {
    frameWidth: rec.frameWidth,
    frameHeight: rec.frameHeight,
    margin: typeof rec.margin === 'number' ? rec.margin : 0,
    spacing: typeof rec.spacing === 'number' ? rec.spacing : 0,
  };
}

/** asset.metadata.width/height (full sheet pixel size), also written by sliceSpritesheet. */
export function readSheetSize(asset: AssetItem): { width: number; height: number } | null {
  const { width, height } = asset.metadata;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  return { width, height };
}

/**
 * An animation's frame ref, exactly as the runtime animator parses it
 * (packages/runtime/src/animator.ts): a plain sprite/tile asset ref, or
 * `<sheetAssetId>#<frameName>` split on the first '#'.
 */
export function parseFrameRef(ref: string): { assetRef: string; frameName: string | null } {
  const i = ref.indexOf('#');
  return i === -1 ? { assetRef: ref, frameName: null } : { assetRef: ref.slice(0, i), frameName: ref.slice(i + 1) };
}

/** Crop one frame of a sliced sheet down to `boxPx`, preserving aspect ratio. */
export function frameCrop(
  imageUrl: string,
  sheetSize: { width: number; height: number },
  frame: Pick<SpritesheetFrame, 'x' | 'y' | 'width' | 'height'>,
  boxPx: number,
): { width: number; height: number; style: CSSProperties } {
  const scale = Math.min(4, boxPx / Math.max(frame.width, frame.height, 1));
  return {
    width: Math.max(1, Math.round(frame.width * scale)),
    height: Math.max(1, Math.round(frame.height * scale)),
    style: {
      position: 'absolute',
      inset: 0,
      backgroundImage: `url("${imageUrl}")`,
      backgroundPosition: `-${Math.round(frame.x * scale)}px -${Math.round(frame.y * scale)}px`,
      backgroundSize: `${Math.round(sheetSize.width * scale)}px ${Math.round(sheetSize.height * scale)}px`,
      backgroundRepeat: 'no-repeat',
      imageRendering: 'pixelated',
    },
  };
}
