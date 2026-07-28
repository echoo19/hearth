/**
 * Every claim the history makes, decided here rather than in the component.
 *
 * These are statements about someone's game, so each one should be checkable
 * without a DOM: what the verdict means in words, whether a session reversed the
 * one before it, which observations count as evidence, and how a session ended.
 *
 * Two rules here are the third sycophancy defence from the design:
 *
 *  - The previous verdict travels with every row, so a tester changing its mind
 *    is legible to the reader even when the tester never mentions it.
 *  - The regression answer is rendered every single time. "Nothing got worse"
 *    and "it never said" are different sentences and must never collapse into
 *    the same silence.
 */
import { MISSING_REGRESSION } from '../../../server/tester/prompt';
import type { TesterNote } from '../../../server/tester/types';

/** What the history says to a folder whose tester has never played. */
export const TESTER_NEVER_PLAYED = 'Your tester has not played this game yet.';

/** How a verdict reads, for the one place colour is allowed to carry meaning. */
export type VerdictTone = 'better' | 'worse' | 'same' | 'first';

export interface TesterRowObservation {
  frame: number;
  text: string;
}

export interface TesterRow {
  session: number;
  tone: VerdictTone;
  /** The verdict as a sentence. Never the stored token. */
  headline: string;
  /** What the tester understood you had changed. */
  seen: string;
  why: string;
  /** Always a sentence, in every state, including "nothing got worse". */
  regression: string;
  /** False when the tester never answered. The row says so rather than reassuring. */
  regressionAnswered: boolean;
  observations: TesterRowObservation[];
  openQuestions: string[];
  /** What it said last time, so a change of mind is visible without scrolling. */
  previously: string | null;
  /** Set when this verdict is the opposite of the one before it. */
  reversal: string | null;
  /** How the session ended, in words. */
  ending: string;
  /** When it played, as an ISO string the component formats. */
  finishedAt: string;
  steps: number;
}

function headlineFor(verdict: TesterNote['onTheChange']['verdict']): string {
  switch (verdict) {
    case 'better':
      return 'It says your last change helped.';
    case 'worse':
      return 'It says your last change made things worse.';
    case 'no-difference':
      return 'It says your last change made no real difference.';
    default:
      return 'Its first look at your game, with nothing yet to compare it against.';
  }
}

function toneFor(verdict: TesterNote['onTheChange']['verdict']): VerdictTone {
  switch (verdict) {
    case 'better':
      return 'better';
    case 'worse':
      return 'worse';
    case 'no-difference':
      return 'same';
    default:
      return 'first';
  }
}

/** Answers that mean "I looked and nothing did", as a person would write them. */
const NOTHING = /^(nothing|none|no|nothing got worse|nothing did|n\/a)\.?$/i;

function regressionLine(raw: string): { text: string; answered: boolean } {
  const value = raw.trim();
  if (value === '' || value === MISSING_REGRESSION) {
    return { text: 'It did not say whether anything got worse.', answered: false };
  }
  if (NOTHING.test(value)) return { text: 'Nothing got worse.', answered: true };
  return { text: value, answered: true };
}

function endingFor(note: TesterNote): string {
  const turns = `${note.steps} ${note.steps === 1 ? 'turn' : 'turns'}`;
  switch (note.stopped) {
    case 'budget':
      return `It played its whole budget of ${turns}.`;
    case 'user':
      return `You stopped it after ${turns}.`;
    case 'error':
      return 'It ran into trouble part way through and wrote down what it had.';
    default:
      return `It played ${turns} and said it had seen enough.`;
  }
}

/** Opposite verdicts. Anything softer is a different answer, not a contradiction. */
function isReversal(current: VerdictTone, previous: VerdictTone): boolean {
  return (current === 'better' && previous === 'worse') || (current === 'worse' && previous === 'better');
}

/**
 * The history, newest first. `notes` arrives oldest first from the server, which
 * is the order the reversal comparison needs and the opposite of the order a
 * reader wants.
 */
export function testerRows(notes: readonly TesterNote[]): TesterRow[] {
  const ordered = [...notes].sort((a, b) => a.session - b.session);
  const rows: TesterRow[] = ordered.map((note, index) => {
    const previous = index > 0 ? ordered[index - 1] : null;
    const tone = toneFor(note.onTheChange.verdict);
    const previousTone = previous ? toneFor(previous.onTheChange.verdict) : null;
    const regression = regressionLine(note.regression);
    return {
      session: note.session,
      tone,
      headline: headlineFor(note.onTheChange.verdict),
      seen: note.onTheChange.seen,
      why: note.onTheChange.why,
      regression: regression.text,
      regressionAnswered: regression.answered,
      // A claim with no frame behind it is a claim, not evidence, so it is
      // dropped here rather than shown with an apology in the component.
      observations: (note.observations ?? []).filter(
        (observation) => typeof observation.frame === 'number' && observation.frame >= 1,
      ),
      openQuestions: note.openQuestions ?? [],
      previously: previous ? headlineFor(previous.onTheChange.verdict) : null,
      reversal:
        previousTone && isReversal(tone, previousTone)
          ? 'This is the opposite of what it said last time.'
          : null,
      ending: endingFor(note),
      finishedAt: note.finishedAt,
      steps: note.steps,
    };
  });
  return rows.reverse();
}
