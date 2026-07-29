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
import { regressionSentence } from '../../../server/tester/report';
import {
  observationReach,
  unreadableNote,
  UNREADABLE_SEEN,
  type ObservationReach,
  type TesterNote,
} from '../../../server/tester/types';

/** What the history says to a folder whose tester has never played. */
export const TESTER_NEVER_PLAYED = 'Your tester has not played this game yet.';

/** How a verdict reads, for the one place colour is allowed to carry meaning. */
export type VerdictTone = 'better' | 'worse' | 'same' | 'first' | 'unreadable';

export interface TesterRowObservation {
  frame: number;
  text: string;
  /** Whether the tester got there by playing or the game put it there. */
  reached: ObservationReach;
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
    case 'unreadable':
      return UNREADABLE_SEEN;
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
    case 'unreadable':
      return 'unreadable';
    default:
      return 'first';
  }
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
    case 'unreadable':
      return 'How this session went could not be read out of its note.';
    default:
      return `It played ${turns} and said it had seen enough.`;
  }
}

/**
 * A note this file is safe to read, out of whatever arrived.
 *
 * The row reads `note.onTheChange.verdict` and hands `note.regression` to a
 * helper that trims it. Both throw on a note that has neither, a throw here is
 * a throw during render, and a throw during render with no boundary above it
 * blanks the whole window rather than the row. `listSessions` already turns an
 * unreadable file into an unreadable note, so in the normal path this changes
 * nothing. It is here for the paths that do not go through it: a note arriving
 * over the socket from a session in flight, and a store seeded by anything that
 * is not this app's own server.
 */
export function readableNote(note: TesterNote): TesterNote {
  const change = note?.onTheChange as TesterNote['onTheChange'] | undefined;
  if (!note || typeof change?.verdict !== 'string' || typeof note.regression !== 'string') {
    return unreadableNote(
      typeof note?.session === 'number' ? note.session : 0,
      typeof note?.startedAt === 'string' ? note.startedAt : '',
      typeof note?.finishedAt === 'string' ? note.finishedAt : '',
    );
  }
  return note;
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
  const ordered = [...notes]
    .map(readableNote)
    .sort((a, b) => a.session - b.session);
  const rows: TesterRow[] = ordered.map((note, index) => {
    const previous = index > 0 ? ordered[index - 1] : null;
    const tone = toneFor(note.onTheChange.verdict);
    const previousTone = previous ? toneFor(previous.onTheChange.verdict) : null;
    const regression = regressionSentence(note.regression);
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
      observations: (Array.isArray(note.observations) ? note.observations : [])
        .filter(
          (observation) =>
            observation != null &&
            typeof observation.frame === 'number' &&
            observation.frame >= 1 &&
            typeof observation.text === 'string',
        )
        .map((observation) => ({
          frame: observation.frame,
          text: observation.text,
          reached: observationReach(observation),
        })),
      // Anything that is not a string would be handed straight to React as a
      // child, and React throws on an object child. One hand-edited note must
      // not be able to do that.
      openQuestions: (Array.isArray(note.openQuestions) ? note.openQuestions : []).filter(
        (question): question is string => typeof question === 'string',
      ),
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
