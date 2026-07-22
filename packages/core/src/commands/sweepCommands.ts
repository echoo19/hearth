/**
 * Bot playtesting commands: `sweepScene` plays a scene with seeded bot policies
 * across many seeds headlessly and reports softlocks/crashes/unreached
 * objectives token-frugally; `bakePlaytest` freezes one bot run into a normal
 * scripted playtest (red until the bug is fixed, green forever after).
 *
 * The heavy runtime work lives in @hearth/playtest and is injected via
 * RuntimeHooks — core never imports the runtime directly (mirrors benchScene).
 */
import { z } from 'zod';
import { defineCommand } from './types.js';
import { ProjectError } from '../project/store.js';
import { ObjectiveSchema } from '../schema/project.js';
import { Vec2Schema } from '../schema/components.js';
import { persistPlaytest } from './diffCommands.js';

/** Built-in bot policies a sweep can drive the scene with. */
const POLICY_NAMES = ['mash', 'wander', 'seek', 'idle'] as const;

/** A steering target: an entity ref (id/name/tag) or a world point. */
const targetSchema = z.union([z.string(), Vec2Schema]);

/**
 * Budget guard: policies × seeds × maxFrames must stay under this so sweeps
 * always finish in seconds (~1-3 ms/frame headless). Above it, the command
 * fails fast before running anything.
 */
export const SWEEP_FRAME_BUDGET = 400_000;

export const sweepScene = defineCommand({
  name: 'sweepScene',
  description:
    'Bot players play the scene headlessly across seeds and report softlocks, crashes, and ' +
    'unreached objectives. Run after gameplay changes and to find repro seeds for reported bugs. ' +
    'Summary only (token-frugal).',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    /** Scene id or name. Defaults to the project's initial scene (same resolution as runScene). */
    scene: z.string().min(1).optional(),
    /** Which policies to run; each policy is run against every seed. */
    policies: z.array(z.enum(POLICY_NAMES)).min(1).default(['mash']),
    /** Number of consecutive seeds per policy: seedStart .. seedStart+seeds-1. */
    seeds: z.number().int().positive().default(8),
    /** Seed offset, so a later sweep can extend an earlier one without overlap. */
    seedStart: z.number().int().nonnegative().default(0),
    /** Per-run frame cap (same clamp semantics as playtests). */
    maxFrames: z.number().int().positive().default(600),
    /** Entity id/name/tag the bots steer; defaults to the sole input-reading entity. */
    avatar: z.string().optional(),
    /** Declared success/failure criteria evaluated per run. */
    objectives: z.array(ObjectiveSchema).default([]),
    /** seek only: where to go (entity ref or world point). */
    target: targetSchema.optional(),
    /** Frames with no novelty before a run is judged 'stuck'. */
    stuckAfter: z.number().int().positive().default(180),
    /** Include the ASCII coverage grid in `data` (token cost — off by default). */
    heatmap: z.boolean().default(false),
  }),
  async run(ctx, params) {
    if (!ctx.runtime?.sweepScene) {
      throw new ProjectError(
        'Scene runtime not available in this context (runtime hooks not injected).',
        'INVALID_INPUT',
      );
    }
    const sceneRef = params.scene ?? ctx.store.project.initialScene ?? undefined;
    if (!sceneRef) {
      throw new ProjectError('No scene specified and the project has no initial scene set.', 'NOT_FOUND');
    }
    const scene = ctx.store.getScene(sceneRef);
    if (!scene) throw new ProjectError(`Scene not found: ${sceneRef}`, 'NOT_FOUND');

    // Budget guard: fail fast before running a single frame.
    const budget = params.policies.length * params.seeds * params.maxFrames;
    if (budget > SWEEP_FRAME_BUDGET) {
      throw new ProjectError(
        `Sweep budget exceeded: ${params.policies.length} policies × ${params.seeds} seeds × ` +
          `${params.maxFrames} maxFrames = ${budget} frames > ${SWEEP_FRAME_BUDGET}. ` +
          `Reduce seeds, policies, or maxFrames.`,
        'INVALID_INPUT',
      );
    }

    const data = await ctx.runtime.sweepScene(ctx.store, {
      scene: scene.id,
      policies: params.policies,
      seeds: params.seeds,
      seedStart: params.seedStart,
      maxFrames: params.maxFrames,
      avatar: params.avatar,
      target: params.target,
      objectives: params.objectives,
      stuckAfter: params.stuckAfter,
      heatmap: params.heatmap,
    });

    // Record the on-disk report file (read-only commands can't populate files[]
    // via save(), so surface it through changed[] + data.reportFile).
    const reportFile = (data as { reportFile?: unknown } | null)?.reportFile;
    if (typeof reportFile === 'string') {
      ctx.changed({ kind: 'file', path: reportFile, action: 'created' });
    }
    return data;
  },
});

export const bakePlaytest = defineCommand({
  name: 'bakePlaytest',
  description:
    'Freeze a failing sweep run into a deterministic regression playtest — red until fixed.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    /** Playtest asset name to create. */
    name: z.string().min(1),
    scene: z.string().min(1),
    policy: z.enum(POLICY_NAMES),
    seed: z.number().int().nonnegative(),
    maxFrames: z.number().int().positive().default(600),
    /** Must match the sweep that found the failure, or the replay diverges. */
    stuckAfter: z.number().int().positive().default(180),
    avatar: z.string().optional(),
    target: targetSchema.optional(),
    objectives: z.array(ObjectiveSchema).default([]),
  }),
  async run(ctx, params) {
    if (!ctx.runtime?.bakeBotRun) {
      throw new ProjectError(
        'Scene runtime not available in this context (runtime hooks not injected).',
        'INVALID_INPUT',
      );
    }
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');
    // Fail before the (re-run) bake if the name is taken; persistPlaytest checks again.
    if (ctx.store.getPlaytest(params.name)) {
      throw new ProjectError(`A playtest named "${params.name}" already exists`, 'CONFLICT');
    }

    const { steps, seed } = await ctx.runtime.bakeBotRun(ctx.store, {
      scene: scene.id,
      policy: params.policy,
      seed: params.seed,
      maxFrames: params.maxFrames,
      stuckAfter: params.stuckAfter,
      avatar: params.avatar,
      target: params.target,
      objectives: params.objectives,
    });

    return persistPlaytest(ctx, {
      name: params.name,
      scene: scene.id,
      steps,
      maxFrames: params.maxFrames,
      seed,
    });
  },
});
