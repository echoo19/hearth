/**
 * runSweep — plays every (policy, seed) combination against a scene and folds
 * the runs into a token-frugal report: verdict tally, per-objective success
 * stats, coverage vs the nav grid, and up to five most-severe failures each
 * carrying a copy-paste repro + bake CLI line. Full per-run detail is written
 * to `.hearth/sweeps/<scene>-<NNNN>.json` (sequential ids, deterministic).
 *
 * Wall time is measured with performance.now() at the sweep boundary only
 * (like bench). Everything else is deterministic: runBotRun draws only from its
 * seeded rng, and the report aggregation is pure over the run results.
 *
 * Coverage note: SceneRuntime.getNavGrid is still private, so reachable cells
 * are recomputed here by replicating the runtime's nav inputs against a fresh
 * session and running collectNavSolids/buildNavGrid from @hearth/core.
 */
import {
  buildNavGrid,
  collectNavSolids,
  joinPath,
  slugify,
  type NavEntityInput,
  type NavGrid,
  type ProjectStore,
  type SweepParams,
} from '@hearth/core';
import { GameSession } from '@hearth/runtime';
import { objectiveSummary } from './objectives.js';
import { runBotRun } from './run.js';
import type { BotRunConfig, BotRunResult, BotVerdict } from './types.js';

/** World-grid cell size (px) — matches runBotRun's novelty grid. */
const CELL_SIZE = 32;
/** Hard cap on failures surfaced in the summary (rest live in the report file). */
const MAX_FAILURES = 5;
/** Verdicts that count as a failure, most severe first. */
const FAILURE_SEVERITY: Record<string, number> = { error: 0, stuck: 1, 'objective-failed': 2 };
/** Don't render a heatmap wider/taller than this (keeps token cost bounded). */
const HEATMAP_MAX_SPAN = 120;
/** Directory (project-relative) sweep report files are written to. */
const SWEEPS_DIR = '.hearth/sweeps';

export interface SweepObjectiveStat {
  summary: string;
  successRate: number;
  medianCompletedFrame: number | null;
  worstSeed: number;
}

export interface SweepCoverage {
  cellsVisited: number;
  cellsReachable: number;
  pct: number;
}

export interface SweepFailure {
  policy: string;
  seed: number;
  verdict: BotVerdict;
  frame: number;
  detail: string;
  repro: string;
  bake: string;
}

export interface SweepReport {
  scene: string;
  runs: number;
  framesSimulated: number;
  wallMs: number;
  verdicts: Record<BotVerdict, number>;
  objectives: SweepObjectiveStat[];
  coverage?: SweepCoverage;
  failures: SweepFailure[];
  heatmap?: string;
  reportFile: string;
}

export async function runSweep(store: ProjectStore, params: SweepParams): Promise<SweepReport> {
  const t0 = performance.now();

  const results: BotRunResult[] = [];
  for (const policy of params.policies) {
    for (let i = 0; i < params.seeds; i++) {
      const seed = params.seedStart + i;
      const config: BotRunConfig = {
        scene: params.scene,
        policy,
        seed,
        maxFrames: params.maxFrames,
        stuckAfter: params.stuckAfter,
        avatar: params.avatar,
        target: params.target,
        objectives: params.objectives,
      };
      results.push(await runBotRun(store, config));
    }
  }

  const wallMs = Math.round(performance.now() - t0);
  const sceneObj = store.getScene(params.scene);
  const label = slugify(sceneObj?.name ?? params.scene);

  // Verdict tally — every verdict key present (zeros included) for a stable shape.
  const verdicts: Record<BotVerdict, number> = {
    'ran-clean': 0,
    stuck: 0,
    error: 0,
    completed: 0,
    'objective-failed': 0,
  };
  let framesSimulated = 0;
  for (const r of results) {
    verdicts[r.verdict]++;
    framesSimulated += r.endFrame;
  }

  const objectives = aggregateObjectives(params, results);
  const failures = collectFailures(params, results, label);

  // Coverage + heatmap from the nav grid (omitted when there is no nav grid).
  const nav = await computeNav(store, params.scene, params.seedStart);
  let coverage: SweepCoverage | undefined;
  let heatmap: string | undefined;
  if (nav) {
    const visitedUnion = new Set<string>();
    for (const r of results) for (const c of r.visitedCells) visitedUnion.add(c);
    const cellsReachable = nav.reachable.size;
    const cellsVisited = visitedUnion.size;
    const pct = cellsReachable > 0 ? Math.min(1, round2(cellsVisited / cellsReachable)) : 0;
    coverage = { cellsVisited, cellsReachable, pct };
    if (params.heatmap) heatmap = renderHeatmap(nav.reachable, visitedUnion);
  }

  const reportFile = await writeReport(store, label, params, results);

  return {
    scene: label,
    runs: results.length,
    framesSimulated,
    wallMs,
    verdicts,
    objectives,
    ...(coverage ? { coverage } : {}),
    failures,
    ...(heatmap !== undefined ? { heatmap } : {}),
    reportFile,
  };
}

