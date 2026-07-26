/**
 * runSweep — play a game many ways and write down what happened.
 *
 * The shape is policies x seeds, run SEQUENTIALLY against ONE live game. That
 * is not a limitation to route around: the thing under test may be a browser
 * tab, an engine process, a device. Between runs the sweep resets when the game
 * offers a reset and otherwise stops and starts it.
 *
 * Two beliefs are wired into this loop:
 *
 * 1. The game is NOT deterministic. The same policy and seed can produce a
 *    different trace twice, so a single run proves nothing and the report is a
 *    DISTRIBUTION — a verdict tally across many runs. Only the bot is
 *    deterministic (seeded rng), which is what makes a failure reproducible.
 *
 * 2. Absent senses are stated, never assumed. Every policy and detector the
 *    game cannot support ends up in `skipped` with a reason naming the missing
 *    capability, so "no findings" can never quietly mean "nothing was checked".
 *
 * Everything the sweep learns goes through the EvidenceStore: per-run files, a
 * report, screenshots, and a journal line per milestone. The returned report is
 * the same object written to disk.
 */
import type {
  Finding,
  GameUnderTest,
  Objective,
  ProbeEntity,
  ProbeError,
  ProbeInstant,
  RunResult,
  SkippedDetector,
  StepObservation,
  SweepReport,
} from './contract.js';
import type { EvidenceStore } from './evidence.js';
import { appendEvidence } from './evidenceStore.js';
import { probeMovement, resolveAvatarRef } from './avatar.js';
import { CoverageTracker } from './coverage.js';
import {
  buildDetectors,
  inputProbeUnavailable,
  probeInputResponse,
  DEFAULT_DETECTOR_CONFIG,
  type DetectorConfig,
  type ProbeSample,
} from './detectors/index.js';
import { resolveEntityRef } from './entities.js';
import { collectFailures, decideVerdict, foldFindings, foldSkipped, tallyVerdicts } from './fold.js';
import { InputQueue, type InputMutation } from './input.js';
import { evaluateObjectives, makeLiveObjectives, toOutcomes } from './objectives.js';
import { createPolicy, policyUnavailable, STEERING_POLICIES, type Point } from './policies/index.js';
import { decodePng, type RgbaImage } from './png.js';
import { createRng } from './rng.js';
import type { MovementBasis } from './steer.js';

/** Default steps per run: long enough for two stuck windows plus a prelude. */
export const DEFAULT_MAX_STEPS = 1050;
/** Default novelty drought before a run is called stuck. */
export const DEFAULT_STUCK_AFTER = 180;
/** Default steps between screenshot samples, when screenshots exist. */
export const DEFAULT_SCREENSHOT_EVERY = 30;
/**
 * Sampling rate when pixels are the ONLY progress sense. With entities, a
 * screenshot is supporting evidence and 30 steps is plenty; without them, every
 * unsampled step is a step the probe is blind for, and a stuck window would
 * come down to a handful of frames.
 */
export const PIXEL_ONLY_SCREENSHOT_EVERY = 10;
/** Hard ceiling on policies x seeds x maxSteps, checked before anything runs. */
export const DEFAULT_BUDGET = 400_000;
/** Screenshots persisted per run (the rest are analyzed in memory and dropped). */
const SHOTS_PER_RUN = 4;

export interface SweepOptions {
  /** Policy names to run (unavailable ones are skipped, not silently dropped). */
  policies: string[];
  /** Seeds to run each policy with. */
  seeds: number[];
  /** Where every artifact goes. */
  evidence: EvidenceStore;
  /** What is being swept: a project dir, URL, or connector label. */
  target?: string;
  maxSteps?: number;
  stuckAfter?: number;
  objectives?: Objective[];
  screenshotEvery?: number;
  /** World-unit coverage cell size. */
  cellSize?: number;
  /** Frame-hash bit distance below which a frame is not new. */
  hashDistance?: number;
  /** Explicit avatar ref; otherwise resolved by tag, then by probing. */
  avatar?: string;
  /** seek's goal. */
  seekTarget?: string | Point;
  /** Run the unresponsive-input probe before the first run (default true). */
  inputProbe?: boolean;
  /** Ceiling on policies x seeds x maxSteps. */
  budget?: number;
  /** Detector threshold overrides. */
  detectors?: Partial<DetectorConfig>;
}

