/**
 * @hearth/playtest — headless scene benchmark.
 *
 * Steps a scene headlessly (unmeasured warmup, then timed frames) and reports
 * a per-frame timing summary so an agent can ask "will this scene hold 60fps?"
 * without a browser. The heavy runtime work lives here; core's `benchScene`
 * command reaches it through the injected RuntimeHooks.benchScene hook, so core
 * never imports the runtime directly.
 *
 * Token-frugal by design: the result is a summary only — no per-frame array.
 */
import type { ProjectStore } from '@hearth/core';
import { GameSession } from '@hearth/runtime';

/** One frame's wall-clock budget at 60fps (16.666…ms). */
export const FRAME_BUDGET_60FPS_MS = 1000 / 60;

export interface BenchResult {
  /** Resolved scene id that was benchmarked. */
  scene: string;
  /** Scene name (human-facing). */
  sceneName: string;
  /** Number of measured frames (warmup excluded). */
  frames: number;
  /** Live entity count at the start of the run (after load, before warmup). */
  entityCount: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  /** Sum of the measured per-frame times. */
  totalMs: number;
  /** Frame budget the caller asked to check against, if any. */
  budgetMs?: number;
  /** medianMs <= budgetMs; only present when budgetMs was given. */
  withinBudget?: boolean;
  /** Count of runtime/script errors recorded during the run. */
  scriptErrors: number;
  /** Perf hints (e.g. a 60fps budget warning); empty when nothing to flag. */
  suggestions: string[];
}

export interface BenchOptions {
  frames: number;
  warmupFrames: number;
  budgetMs?: number;
}

/** Inputs to the pure summariser — everything a run produces, minus the timing loop. */
export interface BenchSummaryInput {
  scene: string;
  sceneName: string;
  entityCount: number;
  /** Measured per-frame times in ms (one entry per measured frame). */
  samples: number[];
  budgetMs?: number;
  scriptErrors: number;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Nearest-rank percentile over an already-sorted ascending array.
 * rank = ceil(p/100 * N), clamped to [1, N]; returns the value at that rank.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length, Math.max(1, rank)) - 1;
  return sortedAsc[idx];
}

/** Pure summariser: turns collected per-frame samples into a BenchResult. */
export function summarizeBench(input: BenchSummaryInput): BenchResult {
  const { samples } = input;
  const frames = samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, ms) => sum + ms, 0);
  const avg = frames > 0 ? total / frames : 0;
  const median = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = frames > 0 ? sorted[sorted.length - 1] : 0;

  const result: BenchResult = {
    scene: input.scene,
    sceneName: input.sceneName,
    frames,
    entityCount: input.entityCount,
    avgMs: round3(avg),
    medianMs: round3(median),
    p95Ms: round3(p95),
    maxMs: round3(max),
    totalMs: round3(total),
    scriptErrors: input.scriptErrors,
    suggestions: [],
  };

  if (input.budgetMs !== undefined) {
    result.budgetMs = input.budgetMs;
    result.withinBudget = median <= input.budgetMs;
  }

  if (median > FRAME_BUDGET_60FPS_MS) {
    result.suggestions.push(
      `medianMs ${round3(median)} exceeds the 16.67ms per-frame budget for 60fps; ` +
        `reduce entity count or per-frame script work to hold 60fps.`,
    );
  }

  return result;
}

/**
 * Build the scene headlessly, step `warmupFrames` unmeasured frames, then time
 * `frames` measured frames with performance.now() and summarise them.
 *
 * The scene is assumed to exist — core's `benchScene` command resolves it (and
 * throws NOT_FOUND if unknown) before reaching here; GameSession.create also
 * throws on an unknown scene, so a bad id never reaches the timing loop.
 */
export async function benchScene(
  store: ProjectStore,
  sceneIdOrName: string,
  opts: BenchOptions,
): Promise<BenchResult> {
  const session = await GameSession.create(store, { scene: sceneIdOrName });
  const sceneId = session.currentSceneId;
  const sceneName = store.getScene(sceneId)?.name ?? sceneId;
  const entityCount = session.runtime.getEntities().length;

  // Warmup: stepped but not timed, so JIT warmup and first-frame allocation
  // costs don't skew the measured window.
  for (let i = 0; i < opts.warmupFrames; i++) await session.stepAsync();

  const samples: number[] = [];
  for (let i = 0; i < opts.frames; i++) {
    const t0 = performance.now();
    await session.stepAsync();
    samples.push(performance.now() - t0);
  }

  const scriptErrors = session.errors.length;
  session.destroy();

  return summarizeBench({
    scene: sceneId,
    sceneName,
    entityCount,
    samples,
    budgetMs: opts.budgetMs,
    scriptErrors,
  });
}