/** Per-declared-objective success rate, median completion frame, and worst seed. */
function aggregateObjectives(params: SweepParams, results: BotRunResult[]): SweepObjectiveStat[] {
  return params.objectives.map((objective, index) => {
    const outcomes = results.map((r) => ({
      seed: r.seed,
      outcome: r.objectives[index],
    }));
    const achievedFrames: number[] = [];
    let successes = 0;
    for (const { outcome } of outcomes) {
      if (outcome && outcome.achievedAtFrame !== null) {
        successes++;
        achievedFrames.push(outcome.achievedAtFrame);
      }
    }
    const successRate = results.length > 0 ? round2(successes / results.length) : 0;

    // Worst seed: prefer a definitively-failed run, then an unachieved one,
    // then the slowest achieved; ties broken by seed asc for determinism.
    const ranked = [...outcomes].sort((a, b) => {
      const ra = badness(a.outcome);
      const rb = badness(b.outcome);
      if (ra !== rb) return rb - ra;
      const fa = a.outcome?.achievedAtFrame ?? Infinity;
      const fb = b.outcome?.achievedAtFrame ?? Infinity;
      if (fa !== fb) return fb - fa;
      return a.seed - b.seed;
    });
    const worstSeed = ranked.length > 0 ? ranked[0].seed : params.seedStart;

    return {
      summary: objectiveSummary(objective),
      successRate,
      medianCompletedFrame: median(achievedFrames),
      worstSeed,
    };
  });
}

/** Higher is worse: failed > unachieved > achieved. */
function badness(outcome: { achievedAtFrame: number | null; failed: boolean } | undefined): number {
  if (!outcome) return 1;
  if (outcome.failed) return 2;
  return outcome.achievedAtFrame === null ? 1 : 0;
}

/** The most severe failing runs (cap 5), each with repro + bake CLI strings. */
function collectFailures(params: SweepParams, results: BotRunResult[], label: string): SweepFailure[] {
  const failing = results.filter((r) => r.verdict in FAILURE_SEVERITY);
  failing.sort((a, b) => {
    const sa = FAILURE_SEVERITY[a.verdict];
    const sb = FAILURE_SEVERITY[b.verdict];
    if (sa !== sb) return sa - sb;
    if (a.seed !== b.seed) return a.seed - b.seed;
    return a.policy.localeCompare(b.policy);
  });
  return failing.slice(0, MAX_FAILURES).map((r) => {
    const flags = reproFlags(params, r.policy, r.seed);
    return {
      policy: r.policy,
      seed: r.seed,
      verdict: r.verdict,
      frame: failureFrame(r),
      detail: failureDetail(r, params),
      repro: `hearth sweep ${label} ${flags}`,
      bake: `hearth sweep ${label} ${flags} --bake ${r.policy}-seed-${r.seed}`,
    };
  });
}

function failureFrame(r: BotRunResult): number {
  if (r.verdict === 'error') return r.firstError?.frame ?? r.endFrame;
  if (r.verdict === 'stuck') return r.stuckAtFrame ?? r.endFrame;
  return r.endFrame;
}

function failureDetail(r: BotRunResult, params: SweepParams): string {
  if (r.verdict === 'error') return r.firstError?.message ?? 'runtime error';
  if (r.verdict === 'stuck') return `no novelty for ${params.stuckAfter} frames`;
  // objective-failed: name the objectives that did not hold.
  const unmet = r.objectives
    .filter((o) => o.failed || o.achievedAtFrame === null)
    .map((o) => o.summary);
  return unmet.length > 0 ? `unmet: ${unmet.join('; ')}` : 'objectives unmet at cap';
}

/** CLI flags that reproduce a single (policy, seed) run of this sweep. */
function reproFlags(params: SweepParams, policy: string, seed: number): string {
  const flags = [`--policies ${policy}`, `--seeds 1`, `--seed-start ${seed}`];
  if (params.maxFrames !== 600) flags.push(`--max-frames ${params.maxFrames}`);
  if (params.stuckAfter !== 180) flags.push(`--stuck-after ${params.stuckAfter}`);
  if (params.avatar) flags.push(`--avatar ${params.avatar}`);
  if (params.target !== undefined) flags.push(`--target ${targetString(params.target)}`);
  for (const o of params.objectives) flags.push(`--objective '${JSON.stringify(o)}'`);
  return flags.join(' ');
}

