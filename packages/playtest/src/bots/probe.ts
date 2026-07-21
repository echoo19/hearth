/**
 * Movement probe — derive an avatar's control scheme from short trial runs.
 *
 * The steering policies (wander, seek) work on any game because they do not
 * assume "right means +x". Instead, before the real run, we probe: for each
 * digital action and each axis at ±1 we spin up a fresh throwaway session on
 * the same scene (seed 0), hold that one input for 30 frames, and measure how
 * far the avatar drifted. Inputs that move it more than 2px form the movement
 * basis; steering later picks the basis entry best aligned with the direction
 * it wants to go.
 *
 * Every probe is its own session with a fixed seed, so probing never touches
 * the main run's rng stream and the basis is fully deterministic. Probes are
 * pure measurement: no input is recorded into any timeline.
 */
import type { ProjectStore } from '@hearth/core';
import { GameSession } from '@hearth/runtime';
import { resolveAvatar } from './avatar.js';

/** Displacement threshold (px) an input must exceed over the probe window to count. */
const MIN_DISPLACEMENT = 2;
/** Frames each probe holds its input before measuring net displacement. */
const PROBE_FRAMES = 30;
/** Fixed seed for all probe sessions — probes must never depend on the run seed. */
const PROBE_SEED = 0;

/**
 * One basis input and the net world displacement holding it produced. The input
 * descriptor is deliberately narrower than InputEvent (no frame, actions have no
 * `down`, axes carry the ±1 that was held) — it names a reusable control, not a
 * recorded event.
 */
export interface MovementBasisEntry {
  input: { kind: 'action'; action: string } | { kind: 'axis'; axis: string; value: 1 | -1 };
  /** Net world-x displacement over the probe window (px). */
  dx: number;
  /** Net world-y displacement over the probe window (px). */
  dy: number;
}

/** The set of inputs that measurably move the avatar, in a stable probe order. */
export interface MovementBasis {
  entries: MovementBasisEntry[];
}

/** Measure the avatar's net world displacement after holding one input PROBE_FRAMES frames. */
async function measure(
  store: ProjectStore,
  scene: string,
  avatar: string,
  apply: (session: GameSession) => void,
): Promise<{ dx: number; dy: number } | null> {
  const session = await GameSession.create(store, { scene, seed: PROBE_SEED });
  try {
    const avatarId = await resolveAvatar(store, session, avatar);
    if (avatarId === null) return null;
    const startEntity = session.runtime.find(avatarId);
    if (!startEntity) return null;
    const start = session.runtime.getWorldPosition(startEntity);
    for (let i = 0; i < PROBE_FRAMES; i++) {
      // Re-assert every frame: input state is sticky, but re-applying keeps the
      // hold alive across any scene bookkeeping and mirrors how a policy holds.
      apply(session);
      await session.stepAsync();
      if (session.errors.length > 0) return null;
    }
    const endEntity = session.runtime.find(avatarId);
    if (!endEntity) return null;
    const end = session.runtime.getWorldPosition(endEntity);
    return { dx: end.x - start.x, dy: end.y - start.y };
  } finally {
    session.destroy();
  }
}

/**
 * Probe every digital action and every axis at ±1 against `scene`, returning the
 * inputs that move `avatar` more than 2px. Iteration is over sorted action/axis
 * names for determinism. Throws when nothing moves the avatar, naming everything
 * probed so the caller can see the control scheme was genuinely inert.
 */
export async function probeMovement(
  store: ProjectStore,
  scene: string,
  avatar: string,
): Promise<MovementBasis> {
  const mappings = store.project.inputMappings;
  const actions = Object.keys(mappings.actions).sort();
  const axes = Object.keys(mappings.axes).sort();

  const entries: MovementBasisEntry[] = [];
  const probed: string[] = [];

  for (const action of actions) {
    probed.push(action);
    const moved = await measure(store, scene, avatar, (s) => s.runtime.input.setActionDown(action));
    if (moved && Math.hypot(moved.dx, moved.dy) > MIN_DISPLACEMENT) {
      entries.push({ input: { kind: 'action', action }, dx: moved.dx, dy: moved.dy });
    }
  }

  for (const axis of axes) {
    for (const value of [1, -1] as const) {
      probed.push(`${axis}${value === 1 ? '+' : '-'}`);
      const moved = await measure(store, scene, avatar, (s) => s.runtime.input.setAxis(axis, value));
      if (moved && Math.hypot(moved.dx, moved.dy) > MIN_DISPLACEMENT) {
        entries.push({ input: { kind: 'axis', axis, value }, dx: moved.dx, dy: moved.dy });
      }
    }
  }

  if (entries.length === 0) {
    const list = probed.length > 0 ? probed.join(', ') : '(no actions or axes mapped)';
    throw new Error(
      `no movement basis for avatar "${avatar}" in scene "${scene}": ` +
        `none of the probed inputs moved it more than ${MIN_DISPLACEMENT}px (probed: ${list})`,
    );
  }

  return { entries };
}