export async function runSweep(game: GameUnderTest, opts: SweepOptions): Promise<SweepReport> {
  const startedAt = Date.now();
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const stuckAfter = opts.stuckAfter ?? DEFAULT_STUCK_AFTER;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const target = opts.target ?? 'game';
  if (opts.policies.length === 0) throw new Error('runSweep: no policies given');
  if (opts.seeds.length === 0) throw new Error('runSweep: no seeds given');
  if (maxSteps <= 0) throw new Error('runSweep: maxSteps must be positive');
  const cost = opts.policies.length * opts.seeds.length * maxSteps;
  if (cost > budget) {
    throw new Error(
      `runSweep: budget exceeded — ${opts.policies.length} policies x ${opts.seeds.length} seeds x ` +
        `${maxSteps} steps = ${cost} steps, over the ${budget} cap. Cut seeds or maxSteps.`,
    );
  }

  const capabilities = game.capabilities;
  const config: DetectorConfig = {
    ...DEFAULT_DETECTOR_CONFIG,
    stuckAfter,
    ...(opts.cellSize !== undefined ? { cellSize: opts.cellSize } : {}),
    ...(opts.hashDistance !== undefined ? { hashDistance: opts.hashDistance } : {}),
    screenshotEvery: capabilities.senses.screenshot
      ? (opts.screenshotEvery ??
        (capabilities.senses.entities ? DEFAULT_SCREENSHOT_EVERY : PIXEL_ONLY_SCREENSHOT_EVERY))
      : 0,
    ...opts.detectors,
  };

  const { sweepId, dir } = await opts.evidence.beginSweep(target, opts.policies, opts.seeds);
  await appendEvidence(opts.evidence, {
    kind: 'sweep-started',
    sweepId,
    target,
    policies: opts.policies,
    seeds: opts.seeds,
  });

  const skipped: SkippedDetector[] = [];
  const preludeFindings: Finding[] = [];
  const runnable: string[] = [];
  for (const name of opts.policies) {
    const reason =
      name === 'seek' && opts.seekTarget === undefined
        ? 'seek needs a target (seekTarget): an entity ref, "x,y", or a point'
        : policyUnavailable(name, capabilities);
    if (reason === null) runnable.push(name);
    else skipped.push({ kind: `policy:${name}`, reason });
  }

  const actions = [...capabilities.input.actions].sort();
  const axes = [...capabilities.input.axes].sort();

  await game.start();
  const runs: RunResult[] = [];
  try {
    // --- prelude: who is the avatar, what moves it, and do the controls work?
    let avatarRef: string | null = null;
    let basis: MovementBasis | null = null;
    if (capabilities.senses.entities) {
      avatarRef = (await resolveAvatarRef(game, opts.avatar)).ref;
    } else {
      skipped.push({
        kind: 'avatar-resolution',
        reason: 'no entity enumeration: the probe cannot tell which thing is the player',
      });
    }
    const needsBasis = runnable.some((p) => STEERING_POLICIES.has(p));
    if (capabilities.senses.entities && (needsBasis || avatarRef === null)) {
      const probe = await probeMovement(game, { actions, axes, avatarRef, minDisplacement: config.moveEpsilon });
      if (!probe.aborted) {
        avatarRef = avatarRef ?? probe.ref;
        basis = probe.basis;
      }
      await resetGame(game);
    }
    if (needsBasis && (basis === null || basis.entries.length === 0)) {
      for (let i = runnable.length - 1; i >= 0; i--) {
        if (!STEERING_POLICIES.has(runnable[i])) continue;
        skipped.push({
          kind: `policy:${runnable[i]}`,
          reason: 'no declared input measurably moved any entity, so there is nothing to steer with',
        });
        runnable.splice(i, 1);
      }
    }

    const probeReason = inputProbeUnavailable(capabilities);
    if (opts.inputProbe === false) {
      skipped.push({ kind: 'unresponsive-input', reason: 'disabled by the caller' });
    } else if (probeReason !== null) {
      skipped.push({ kind: 'unresponsive-input', reason: probeReason });
    } else {
      const probe = await probeInputResponse(game, {
        actions,
        axes,
        avatarRef,
        moveEpsilon: config.moveEpsilon,
        hashDistance: config.hashDistance,
      });
      if (probe.aborted) {
        skipped.push({
          kind: 'unresponsive-input',
          reason: 'the game errored during the input probe, so the result would be inconclusive',
        });
      } else {
        preludeFindings.push(...probe.findings);
      }
      await resetGame(game);
    }

    // --- the sweep proper
    for (const policy of runnable) {
      for (const seed of opts.seeds) {
        await resetGame(game);
        const run = await runOne(game, {
          policy,
          seed,
          maxSteps,
          config,
          avatarRef,
          basis,
          objectives: opts.objectives ?? [],
          seekTarget: opts.seekTarget,
          evidence: opts.evidence,
          sweepId,
        });
        runs.push(run);
        await opts.evidence.writeRun(sweepId, run);
        await appendEvidence(opts.evidence, {
          kind: 'run-finished',
          sweepId,
          policy: run.policy,
          seed: run.seed,
          verdict: run.verdict,
          frames: run.frames,
        });
      }
    }
  } finally {
    await game.stop();
  }

  const findings = foldFindings([...preludeFindings, ...runs.flatMap((r) => r.findings)]);
  const report: SweepReport = {
    target,
    policies: runnable,
    seeds: opts.seeds,
    runs: runs.length,
    verdicts: tallyVerdicts(runs),
    findings,
    skipped: foldSkipped([...skipped, ...runs.flatMap((r) => r.skipped)]),
    failures: collectFailures(runs, stuckAfter),
    framesSimulated: runs.reduce((sum, r) => sum + r.frames, 0),
    wallMs: Date.now() - startedAt,
    evidenceDir: dir,
  };
  const reportPath = await opts.evidence.finishSweep(sweepId, report);
  await appendEvidence(opts.evidence, {
    kind: 'sweep-finished',
    sweepId,
    verdicts: report.verdicts,
    findings: report.findings,
    reportPath,
  });
  return report;
}

