/**
 * unresponsive-input — does holding a control actually do anything?
 *
 * The playtest version answered this by spinning up a fresh engine session per
 * input. probe-core has no such luxury: there is one live game, possibly a
 * browser tab, and it may not even support reset. So the probe is SEQUENTIAL and
 * IN-SESSION, run once before the policy takes over:
 *
 *   settle → for each control: settle, measure a no-input control window,
 *   settle again, hold the control for an equal window, and compare.
 *
 * The control window is the whole trick. A platformer avatar falls under gravity
 * with no input at all, a physics game drifts, an idle animation cycles — so
 * "did it move?" is only meaningful *relative to* what happens when nothing is
 * pressed. An input is unresponsive when its displacement, minus the control's,
 * is under the epsilon AND it produced no new events/scene/error tokens.
 *
 * The settles matter as much as the windows. Measuring while the game is still
 * mid-transient (an avatar falling from its spawn) compares two slices of the
 * same fall, and the difference between them says nothing about the button.
 *
 * The game is treated as noisy, so one disagreement is not evidence: a control
 * is only flagged when every repeat agrees it did nothing. Two repeats by
 * default. If every declared action is unresponsive the game is not playable at
 * all, and the finding becomes a blocker.
 *
 * Without entities there is no displacement to measure, so the probe falls back
 * to frame-hash movement and says so in the finding — pixel evidence is weaker,
 * and the report should never pretend otherwise.
 */
import type { Finding, GameUnderTest, ProbeCapabilities, ProbeEntity } from '../contract.js';
import { averageHash, hammingDistance } from '../imageHash.js';
import { decodePng } from '../png.js';
import { resolveEntityRef } from '../entities.js';

export interface InputProbeOptions {
  actions: readonly string[];
  axes: readonly string[];
  /** Entity ref for the avatar; displacement is measured on it. */
  avatarRef: string | null;
  /** Cap on the initial settle (stepping until the game stops moving on its own). */
  settleSteps?: number;
  /** Cap on the short settle before each measurement window. */
  pairSettleSteps?: number;
  /** Length of each control/hold window. */
  windowSteps?: number;
  /** How many times every control must agree before it is flagged. */
  repeats?: number;
  /** Displacement (world units, control-subtracted) below which nothing moved. */
  moveEpsilon?: number;
  /** Frame-hash bit distance below which the picture did not change. */
  hashDistance?: number;
}

export interface InputProbeResult {
  findings: Finding[];
  /** Controls that were unresponsive in every repeat. */
  unresponsive: string[];
  /** Steps the probe consumed. */
  steps: number;
  /** True when the game errored mid-probe; results are then inconclusive and dropped. */
  aborted: boolean;
}

const DEFAULTS = {
  settleSteps: 300,
  pairSettleSteps: 60,
  windowSteps: 24,
  repeats: 2,
  moveEpsilon: 2,
  hashDistance: 4,
};

/** Steps per settle probe. */
const SETTLE_CHUNK = 12;

/** Why the probe cannot run against this game, or null when it can. */
export function inputProbeUnavailable(capabilities: ProbeCapabilities): string | null {
  const { input, senses } = capabilities;
  if (input.actions.length === 0 && input.axes.length === 0) {
    return 'no actions or axes declared';
  }
  if (!senses.entities && !senses.screenshot) {
    return 'needs entity enumeration (displacement) or screenshots (pixel fallback)';
  }
  return null;
}

interface Control {
  label: string;
  down(game: GameUnderTest): Promise<void>;
  up(game: GameUnderTest): Promise<void>;
}

interface WindowResult {
  displacement: { dx: number; dy: number } | null;
  tokens: Set<string>;
  hash: string | null;
}

