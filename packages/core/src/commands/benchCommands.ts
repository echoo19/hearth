import { z } from 'zod';
import { defineCommand } from './types.js';
import { ProjectError } from '../project/store.js';

/**
 * Headless performance check. Steps a scene for warmup frames (untimed), then
 * times N measured frames and reports the per-frame ms distribution so an agent
 * can tell whether a scene holds 60fps (16.67ms/frame) before shipping it. The
 * heavy runtime work is injected via RuntimeHooks.benchScene — core never
 * imports the runtime directly. Summary only, no per-frame array (token frugal).
 */
export const benchScene = defineCommand({
  name: 'benchScene',
  description:
    'Benchmark a scene headlessly: step warmup frames, then time N measured frames and ' +
    'report per-frame ms (avg/median/p95/max/total) so you can check whether it holds 60fps ' +
    '(16.67ms/frame). Optionally pass budgetMs to get a withinBudget verdict. Summary only.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    /** Scene id or name. Defaults to the project's initial scene (same resolution as runScene). */
    scene: z.string().min(1).optional(),
    frames: z.number().int().positive().max(36000).default(600),
    /** Frames stepped but not measured, to warm up JIT/allocation. */
    warmupFrames: z.number().int().nonnegative().max(36000).default(60),
    /** Per-frame budget in ms; when set, the result includes withinBudget (medianMs <= budgetMs). */
    budgetMs: z.number().positive().optional(),
  }),
  async run(ctx, params) {
    if (!ctx.runtime?.benchScene) {
      throw new ProjectError(
        'Scene runtime not available in this context (runtime hooks not injected).',
        'INVALID_INPUT',
      );
    }
    const sceneRef = params.scene ?? ctx.store.project.initialScene ?? undefined;
    if (!sceneRef) {
      throw new ProjectError(
        'No scene specified and the project has no initial scene set.',
        'NOT_FOUND',
      );
    }
    const scene = ctx.store.getScene(sceneRef);
    if (!scene) throw new ProjectError(`Scene not found: ${sceneRef}`, 'NOT_FOUND');
    return ctx.runtime.benchScene(ctx.store, scene.id, {
      frames: params.frames,
      warmupFrames: params.warmupFrames,
      budgetMs: params.budgetMs,
    });
  },
});
