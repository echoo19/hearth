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
import { resolveAvatarInfo } from './avatar.js';
import {
  evaluateObjectives,
  makeLiveObjectives,
  toOutcomes,
  type LiveObjective,
} from './objectives.js';
import { createPolicy } from './policies.js';
import { probeMovement, type MovementBasis } from './probe.js';
import { FADE_OPAQUE_ALPHA, isWallBump, nonSupportingContact } from './frustration.js';
import { InputRecorder } from './recorder.js';
import type { BotObservation, BotRunConfig, BotRunResult, BotVerdict, Finding } from './types.js';

/** Policies that steer an avatar and therefore need a probed movement basis. */
const STEERING_POLICIES = new Set(['wander', 'seek']);
/**
 * Policies that inject no input. A run that never touches the controls cannot be
 * "stuck" in any meaningful sense — nothing was tried — so it is exempt from the
 * stuck verdict and judged on errors and objectives alone. (idle's real job is to
 * catch games that break when the player does nothing.)
 */
const NO_INPUT_POLICIES = new Set(['idle']);

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
 * Tracks *interaction* novelty: the first time the game produces a distinct
 * observable response (a new sound, a new kind of camera effect, a new UI focus
 * target, a newly-active post effect). First-occurrence only — a looping ambient
 * track or a flash that fires every frame registers once and never again, so
 * repetition can't mask a genuine stall. This is what makes a menu legible: the
 * first time mash hits a button and something happens, the run is not "stuck".
 */
class InteractionNovelty {
  private readonly audio = new Set<string>();
  private readonly cameraKinds = new Set<string>();
  private readonly focus = new Set<string>();
  private readonly postEffects = new Set<string>();
  /** Distinct observable states of the avatar itself (its text / sprite frame). */
  private readonly avatarState = new Set<string>();

  /**
   * Seed from the current state so signals already present at frame 0 don't count.
   * `avatarId` scopes text/sprite tracking to the avatar so a HUD counter ticking
   * every frame (not the avatar) can't manufacture endless novelty.
   */
  constructor(
    session: GameSession,
    runtime: SceneRuntime,
    private readonly avatarId: string | null,
  ) {
    this.scan(session, runtime);
  }

  /** Fold current state in; return true if any distinct signal appeared this call. */
  observe(session: GameSession, runtime: SceneRuntime): boolean {
    return this.scan(session, runtime);
  }

  private scan(session: GameSession, runtime: SceneRuntime): boolean {
    let novel = false;
    for (const e of session.audioEvents) if (add(this.audio, e.assetId)) novel = true;
    for (const c of session.cameraEffects) if (add(this.cameraKinds, c.effect)) novel = true;
    const focused = runtime.getUiFocused();
    if (focused !== null && add(this.focus, focused)) novel = true;
    for (const p of runtime.camera.postEffects) if (add(this.postEffects, p.type)) novel = true;
    // The avatar's own visible state changing — a dialogue line advancing, a
    // sprite swapping — is player-caused progress. Scoped to the avatar so
    // ambient HUD text does not count.
    if (this.avatarId !== null) {
      const avatar = runtime.find(this.avatarId);
      if (avatar) {
        const text = avatar.components.Text?.content;
        if (typeof text === 'string' && add(this.avatarState, `t:${text}`)) novel = true;
        const sprite = avatar.components.SpriteRenderer;
        if (sprite) {
          const key = `s:${sprite.assetId ?? ''}#${sprite.frame ?? ''}`;
          if (add(this.avatarState, key)) novel = true;
        }
      }
    }
    return novel;
  }
}

/** Set.add that reports whether the value was new. */
function add(set: Set<string>, value: string): boolean {
  if (set.has(value)) return false;
  set.add(value);
  return true;
}

/** A short human label for a seek target (entity ref or world point). */
function describeTarget(target: string | { x: number; y: number } | undefined): string {
  if (target === undefined) return 'its target';
  if (typeof target === 'string') return `"${target}"`;
  return `(${Math.round(target.x)}, ${Math.round(target.y)})`;
}

/**
 * Play one (policy, seed) run to completion and report it. The scene is assumed
 * to exist — GameSession.create throws on an unknown scene before the loop.
 */
