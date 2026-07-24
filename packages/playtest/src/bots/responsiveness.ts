/**
 * Unresponsive-input detection — does holding a control actually do anything?
 *
 * For each declared action (and each axis at ±1) we hold that one input for a
 * short window from the scene's opening state and collect an *observable
 * signature*: did the avatar move, what sounds played, which camera effects and
 * post effects fired, which events emitted. We do the same with NO input as a
 * control. An input whose signature adds nothing over the control produced no
 * observable effect from that state and is flagged; an input that throws is a
 * blocker.
 *
 * This is deliberately a `note`, not a hard failure: an input might only do
 * something in a game state the opening frame isn't in (a dash that needs a
 * pickup first). The wording says "from the opening state" so it never overclaims.
 *
 * Deterministic: every probe is its own session at a fixed seed (like probe.ts),
 * so measurement never perturbs a real run's rng.
 */
import type { ProjectStore } from '@hearth/core';
import { GameSession } from '@hearth/runtime';
import { resolveAvatarInfo } from './avatar.js';
import type { Finding } from './types.js';

/** Frames each responsiveness probe holds its input. */
const PROBE_FRAMES = 24;
/** Fixed seed for all probes — must not depend on the run seed. */
const PROBE_SEED = 0;
/** Avatar displacement (px) over the window that counts as "moved". */
const MOVE_EPSILON = 2;

type ApplyInput = (session: GameSession) => void;

/** What a probe observed: non-movement signals, plus the avatar's net displacement. */
interface ProbeSignature {
  tokens: Set<string>;
  /** Net avatar displacement over the window, or null when there's no avatar to track. */
  disp: { dx: number; dy: number } | null;
}

/**
 * One probe: hold `apply` for the window and return what changed. Displacement is
 * returned as a vector (not a flag) so it can be compared against the no-input
 * control — a platformer avatar falls under gravity with no input, so "moved" is
 * only meaningful *relative to* that baseline.
 */
async function probe(
  store: ProjectStore,
  scene: string,
  avatarId: string | null,
  apply: ApplyInput,
): Promise<ProbeSignature | 'CRASH'> {
  const session = await GameSession.create(store, { scene, seed: PROBE_SEED });
  try {
    const startPos = avatarPos(session, avatarId);
    for (let i = 0; i < PROBE_FRAMES; i++) {
      apply(session);
      await session.stepAsync();
      if (session.errors.length > 0) return 'CRASH';
    }
    const tokens = new Set<string>();
    const endPos = avatarPos(session, avatarId);
    const disp = startPos && endPos ? { dx: endPos.x - startPos.x, dy: endPos.y - startPos.y } : null;
    for (const e of session.audioEvents) tokens.add(`audio:${e.assetId}`);
    for (const c of session.cameraEffects) tokens.add(`cam:${c.effect}`);
    for (const name of session.eventCounts.keys()) tokens.add(`evt:${name}`);
    for (const p of session.runtime.camera.postEffects) tokens.add(`fx:${p.type}`);
    return { tokens, disp };
  } finally {
    session.destroy();
  }
}

function avatarPos(session: GameSession, avatarId: string | null): { x: number; y: number } | null {
  if (avatarId === null) return null;
  const entity = session.runtime.find(avatarId);
  return entity ? session.runtime.getWorldPosition(entity) : null;
}

/** Whether an input's avatar displacement differs from the control's by more than the epsilon. */
function movedDifferently(
  a: { dx: number; dy: number } | null,
  control: { dx: number; dy: number } | null,
): boolean {
  if (!a) return false; // no avatar to measure — movement can't be a signal
  const base = control ?? { dx: 0, dy: 0 };
  return Math.hypot(a.dx - base.dx, a.dy - base.dy) > MOVE_EPSILON;
}

/**
 * Probe every declared action and axis for an observable response, relative to a
 * no-input control. Returns unresponsive-input notes and crash-on-input blockers.
 */
export async function probeResponsiveness(
  store: ProjectStore,
  scene: string,
  opts: { avatar?: string; skip?: Set<string> },
): Promise<Finding[]> {
  const skip = opts.skip ?? new Set<string>();
  // Inputs no script references are already reported as dead-controls; probing
  // them here would double-flag the same problem, so skip them.
  const actions = Object.keys(store.project.inputMappings.actions).filter((a) => !skip.has(a)).sort();
  const axes = Object.keys(store.project.inputMappings.axes).filter((a) => !skip.has(a)).sort();
  if (actions.length + axes.length === 0) return [];

  // Resolve the avatar once for movement measurement (best effort; null is fine).
  let avatarId: string | null = null;
  try {
    const session = await GameSession.create(store, { scene, seed: PROBE_SEED });
    avatarId = (await resolveAvatarInfo(store, session, opts.avatar)).id;
    session.destroy();
  } catch {
    avatarId = null;
  }

  const control = await probe(store, scene, avatarId, () => {});
  const controlTokens = control === 'CRASH' ? new Set<string>() : control.tokens;
  const controlDisp = control === 'CRASH' ? null : control.disp;

  const findings: Finding[] = [];
  const check = async (label: string, kind: 'action' | 'axis', apply: ApplyInput): Promise<void> => {
    const result = await probe(store, scene, avatarId, apply);
    if (result === 'CRASH') {
      findings.push({
        kind: 'crash-on-input',
        severity: 'blocker',
        summary: `${kind} "${label}" crashes the game`,
        detail: `holding "${label}" from the opening state threw within ${PROBE_FRAMES} frames`,
        evidence: { input: label, control: kind },
      });
      return;
    }
    // New non-movement signal, OR a displacement that meaningfully differs from
    // the no-input control (so gravity-drift alone never reads as responsive).
    const added = [...result.tokens].filter((t) => !controlTokens.has(t));
    const moved = movedDifferently(result.disp, controlDisp);
    if (added.length === 0 && !moved) {
      findings.push({
        kind: 'unresponsive-input',
        severity: 'note',
        summary: `${kind} "${label}" produced no observable change from the opening state`,
        detail: `held "${label}" for ${PROBE_FRAMES} frames and nothing moved, played, or fired beyond the no-input baseline — it may only respond in a later game state`,
        evidence: { input: label, control: kind },
      });
    }
  };

  for (const action of actions) {
    await check(action, 'action', (s) => s.runtime.input.setActionDown(action));
  }
  for (const axis of axes) {
    for (const value of [1, -1] as const) {
      await check(`${axis}${value === 1 ? '+' : '-'}`, 'axis', (s) => s.runtime.input.setAxis(axis, value));
    }
  }
  return findings;
}
