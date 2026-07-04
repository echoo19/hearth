import { z } from 'zod';
import { SpritesheetFrameSchema, type Asset, type SpritesheetFrame } from '../schema/project.js';

const FramesArray = z.array(SpritesheetFrameSchema);

/** The only sanctioned reader of asset.metadata.frames. [] when absent or invalid. */
export function getSheetFrames(asset: Asset): SpritesheetFrame[] {
  const parsed = FramesArray.safeParse(asset.metadata.frames);
  return parsed.success ? parsed.data : [];
}

export function findSheetFrame(asset: Asset, name: string): SpritesheetFrame | null {
  return getSheetFrames(asset).find((f) => f.name === name) ?? null;
}