function targetString(target: string | { x: number; y: number }): string {
  return typeof target === 'string' ? target : `${target.x},${target.y}`;
}

/**
 * Reachable 32px cells, recomputed from a fresh session's nav inputs (see the
 * coverage note atop this file). Returns null when the scene has no solids —
 * there is no meaningful reachability map to compare visited cells against.
 */
async function computeNav(
  store: ProjectStore,
  sceneId: string,
  seed: number,
): Promise<{ reachable: Set<string> } | null> {
  const session = await GameSession.create(store, { scene: sceneId, seed });
  const inputs: NavEntityInput[] = [];
  for (const entity of session.runtime.getEntities()) {
    if (!entity.enabled) continue;
    inputs.push({
      position: session.runtime.getWorldPosition(entity),
      transform: entity.transform,
      collider: entity.components.Collider,
      tilemap: entity.components.Tilemap,
      bodyType: entity.components.PhysicsBody?.bodyType ?? 'static',
    });
  }
  session.destroy();

  const { cellSize, solids } = collectNavSolids(inputs);
  if (solids.length === 0) return null;
  let grid: NavGrid;
  try {
    grid = buildNavGrid({ cellSize, solids });
  } catch {
    return null; // grid over the 512x512 cap — no coverage block
  }

  const reachable = new Set<string>();
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (grid.solid[row * grid.cols + col]) continue;
      const cx = grid.originX + (col + 0.5) * grid.cellSize;
      const cy = grid.originY + (row + 0.5) * grid.cellSize;
      reachable.add(`${Math.floor(cx / CELL_SIZE)},${Math.floor(cy / CELL_SIZE)}`);
    }
  }
  return { reachable };
}

/** ASCII coverage grid over the reachable∪visited 32px bounds: `#` visited, `.` reachable, ` ` neither. */
function renderHeatmap(reachable: Set<string>, visited: Set<string>): string {
  const all = new Set<string>([...reachable, ...visited]);
  if (all.size === 0) return '';
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const key of all) {
    const comma = key.indexOf(',');
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;
  if (cols > HEATMAP_MAX_SPAN || rows > HEATMAP_MAX_SPAN) {
    return `coverage grid too large to render (${cols}x${rows} cells)`;
  }
  const lines: string[] = [];
  for (let y = minY; y <= maxY; y++) {
    let line = '';
    for (let x = minX; x <= maxX; x++) {
      const key = `${x},${y}`;
      line += visited.has(key) ? '#' : reachable.has(key) ? '.' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Write full per-run detail to `.hearth/sweeps/<label>-<NNNN>.json` and return the project-relative path. */
async function writeReport(
  store: ProjectStore,
  label: string,
  params: SweepParams,
  results: BotRunResult[],
): Promise<string> {
  const seq = await nextSequence(store, label);
  const relPath = `${SWEEPS_DIR}/${label}-${seq}.json`;
  const doc = {
    scene: label,
    sceneId: params.scene,
    params: {
      policies: params.policies,
      seeds: params.seeds,
      seedStart: params.seedStart,
      maxFrames: params.maxFrames,
      stuckAfter: params.stuckAfter,
      heatmap: params.heatmap,
      ...(params.avatar ? { avatar: params.avatar } : {}),
      ...(params.target !== undefined ? { target: params.target } : {}),
      objectives: params.objectives,
    },
    runs: results.map((r) => ({
      policy: r.policy,
      seed: r.seed,
      verdict: r.verdict,
      endFrame: r.endFrame,
      ...(r.firstError ? { firstError: r.firstError } : {}),
      ...(r.stuckAtFrame !== undefined ? { stuckAtFrame: r.stuckAtFrame } : {}),
      objectives: r.objectives,
      cellsVisited: r.cellsVisited,
      visitedCells: r.visitedCells,
    })),
  };
  await store.fs.mkdir(joinPath(store.root, SWEEPS_DIR));
  await store.fs.writeFile(joinPath(store.root, relPath), JSON.stringify(doc, null, 2));
  return relPath;
}

/** Next 4-digit sequence for `<label>-NNNN.json`, scanning the sweeps dir. */
async function nextSequence(store: ProjectStore, label: string): Promise<string> {
  const dir = joinPath(store.root, SWEEPS_DIR);
  let max = 0;
  if (await store.fs.exists(dir)) {
    const prefix = `${label}-`;
    const suffix = '.json';
    for (const file of await store.fs.readdir(dir)) {
      if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
      const mid = file.slice(prefix.length, file.length - suffix.length);
      if (/^\d{4}$/.test(mid)) max = Math.max(max, Number(mid));
    }
  }
  return String(max + 1).padStart(4, '0');
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
