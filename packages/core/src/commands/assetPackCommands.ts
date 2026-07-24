import { z } from 'zod';
import { inspectAssetPack as analyzeAssetPack } from '../assets/assetPack.js';
import { ProjectError } from '../project/store.js';
import { defineCommand } from './types.js';

export const inspectAssetPack = defineCommand({
  name: 'inspectAssetPack',
  description:
    'Inspect a downloaded asset pack before import: provenance hints, images, Tiled metadata, compatibility diagnostics, and ordered visual-review inputs.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    path: z.string().min(1),
    sourceUrl: z.string().url().optional(),
    author: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
  }).strict(),
  async run(ctx, params) {
    try {
      return await analyzeAssetPack(ctx.fs, params);
    } catch (error) {
      throw new ProjectError(error instanceof Error ? error.message : String(error), 'INVALID_INPUT');
    }
  },
});