/** Run one measurement window, applying `hold` before every step. */
async function measure(
  game: GameUnderTest,
  steps: number,
  avatarRef: string | null,
  pixels: boolean,
): Promise<WindowResult | 'error'> {
  const start = await avatarPosition(game, avatarRef);
  const tokens = new Set<string>();
  let scene: string | null = null;
  for (let i = 0; i < steps; i++) {
    const obs = await game.step();
    if (obs.newErrors.length > 0) return 'error';
    for (const name of obs.newEvents) tokens.add(`evt:${name}`);
    if (obs.sceneId !== null) {
      if (scene === null) scene = obs.sceneId;
      else if (obs.sceneId !== scene) {
        tokens.add(`scene:${obs.sceneId}`);
        scene = obs.sceneId;
      }
    }
  }
  const end = await avatarPosition(game, avatarRef);
  const displacement = start && end ? { dx: end.x - start.x, dy: end.y - start.y } : null;
  let hash: string | null = null;
  if (pixels && game.screenshot) {
    hash = averageHash(decodePng(await game.screenshot()));
  }
  return { displacement, tokens, hash };
}

/**
 * Step until the game stops moving on its own, or the cap runs out.
 *
 * This is what makes an in-session probe trustworthy. Measuring while the
 * avatar is still falling from its spawn compares two windows taken at
 * different points of the same transient, and the difference between them says
 * nothing about the control being held. Settling first means both windows of a
 * pair start from the same steady state, so any difference IS the input.
 */
async function settle(
  game: GameUnderTest,
  ref: string | null,
  cap: number,
  moveEpsilon: number,
): Promise<number | 'error'> {
  let used = 0;
  let previous = await avatarPosition(game, ref);
  while (used + SETTLE_CHUNK <= cap) {
    for (let i = 0; i < SETTLE_CHUNK; i++) {
      const obs = await game.step();
      used++;
      if (obs.newErrors.length > 0) return 'error';
    }
    const now = await avatarPosition(game, ref);
    // Nothing to watch (no entity sense): one chunk is all the settling we can justify.
    if (!previous || !now) return used;
    if (Math.hypot(now.x - previous.x, now.y - previous.y) <= moveEpsilon) return used;
    previous = now;
  }
  return used;
}

async function avatarPosition(
  game: GameUnderTest,
  ref: string | null,
): Promise<{ x: number; y: number } | null> {
  if (ref === null) return null;
  let entity: ProbeEntity | null = null;
  if (game.findEntity) entity = await game.findEntity(ref);
  else if (game.listEntities) entity = resolveEntityRef(await game.listEntities(), ref);
  return entity ? { x: entity.x, y: entity.y } : null;
}

/**
 * Hold every declared control in turn and report the ones that never produced an
 * observable difference from doing nothing.
 */