export async function runBotRun(store: ProjectStore, config: BotRunConfig): Promise<BotRunResult> {
  const session = await GameSession.create(store, { scene: config.scene, seed: config.seed });

  const findings: Finding[] = [];
  const steering = STEERING_POLICIES.has(config.policy);
  const avatarInfo = await resolveAvatarInfo(store, session, config.avatar);
  if (steering && avatarInfo.ambiguous) {
    // Steering must drive one definite entity; an ambiguous set is a hard error.
    session.destroy();
    throw new Error(
      `avatar is ambiguous: ${avatarInfo.candidates.length} input-reading entities ` +
        `(${avatarInfo.candidates.join(', ')}); pass an explicit avatar`,
    );
  }
  const avatarId = avatarInfo.id;
  if (!steering && avatarInfo.ambiguous) {
    // mash/idle tolerate this: track novelty across script-bearing entities and
    // note the ambiguity so the reader can pass --avatar for sharper coverage.
    findings.push({
      kind: 'ambiguous-avatar',
      severity: 'note',
      summary:
        `several input-reading entities (${avatarInfo.candidates.join(', ')}); ` +
        `pass --avatar to steer or track one`,
      evidence: { candidates: avatarInfo.candidates },
    });
  }
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
  // Seed interaction novelty from the opening frame's state (title music, an
  // initial fade) so those don't read as a fresh response mid-run.
  const interaction = new InteractionNovelty(session, session.runtime, avatarId);

  // idle injects no input, so a stall means nothing was tried — never "stuck".
  const stuckEligible = !NO_INPUT_POLICIES.has(config.policy);
  let framesSinceNovelty = 0;
  let stuckAtFrame: number | null = null;
  let prevEventTotal = eventTotal(session);
  let prevSceneId = session.currentSceneId;
  let firstError: { message: string; frame: number } | undefined;
  // Frustration tracking: wall contact accrued within the current novelty-less
  // window, and the fade overlay level when the run first went stuck.
  let stallWallFrames = 0;
  let overlayAtStuck = 0;

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

    // Novelty is tiered. PROGRESS novelty — a new visited cell, a new event, or
    // a scene switch — is the primary signal (this is what caught the broken-jump
    // regression). INTERACTION novelty — a first-heard sound, a first-of-its-kind
    // camera effect, a new UI focus, a newly-active post effect — is secondary and
    // first-occurrence-only, which lets a menu register a response without an
    // ambient loop masking a real stall.
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
    if (interaction.observe(session, postRuntime)) novel = true;

    // Wall-bump: accrue non-supporting avatar contact only while stalled, so a
    // graze during normal play doesn't count. Resets whenever progress resumes.
    const postAvatar = avatarId ? (postRuntime.find(avatarId) ?? null) : null;
    if (novel) {
      framesSinceNovelty = 0;
      stallWallFrames = 0;
    } else {
      framesSinceNovelty++;
      if (postAvatar && nonSupportingContact(postAvatar)) stallWallFrames++;
    }
    if (stuckEligible && stuckAtFrame === null && framesSinceNovelty >= config.stuckAfter) {
      stuckAtFrame = postFrame;
      overlayAtStuck = postRuntime.cameraEffects.overlay.alpha;
    }

    // Terminal conditions (verdict decided by precedence at the end).
    const anyFailed = live.some((o) => o.failed);
    const allAchieved = live.length > 0 && live.every((o) => o.achievedAtFrame !== null);
    if (stuckAtFrame !== null || anyFailed || allAchieved) break;
  }

  const endFrame = session.frame;
  // Snapshot input reads before teardown — the dead-control detector unions these.
  const readInputs = [...session.readInputs].sort();
  session.destroy();

  const objectives = toOutcomes(live);
  const verdict = decideVerdict({
    hasError: firstError !== undefined,
    stuck: stuckAtFrame !== null,
    objectives,
  });

  // A stuck run behind an opaque fade is a softlock hidden by a black screen —
  // the fade-in never resolved. Say so instead of "no novelty".
  if (stuckAtFrame !== null && overlayAtStuck >= FADE_OPAQUE_ALPHA) {
    findings.push({
      kind: 'fade-softlock',
      severity: 'issue',
      summary: `stuck behind a full-screen fade (overlay ${overlayAtStuck.toFixed(2)}) since frame ${stuckAtFrame}`,
      detail: `the screen faded and never lifted — a fade-in or transition likely never completed`,
      frame: stuckAtFrame,
    });
  }

  // A stall spent mostly shoving the avatar into a wall is a frustration signal,
  // distinct from a generic stuck (the player is trying, the geometry won't give).
  if (stuckAtFrame !== null && isWallBump(stallWallFrames, config.stuckAfter)) {
    findings.push({
      kind: 'wall-bump',
      severity: 'note',
      summary: `the avatar spent most of the stall pressed against a wall`,
      detail: `${stallWallFrames} of the last ${config.stuckAfter} frames were wall contact — an unintended barrier or a spot the bot can't get past`,
      frame: stuckAtFrame,
    });
  }

  // A seek that stalled short of its target is the platformer trap: a nav route
  // may exist through the air, but the walking bot can't follow it. Replace the
  // generic "no novelty" story with seek-specific guidance.
  if (config.policy === 'seek' && stuckAtFrame !== null) {
    const where = describeTarget(config.target);
    findings.push({
      kind: 'seek-unreachable',
      severity: 'issue',
      summary: `seek stalled before reaching ${where}`,
      detail:
        `the target may need a jump or a route the walking bot can't follow — ` +
        `try the wander policy, or declare a reach objective to assert it directly`,
      frame: stuckAtFrame,
    });
  }

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
    findings,
    readInputs,
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