interface RunOptions {
  policy: string;
  seed: number;
  maxSteps: number;
  config: DetectorConfig;
  avatarRef: string | null;
  basis: MovementBasis | null;
  objectives: Objective[];
  seekTarget?: string | Point;
  evidence: EvidenceStore;
  sweepId: string;
}

/** Play one (policy, seed) run to completion and report it. */
export async function runOne(game: GameUnderTest, opts: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const capabilities = game.capabilities;
  const { config } = opts;
  const navGrid = capabilities.senses.nav && game.navGrid ? await game.navGrid() : null;
  let entities = await listEntities(game);
  let avatar = pickAvatar(entities, opts.avatarRef);
  const spawn = avatar ? { x: avatar.x, y: avatar.y } : null;

  const policy = createPolicy(opts.policy);
  policy.init({
    capabilities,
    rng: createRng(opts.seed),
    seed: opts.seed,
    actions: [...capabilities.input.actions].sort(),
    axes: [...capabilities.input.axes].sort(),
    viewport: capabilities.viewport,
    avatarRef: opts.avatarRef,
    basis: opts.basis,
    navGrid,
    ...(opts.seekTarget !== undefined ? { target: opts.seekTarget } : {}),
    cellSize: config.cellSize,
  });

  const { detectors, skipped } = buildDetectors({
    capabilities,
    config,
    policy: opts.policy,
    navGrid,
    spawn,
  });
  const coverage = new CoverageTracker({ cellSize: config.cellSize, hashDistance: config.hashDistance });
  const live = makeLiveObjectives(opts.objectives);
  const eventCounts = new Map<string, number>();
  const input = new InputQueue();
  const shots: string[] = [];

  // Screenshot bookkeeping: sample often (cheap, in memory), persist rarely.
  const sampleCount = config.screenshotEvery > 0 ? Math.floor(opts.maxSteps / config.screenshotEvery) : 0;
  const shotStride = sampleCount > SHOTS_PER_RUN ? Math.floor(sampleCount / SHOTS_PER_RUN) : 1;
  let sampleIndex = 0;
  let lastPng: Uint8Array | null = null;

  // Seed coverage from the opening state so the starting position is not "progress".
  const opening = await capture(game, config.screenshotEvery > 0);
  if (opening) lastPng = opening.png;
  coverage.observe({
    entities,
    avatar,
    image: opening?.image ?? null,
    sceneId: null,
    newEvents: [],
  });

  let obs: StepObservation = { frame: 0, newErrors: [], sceneId: null, newEvents: [] };
  let firstError: ProbeError | undefined;
  let stuck = false;
  let framesSinceNovelty = 0;
  let frames = 0;

  for (let i = 0; i < opts.maxSteps; i++) {
    const instant: ProbeInstant = { frame: i, ...(obs.ms !== undefined ? { ms: obs.ms } : {}) };
    input.setFrame(i);
    policy.step({ instant, obs, entities, avatar, navGrid, input });
    for (const mutation of input.drain()) await applyInput(game, mutation);

    obs = await game.step();
    frames = i + 1;
    const now: ProbeInstant = { frame: frames, ...(obs.ms !== undefined ? { ms: obs.ms } : {}) };
    for (const name of obs.newEvents) eventCounts.set(name, (eventCounts.get(name) ?? 0) + 1);

    entities = await listEntities(game);
    avatar = pickAvatar(entities, opts.avatarRef);

    let image: RgbaImage | null = null;
    let shot: string | undefined;
    if (config.screenshotEvery > 0 && frames % config.screenshotEvery === 0) {
      const frame = await capture(game, true);
      if (frame) {
        image = frame.image;
        lastPng = frame.png;
        if (sampleIndex % shotStride === 0) {
          shot = await opts.evidence.writeShot(
            opts.sweepId,
            `${opts.policy}-${opts.seed}-${String(frames).padStart(5, '0')}`,
            frame.png,
          );
          shots.push(shot);
        }
        sampleIndex++;
      }
    }

    const novel = coverage.observe({
      entities,
      avatar,
      image,
      sceneId: obs.sceneId,
      newEvents: obs.newEvents,
    });
    framesSinceNovelty = novel ? 0 : framesSinceNovelty + 1;

    const sample: ProbeSample = {
      instant: now,
      obs,
      entities,
      avatar,
      image,
      ...(shot ? { shot } : {}),
      intent: policy.intent(),
      novel,
      framesSinceNovelty,
    };
    for (const detector of detectors) detector.observe(sample);

    evaluateObjectives(live, {
      entities,
      avatarId: opts.avatarRef,
      eventCounts,
      instant: now,
    });

    let stop = false;
    for (const detector of detectors) {
      const verdict = detector.verdict();
      if (verdict === 'error') {
        firstError = obs.newErrors[0] ?? firstError;
        stop = true;
      } else if (verdict === 'stuck') {
        stuck = true;
        stop = true;
      }
    }
    if (stop) break;

    const anyFailed = live.some((o) => o.failed);
    const allAchieved = live.length > 0 && live.every((o) => o.achievedAt !== null);
    if (anyFailed || allAchieved) break;
  }

  // Release everything the policy left held, so the next run starts clean even
  // when the game has no reset.
  await releaseAll(game);

  const objectives = toOutcomes(live);
  const findings = detectors.flatMap((d) => d.finish());
  const verdict = decideVerdict({ hasError: firstError !== undefined, stuck, objectives });

  if (lastPng && (verdict === 'error' || verdict === 'stuck' || verdict === 'objective-failed')) {
    shots.push(await opts.evidence.writeShot(opts.sweepId, `${opts.policy}-${opts.seed}-final`, lastPng));
  }

  return {
    policy: opts.policy,
    seed: opts.seed,
    verdict,
    frames,
    wallMs: Date.now() - startedAt,
    findings,
    skipped,
    objectives,
    ...(firstError ? { firstError } : {}),
    coverageKeys: [...coverage.keys].sort(),
    shots,
  };
}