export async function probeInputResponse(
  game: GameUnderTest,
  options: InputProbeOptions,
): Promise<InputProbeResult> {
  const cfg = { ...DEFAULTS, ...options };
  const controls: Control[] = [];
  for (const action of [...options.actions].sort()) {
    controls.push({
      label: action,
      down: (g) => g.setActionDown(action),
      up: (g) => g.setActionUp(action),
    });
  }
  for (const axis of [...options.axes].sort()) {
    for (const value of [1, -1] as const) {
      controls.push({
        label: `${axis}${value === 1 ? '+' : '-'}`,
        down: (g) => g.setAxis(axis, value),
        up: (g) => g.setAxis(axis, 0),
      });
    }
  }
  const pixels = options.avatarRef === null && game.screenshot !== undefined;
  const empty: InputProbeResult = { findings: [], unresponsive: [], steps: 0, aborted: false };
  if (controls.length === 0) return empty;

  let steps = 0;
  // Settle first: whatever the opening moments do (a title fade, a spawn
  // animation, a long fall) must not be attributed to the first control we press.
  const settled = await settle(game, options.avatarRef, cfg.settleSteps, cfg.moveEpsilon);
  if (settled === 'error') return { ...empty, steps: cfg.settleSteps, aborted: true };
  steps += settled;

  const responsiveRepeats = new Map<string, number>();
  for (const c of controls) responsiveRepeats.set(c.label, 0);
  // Tokens seen anywhere in the probe so far. A game that mints monotonic event
  // names ("score-7", "score-8") would otherwise make every window look like a
  // response, so novelty is counted against this shared history and the two
  // windows of a pair are judged against the same snapshot of it.
  const seen = new Set<string>();

  for (let repeat = 0; repeat < cfg.repeats; repeat++) {
    for (const control of controls) {
      const before = new Set(seen);
      const preControl = await settle(game, options.avatarRef, cfg.pairSettleSteps, cfg.moveEpsilon);
      if (preControl === 'error') return { ...empty, steps, aborted: true };
      steps += preControl;
      const baseline = await measure(game, cfg.windowSteps, options.avatarRef, pixels);
      steps += cfg.windowSteps;
      if (baseline === 'error') return { ...empty, steps, aborted: true };

      const preHold = await settle(game, options.avatarRef, cfg.pairSettleSteps, cfg.moveEpsilon);
      if (preHold === 'error') return { ...empty, steps, aborted: true };
      steps += preHold;
      await control.down(game);
      const held = await measure(game, cfg.windowSteps, options.avatarRef, pixels);
      await control.up(game);
      steps += cfg.windowSteps;
      if (held === 'error') return { ...empty, steps, aborted: true };
      for (const t of baseline.tokens) seen.add(t);
      for (const t of held.tokens) seen.add(t);

      if (responded(baseline, held, before, cfg.moveEpsilon, cfg.hashDistance)) {
        responsiveRepeats.set(control.label, (responsiveRepeats.get(control.label) ?? 0) + 1);
      }
    }
  }

  const unresponsive = controls.map((c) => c.label).filter((label) => responsiveRepeats.get(label) === 0);
  const allDead = unresponsive.length === controls.length;
  const basis = pixels
    ? 'pixel-based: no entity sense, so this compares frame hashes against a no-input control window'
    : 'compares avatar displacement and new events against a no-input control window';
  const findings: Finding[] = unresponsive.map((label) => ({
    kind: 'unresponsive-input',
    severity: allDead ? ('blocker' as const) : ('issue' as const),
    summary: `"${label}" produced no observable change in ${cfg.repeats} probes`,
    detail:
      `held "${label}" for ${cfg.windowSteps} steps, ${cfg.repeats} times, and nothing moved or fired ` +
      `beyond the no-input baseline — ${basis}. It may still respond in a later game state.`,
    evidence: { input: label, windowSteps: cfg.windowSteps, repeats: cfg.repeats, pixelBased: pixels },
  }));
  if (allDead && findings.length > 0) {
    findings.unshift({
      kind: 'unresponsive-input',
      severity: 'blocker',
      summary: `none of the ${controls.length} declared controls did anything`,
      detail: `every declared control was held and probed ${cfg.repeats} times with no observable response — ${basis}`,
      evidence: { controls: unresponsive },
    });
  }
  return { findings, unresponsive, steps, aborted: false };
}

function responded(
  baseline: WindowResult,
  held: WindowResult,
  seenBefore: ReadonlySet<string>,
  moveEpsilon: number,
  hashDistance: number,
): boolean {
  // Holding the control has to out-produce doing nothing, not merely produce
  // something — an ambient stream fires in both windows and proves nothing.
  const fresh = (w: WindowResult): number => {
    let n = 0;
    for (const token of w.tokens) if (!seenBefore.has(token)) n++;
    return n;
  };
  if (fresh(held) > fresh(baseline)) return true;
  if (held.displacement && baseline.displacement) {
    const dx = held.displacement.dx - baseline.displacement.dx;
    const dy = held.displacement.dy - baseline.displacement.dy;
    if (Math.hypot(dx, dy) > moveEpsilon) return true;
    return false;
  }
  if (held.hash && baseline.hash) {
    return hammingDistance(held.hash, baseline.hash) > hashDistance;
  }
  // Nothing measurable at all — never claim a control is dead on no evidence.
  return true;
}
