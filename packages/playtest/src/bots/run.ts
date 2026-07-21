/**
 * runBotRun — the bot executor.
 *
 * Models bench.ts: a bare `GameSession.create` + per-frame `stepAsync` loop.
 * Each frame the policy reads live state and injects input through the
 * InputRecorder (which logs the timeline), then we step, then sample novelty,
 * objectives, and errors. The loop resolves `session.runtime` fresh every frame
 * because a scene switch replaces it.
 *
 * Determinism: the only randomness is the injected `createRng(seed)` stream the
 * policy draws from. No wall clock, no Math.random, no map-iteration-dependent
 * behavior (action/axis lists are sorted before the policy sees them).
 */
import type { ProjectStore } from '@hearth/core';
import { GameSession, createRng, type RuntimeEntity, type SceneRuntime } from '@hearth/runtime';
import { resolveAvatar } from './avatar.js';
import {
  evaluateObjectives,
  makeLiveObjectives,
  toOutcomes,
  type LiveObjective,
} from './objectives.js';
import { createPolicy } from './policies.js';
import { probeMovement, type MovementBasis } from './probe.js';
import { InputRecorder } from './recorder.js';
import type { BotObservation, BotRunConfig, BotRunResult, BotVerdict } from './types.js';

/** Policies that steer an avatar and therefore need a probed movement basis. */
const STEERING_POLICIES = new Set(['wander', 'seek']);

/** World-grid cell size (px) for novelty/coverage tracking. */
const CELL_SIZE = 32;
/** Cap on script-bearing entities tracked for novelty when no avatar is known. */
const NO_AVATAR_ENTITY_CAP = 16;

function cellKey(x: number, y: number): string {
  return `${Math.floor(x / CELL_SIZE)},${Math.floor(y / CELL_SIZE)}`;
}

/** Cells occupied by the avatar, or by up to 16 script-bearing entities when there is none. */
function collectCells(runtime: SceneRuntime, avatarId: string | null, into: Set<string>): void {
  if (avatarId !== null) {
    const avatar = runtime.find(avatarId);
    if (avatar) {
      const p = runtime.getWorldPosition(avatar);
      into.add(cellKey(p.x, p.y));
    }
    return;
  }
  let count = 0;
  for (const entity of runtime.getEntities()) {
    if (!entity.components.Script?.scriptPath) continue;
    const p = runtime.getWorldPosition(entity);
    into.add(cellKey(p.x, p.y));
    if (++count >= NO_AVATAR_ENTITY_CAP) break;
  }
}

/** Sum of exact per-name event totals — the novelty signal for "something happened". */
function eventTotal(session: GameSession): number {
  let total = 0;
  for (const n of session.eventCounts.values()) total += n;
  return total;
}

/**
 * Play one (policy, seed) run to completion and report it. The scene is assumed
 * to exist — GameSession.create throws on an unknown scene before the loop.
 */
export async function runBotRun(store: ProjectStore, config: BotRunConfig): Promise<BotRunResult> {
  const session = await GameSession.create(store, { scene: config.scene, seed: config.seed });

  const avatarId = await resolveAvatar(store, session, config.avatar);
  const rng = createRng(config.seed);
  const recorder = new InputRecorder(session);

  const mappings = store.project.inputMappings;
  const actions = Object.keys(mappings.actions).sort();
  const axes = Object.keys(mappings.axes).sort();
  const { width, height } = store.project.buildSettings;

  // Steering policies need the avatar's control scheme. Probe it once, lazily,
  // before frame 0, in throwaway seed-0 sessions that never touch this run's
  // rng. A null avatar is left for the policy's init to reject with a clear
  // error, so the "no avatar" message is consistent across policies.
  let basis: MovementBasis | undefined;
  if (STEERING_POLICIES.has(config.policy) && avatarId !== null) {
    basis = await probeMovement(store, config.scene, avatarId);
  }

  const policy = createPolicy(config.policy);
  policy.init({
    session,
    store,
    rng,
    config,
    avatar: avatarId,
    actions,
    axes,
    viewport: { width, height },
    ...(basis ? { basis } : {}),
  });

  const live: LiveObjective[] = makeLiveObjectives(config.objectives);
  const visited = new Set<string>();
  // Seed the starting cell(s) so the initial position never counts as novelty.
  collectCells(session.runtime, avatarId, visited);

  let framesSinceNovelty = 0;
  let stuckAtFrame: number | null = null;
  let prevEventTotal = eventTotal(session);
  let prevSceneId = session.currentSceneId;
  let firstError: { message: string; frame: number } | undefined;

  for (let i = 0; i < config.maxFrames; i++) {
    const frame = session.frame;
    recorder.setFrame(frame);
    const runtime = session.runtime;
    const avatar: RuntimeEntity | null = avatarId ? (runtime.find(avatarId) ?? null) : null;
    const obs: BotObservation = { frame, session, runtime, avatar, input: recorder };
    policy.onFrame(obs);

    await session.stepAsync();

    // Error has top precedence: capture the first one and stop.
    if (session.errors.length > 0) {
      const err = session.errors[0];
      firstError = { message: err.message, frame: err.frame };
      break;
    }

    const postRuntime = session.runtime;
    const postFrame = session.frame;

    // Objectives, evaluated on post-step state.
    evaluateObjectives(live, {
      runtime: postRuntime,
      session,
      avatarId,
      frame: postFrame,
    });

    // Novelty: a new visited cell, a new event, or a scene switch.
    const before = visited.size;
    collectCells(postRuntime, avatarId, visited);
    let novel = visited.size > before;
    const nowEventTotal = eventTotal(session);
    if (nowEventTotal > prevEventTotal) novel = true;
    prevEventTotal = nowEventTotal;
    if (session.currentSceneId !== prevSceneId) {
      novel = true;
      prevSceneId = session.currentSceneId;
    }

    if (novel) framesSinceNovelty = 0;
    else framesSinceNovelty++;
    if (stuckAtFrame === null && framesSinceNovelty >= config.stuckAfter) {
      stuckAtFrame = postFrame;
    }

    // Terminal conditions (verdict decided by precedence at the end).
    const anyFailed = live.some((o) => o.failed);
    const allAchieved = live.length > 0 && live.every((o) => o.achievedAtFrame !== null);
    if (stuckAtFrame !== null || anyFailed || allAchieved) break;
  }

  const endFrame = session.frame;
  session.destroy();

  const objectives = toOutcomes(live);
  const verdict = decideVerdict({
    hasError: firstError !== undefined,
    stuck: stuckAtFrame !== null,
    objectives,
  });

  const visitedCells = [...visited].sort();
  return {
    policy: config.policy,
    seed: config.seed,
    verdict,
    endFrame,
    ...(firstError ? { firstError } : {}),
    ...(stuckAtFrame !== null ? { stuckAtFrame } : {}),
    objectives,
    cellsVisited: visitedCells.length,
    visitedCells,
    timeline: recorder.events,
  };
}

/** Verdict precedence: error > stuck > (completed | objective-failed) > ran-clean. */
function decideVerdict(input: {
  hasError: boolean;
  stuck: boolean;
  objectives: { achievedAtFrame: number | null; failed: boolean }[];
}): BotVerdict {
  if (input.hasError) return 'error';
  if (input.stuck) return 'stuck';
  if (input.objectives.length > 0) {
    return input.objectives.every((o) => o.achievedAtFrame !== null) ? 'completed' : 'objective-failed';
  }
  return 'ran-clean';
}
