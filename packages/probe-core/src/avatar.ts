/**
 * Which thing is the player, and what moves it.
 *
 * @hearth/playtest answered this by reading scripts for `ctx.input`. The probe
 * cannot read anyone's source — it is engine-agnostic and the game may be a
 * compiled bundle in a browser tab. So the resolution order is behavioural:
 *
 *   1. an explicit ref the caller passed (id, name, or tag),
 *   2. an entity tagged "player" — the one convention worth honoring when a
 *      game happens to offer it, never required,
 *   3. the largest mover: hold each declared control in turn and watch which
 *      entity responds most. Whatever the player's inputs push around IS the
 *      player, by definition, and no naming convention is needed.
 *
 * Step 3 is a SEQUENTIAL IN-SESSION probe. There are no throwaway sessions here
 * (the game may not support reset at all, and resets cost real time in a
 * browser), so it runs against the live game and its cost is counted in steps.
 * The same pass yields the movement basis the steering policies need: for each
 * control, the avatar's net displacement minus a no-input control window, so
 * gravity and idle drift never masquerade as steering power.
 */
import type { GameUnderTest, ProbeEntity } from './contract.js';
import { resolveEntityRef } from './entities.js';
import type { MovementBasis, MovementBasisEntry } from './steer.js';

export interface AvatarProbeOptions {
  actions: readonly string[];
  axes: readonly string[];
  /** Steps to hold each control (and the control window). */
  holdSteps?: number;
  /** Displacement below which a control is not part of the movement basis. */
  minDisplacement?: number;
  /** Known avatar; when set, the probe only measures the basis. */
  avatarRef?: string | null;
}

export interface AvatarResolution {
  /** The avatar's entity id, or null when nothing could be identified. */
  ref: string | null;
  how: 'explicit' | 'tag' | 'largest-mover' | 'none';
  /** Measured control scheme, when a probe ran. */
  basis: MovementBasis | null;
  /** Steps the probe consumed (0 when none was needed). */
  steps: number;
  /** True when the game errored mid-probe; the basis is then unusable. */
  aborted: boolean;
}

const DEFAULTS = { holdSteps: 30, minDisplacement: 2 };

type Positions = Map<string, { x: number; y: number }>;

async function snapshot(game: GameUnderTest): Promise<Positions> {
  const out: Positions = new Map();
  if (!game.listEntities) return out;
  for (const e of await game.listEntities()) {
    if (e.alive) out.set(e.id, { x: e.x, y: e.y });
  }
  return out;
}

function delta(before: Positions, after: Positions): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  for (const [id, start] of before) {
    const end = after.get(id);
    if (!end) continue;
    out.set(id, { dx: end.x - start.x, dy: end.y - start.y });
  }
  return out;
}

interface Control {
  entry: MovementBasisEntry['input'];
  down(game: GameUnderTest): Promise<void>;
  up(game: GameUnderTest): Promise<void>;
}

function controlsOf(actions: readonly string[], axes: readonly string[]): Control[] {
  const out: Control[] = [];
  for (const action of [...actions].sort()) {
    out.push({
      entry: { kind: 'action', action },
      down: (g) => g.setActionDown(action),
      up: (g) => g.setActionUp(action),
    });
  }
  for (const axis of [...axes].sort()) {
    for (const value of [1, -1] as const) {
      out.push({
        entry: { kind: 'axis', axis, value },
        down: (g) => g.setAxis(axis, value),
        up: (g) => g.setAxis(axis, 0),
      });
    }
  }
  return out;
}

/** Step `n` times, reporting whether the game threw. */
async function advance(game: GameUnderTest, n: number): Promise<boolean> {
  for (let i = 0; i < n; i++) {
    const obs = await game.step();
    if (obs.newErrors.length > 0) return false;
  }
  return true;
}

/**
 * Hold each declared control in turn against the live game and report who moved
 * and how. Requires entity enumeration; without it there is no displacement to
 * measure and the caller must fall back to a declared avatar or none at all.
 */
export async function probeMovement(
  game: GameUnderTest,
  options: AvatarProbeOptions,
): Promise<AvatarResolution> {
  const holdSteps = options.holdSteps ?? DEFAULTS.holdSteps;
  const minDisplacement = options.minDisplacement ?? DEFAULTS.minDisplacement;
  const controls = controlsOf(options.actions, options.axes);
  const none: AvatarResolution = { ref: null, how: 'none', basis: null, steps: 0, aborted: false };
  if (!game.listEntities || controls.length === 0) return none;

  let steps = 0;
  // Control window first: gravity, idle animations, and autonomous movers all
  // show up here, and every later measurement subtracts them out.
  const controlBefore = await snapshot(game);
  if (!(await advance(game, holdSteps))) return { ...none, steps: holdSteps, aborted: true };
  steps += holdSteps;
  const drift = delta(controlBefore, await snapshot(game));

  const measured: { control: Control; per: Map<string, { dx: number; dy: number }> }[] = [];
  for (const control of controls) {
    const before = await snapshot(game);
    await control.down(game);
    const ok = await advance(game, holdSteps);
    await control.up(game);
    steps += holdSteps;
    if (!ok) return { ...none, steps, aborted: true };
    const raw = delta(before, await snapshot(game));
    const per = new Map<string, { dx: number; dy: number }>();
    for (const [id, d] of raw) {
      const base = drift.get(id) ?? { dx: 0, dy: 0 };
      per.set(id, { dx: d.dx - base.dx, dy: d.dy - base.dy });
    }
    measured.push({ control, per });
  }

  // The avatar is whatever the controls move most, unless the caller named one.
  let ref = options.avatarRef ?? null;
  let how: AvatarResolution['how'] = ref ? 'explicit' : 'largest-mover';
  if (ref === null) {
    const totals = new Map<string, number>();
    for (const { per } of measured) {
      for (const [id, d] of per) {
        totals.set(id, (totals.get(id) ?? 0) + Math.hypot(d.dx, d.dy));
      }
    }
    let bestTotal = minDisplacement;
    // Sorted iteration so ties resolve identically on every run.
    for (const id of [...totals.keys()].sort()) {
      const total = totals.get(id) as number;
      if (total > bestTotal) {
        bestTotal = total;
        ref = id;
      }
    }
    if (ref === null) how = 'none';
  }

  const entries: MovementBasisEntry[] = [];
  if (ref !== null) {
    for (const { control, per } of measured) {
      const d = per.get(ref);
      if (!d || Math.hypot(d.dx, d.dy) <= minDisplacement) continue;
      entries.push({ input: control.entry, dx: d.dx, dy: d.dy });
    }
  }
  return { ref, how, basis: { entries }, steps, aborted: false };
}

/**
 * Resolve the avatar without moving anything: explicit ref, then a "player"
 * tag. Returns null when neither applies — the caller decides whether to spend
 * steps on {@link probeMovement}.
 */
export async function resolveAvatarRef(
  game: GameUnderTest,
  explicit?: string,
): Promise<{ ref: string | null; how: 'explicit' | 'tag' | 'none' }> {
  if (!game.listEntities) return { ref: null, how: 'none' };
  const entities: ProbeEntity[] = await game.listEntities();
  if (explicit !== undefined) {
    const direct = game.findEntity ? await game.findEntity(explicit) : resolveEntityRef(entities, explicit);
    if (direct) return { ref: direct.id, how: 'explicit' };
    throw new Error(`avatar "${explicit}" not found among ${entities.length} entities`);
  }
  const tagged = entities.filter((e) => e.tags?.includes('player'));
  if (tagged.length > 0) return { ref: tagged[0].id, how: 'tag' };
  return { ref: null, how: 'none' };
}