async function listEntities(game: GameUnderTest): Promise<ProbeEntity[] | null> {
  if (!game.capabilities.senses.entities || !game.listEntities) return null;
  return await game.listEntities();
}

function pickAvatar(entities: readonly ProbeEntity[] | null, ref: string | null): ProbeEntity | null {
  if (!entities || ref === null) return null;
  return resolveEntityRef(entities, ref);
}

async function capture(
  game: GameUnderTest,
  wanted: boolean,
): Promise<{ png: Uint8Array; image: RgbaImage } | null> {
  if (!wanted || !game.capabilities.senses.screenshot || !game.screenshot) return null;
  try {
    const png = await game.screenshot();
    return { png, image: decodePng(png) };
  } catch {
    // A screenshot that fails to arrive or decode is a missing sample, not a
    // finding — the adapter owns that failure and reports it its own way.
    return null;
  }
}

async function applyInput(game: GameUnderTest, mutation: InputMutation): Promise<void> {
  if (mutation.kind === 'action') {
    if (mutation.down) await game.setActionDown(mutation.action);
    else await game.setActionUp(mutation.action);
  } else if (mutation.kind === 'axis') {
    await game.setAxis(mutation.axis, mutation.value);
  } else {
    await game.sendPointer(mutation.x, mutation.y, mutation.pointer);
  }
}

async function releaseAll(game: GameUnderTest): Promise<void> {
  for (const action of game.capabilities.input.actions) await game.setActionUp(action);
  for (const axis of game.capabilities.input.axes) await game.setAxis(axis, 0);
}

/** Bring the game back to a playable starting state between runs. */
export async function resetGame(game: GameUnderTest): Promise<void> {
  await releaseAll(game);
  if (game.capabilities.senses.reset && game.reset) {
    await game.reset();
    return;
  }
  await game.stop();
  await game.start();
}
