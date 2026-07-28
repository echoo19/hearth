/**
 * Which state each playtester is in, worked out from the sweep's own record.
 *
 * The one rule everything here follows: a sweep is SEQUENTIAL. `runSweep` walks
 * its runnable policies one at a time against one browser, and inside each one
 * it walks the seeds. So at most one bot is ever playing, and the one playing
 * is the earliest that has not finished all its seeds. That is not a heuristic,
 * it is the loop.
 *
 * Where it stops being certain is worth being precise about, because the app is
 * not allowed to put a confident label on a guess. Two things can make a policy
 * not run that this fold cannot see coming:
 *
 *   - the sweep needs a goal for a policy and was not given one
 *   - the prelude measured the controls and nothing it declared moved anything
 *
 * Both are decided after the plan is made and recorded only in the report at
 * the end. Until then such a policy looks like the earliest unfinished one, so
 * it would wear the "playing" label for as long as one run takes. A run that
 * has actually finished is proof the bot is the one on the browser, so
 * `certain` is exactly that: at least one of its runs is in. Panels that are
 * not certain say "playing" without claiming which seed.
 *
 * Pure, and free of policy names: the registry decides which bots exist and the
 * sweep decides what became of them.
 */
import type { Finding, PlaytestPolicy, PlaytestRun, PlaytestView } from '../../types';

export type PanelState =
  /** On the browser now. `runIndex` is 0-based and only meant when `certain`. */
  | { kind: 'playing'; runIndex: number; runCount: number; seed: number | null; certain: boolean }
  /** Its turn has not come. Nothing has happened to it yet. */
  | { kind: 'waiting' }
  /** It played. `runs` is what came back. */
  | { kind: 'played'; runs: PlaytestRun[] }
  /** It did not play, and this is why, in the sweep's own words. */
  | { kind: 'skipped'; reason: string; source: 'report' | 'plan' }
  /** The sweep moved past it without running it and has not yet said why. */
  | { kind: 'passed'; }
  /** This sweep never asked for it. */
  | { kind: 'unasked' };

export interface Panel {
  policy: string;
  state: PanelState;
  findings: Finding[];
}

/** Has this policy done every seed the sweep set out to give it? */
function complete(policy: PlaytestPolicy, runCount: number): boolean {
  return runCount > 0 && policy.runs.length >= runCount;
}

/**
 * One panel per playtester, in the order the sweep works through them.
 *
 * Registered bots the sweep did not ask for are appended rather than hidden:
 * an older sweep that only asked for two of them should not make the other two
 * look as if they stopped existing.
 */
export function playtestPanels(view: PlaytestView | null): Panel[] {
  if (view === null) return [];
  const sweep = view.sweep;
  if (sweep === null) {
    return view.known.map((policy) => ({ policy, state: { kind: 'unasked' } as PanelState, findings: [] }));
  }

  const runCount = sweep.seeds.length;
  const list = sweep.policies;
  // The earliest policy that could be the one on the browser: skips are known
  // for certain (the capability gate is asked the same question the sweep
  // asks), so anything before this either finished or was never going to run.
  // A later policy having runs is proof the sweep is past this one, whatever
  // the plan said. It is the only in-flight signal that a policy was dropped.
  const ranLater = list.map((_, index) => list.slice(index + 1).some((policy) => policy.runs.length > 0));
  // Dropped policies have to be excluded HERE, not merely overridden further
  // down. A bot the sweep silently passed over is still incomplete, so taking
  // the first incomplete one handed the live slot to a bot that will never
  // report, and the bot actually on the browser sat there reading "waiting".
  const liveIndex = view.running
    ? list.findIndex((policy, index) => policy.skipReason === null && !complete(policy, runCount) && !ranLater[index])
    : -1;

  const panels: Panel[] = list.map((policy, index) => {
    const state = ((): PanelState => {
      if (policy.skipReason !== null) {
        return { kind: 'skipped', reason: policy.skipReason, source: policy.skipSource ?? 'report' };
      }
      if (complete(policy, runCount) || (!view.running && policy.runs.length > 0)) {
        return { kind: 'played', runs: policy.runs };
      }
      if (!view.running || ranLater[index]) return { kind: 'passed' };
      if (index === liveIndex) {
        return {
          kind: 'playing',
          runIndex: policy.runs.length,
          runCount,
          seed: sweep.seeds[policy.runs.length] ?? null,
          certain: policy.runs.length > 0,
        };
      }
      return { kind: 'waiting' };
    })();
    return { policy: policy.policy, state, findings: policy.findings };
  });

  const asked = new Set(list.map((policy) => policy.policy));
  for (const policy of view.known) {
    if (!asked.has(policy)) panels.push({ policy, state: { kind: 'unasked' }, findings: [] });
  }
  return panels;
}

/** Which panel has the browser, or -1 when none does. */
export function livePanel(panels: readonly Panel[]): number {
  return panels.findIndex((panel) => panel.state.kind === 'playing');
}

/**
 * The line under the heading: what this sweep is, in one sentence. Says how
 * many bots were skipped rather than burying it, because that count is the
 * difference between "your game is fine" and "half of them never looked".
 */
export function playtestSummary(view: PlaytestView | null, panels: readonly Panel[]): string {
  if (view === null) return 'Hearth could not read this folder’s playtests.';
  if (view.sweep === null) {
    return view.running
      ? 'Starting a playtest. Each bot appears here as the sweep reaches it.'
      : 'No playtest has run in this folder yet.';
  }
  const played = panels.filter((panel) => panel.state.kind === 'played').length;
  const skipped = panels.filter((panel) => panel.state.kind === 'skipped').length;
  const runs = view.sweep.policies.reduce((total, policy) => total + policy.runs.length, 0);
  const parts: string[] = [];
  parts.push(`${runs} ${runs === 1 ? 'run' : 'runs'}`);
  parts.push(`${played} of ${panels.length} ${played === 1 ? 'bot played' : 'bots played'}`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return view.running ? `Playing now: ${parts.join(', ')} so far.` : `Last playtest: ${parts.join(', ')}.`;
}

/**
 * A one-line reminder of what a bot does. Decoration, and deliberately thin:
 * the registry owns these and says nothing about itself, so anything richer
 * would be this file inventing behaviour on their behalf. A bot not listed
 * here simply gets no line, which is how a new one arrives without a lie
 * attached to it.
 */
const BLURBS: Record<string, string> = {
  idle: 'Presses nothing, and watches what the game does on its own.',
  mash: 'Random input over the controls the game declares.',
  wander: 'Explores, heading for places it has not been.',
  seek: 'Heads for a goal.',
};

export function policyBlurb(policy: string): string | null {
  return BLURBS[policy] ?? null;
}
