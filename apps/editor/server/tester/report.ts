/**
 * The session written out for a reader, and the plan of action they pick from.
 *
 * Pure, and deliberately so. The rules that stop a session lying are all here,
 * where they can be checked without a model, a browser or a game:
 *
 *  - A claim about somewhere the tester was put says so on its own line, and
 *    the report says once, plainly, what that does to the finding.
 *  - Whether anything got worse is answered every time, including when the
 *    answer is nothing.
 *  - A proposal has to point at a picture from this session. That is what keeps
 *    the plan of action free of advice anyone could have written without
 *    playing this particular game.
 *
 * The prose is for a person first. An agent reads the same words when the
 * person sends them, because it is another reader rather than a parser, and a
 * wall of fields costs it context while burying the two sentences that matter.
 */
import { MISSING_REGRESSION } from './prompt.js';
import { observationReach, type ObservationReach, type TesterNote } from './types.js';

/** One thing to do, as it appears in the plan of action. */
export interface Proposal {
  /** Stable for a given note, so a tick survives a re-read. */
  id: string;
  kind: 'bug' | 'suggestion';
  text: string;
  /** Pictures from this session that the claim rests on. Never empty. */
  evidence: number[];
  /** Placed when any picture behind it was somewhere the game put the tester. */
  reached: ObservationReach;
}

/**
 * Said once, in the body, wherever a placed observation appears. Being dropped
 * into the middle of a game tells you about the middle of that game and nothing
 * about the route there.
 */
export const REACHABILITY_CAVEAT =
  'Some of this happened where the game put the tester, not where it got to by playing. Those pictures say nothing about whether a player can reach that content.';

/** Answers that mean "I looked and nothing did", as a person would write them. */
const NOTHING = /^(nothing|none|no|nothing got worse|nothing did|n\/a)\.?$/i;

/**
 * The regression answer as a sentence. Three outcomes, and they must stay three
 * outcomes: a note that turns silence into reassurance can only ever say the
 * change was fine.
 */
export function regressionSentence(raw: string): { text: string; answered: boolean } {
  const value = raw.trim();
  if (value === '' || value === MISSING_REGRESSION) {
    return { text: 'It did not say whether anything got worse.', answered: false };
  }
  if (NOTHING.test(value)) return { text: 'Nothing got worse.', answered: true };
  return { text: value, answered: true };
}

/** How the session ended, in words rather than the stored token. */
export function endingSentence(note: TesterNote): string {
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

/** The verdict on your last change, as a sentence. */
export function verdictSentence(note: TesterNote): string {
  const { seen, verdict, why } = note.onTheChange;
  if (verdict === 'first-session') {
    const first = 'This was its first look at your game, so there is nothing to compare it with yet.';
    // On a session that fell over, `why` holds what went wrong, and that is
    // the one thing a reader of a first session wants.
    return note.stopped === 'error' ? `${first} ${trimDot(why)}` : first;
  }
  const word =
    verdict === 'better' ? 'helped' : verdict === 'worse' ? 'made things worse' : 'made no real difference';
  return `It understood that ${seen}. That ${word}, because ${trimDot(why).slice(0, -1)}.`;
}

/** True when anything in this session happened somewhere the game put the tester. */
export function anythingPlaced(note: TesterNote): boolean {
  return (note.observations ?? []).some((observation) => observationReach(observation) === 'placed');
}

function trimDot(text: string): string {
  const value = text.trim();
  return value.endsWith('.') || value.endsWith('!') || value.endsWith('?') ? value : `${value}.`;
}

/** A fragment the tester wrote, standing on its own line as a sentence. */
function sentence(text: string): string {
  const value = trimDot(text);
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The plan of action, drawn from what the tester wrote down.
 *
 * Everything here is a filter. Nothing is generated: a session where the tester
 * proposed nothing produces nothing, and that is a legitimate result rather
 * than an empty surface to apologise for. A tester whose plan is never empty
 * will start manufacturing work, since a list of changes is the most flattering
 * output it can produce.
 */
export function proposalsFrom(note: TesterNote): Proposal[] {
  const seen = new Map<number, ObservationReach>();
  for (const observation of note.observations ?? []) {
    if (typeof observation.frame === 'number') seen.set(observation.frame, observationReach(observation));
  }

  const out: Proposal[] = [];
  (note.proposals ?? []).forEach((raw, index) => {
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    if (text === '') return;
    const evidence: number[] = [];
    for (const frame of raw.evidence ?? []) {
      // Only pictures this session actually took, and only ones the tester
      // wrote something about. A proposal that anchors to nothing is advice
      // that could have been written without playing the game.
      if (seen.has(frame) && !evidence.includes(frame)) evidence.push(frame);
    }
    if (evidence.length === 0) return;
    out.push({
      id: `s${note.session}-p${index}`,
      kind: raw.kind === 'bug' ? 'bug' : 'suggestion',
      text,
      evidence,
      // One placed picture is enough. The proposal inherits the caveat rather
      // than averaging it away.
      reached: evidence.some((frame) => seen.get(frame) === 'placed') ? 'placed' : 'played',
    });
  });
  return out;
}

/** How one proposal reads in the report and in the seed sent to an agent. */
export function proposalSentence(proposal: Proposal): string {
  const pictures =
    proposal.evidence.length === 1
      ? `picture ${proposal.evidence[0]}`
      : `pictures ${proposal.evidence.slice(0, -1).join(', ')} and ${proposal.evidence[proposal.evidence.length - 1]}`;
  const lead = proposal.kind === 'bug' ? 'A bug it watched happen' : 'A preference, not something it saw go wrong';
  // The caveat rides with the claim rather than trailing the section, so a
  // reader deciding on this one line has it in front of them.
  const placed =
    proposal.reached === 'placed' ? ' It saw that where the game put it, not somewhere it reached.' : '';
  return `${lead}, from ${pictures}: ${trimDot(proposal.text)}${placed}`;
}

/**
 * The whole session, for whoever is reading it.
 *
 * Written as prose with headings rather than fields. Every section appears
 * every time, including the ones whose answer is "nothing", because a heading
 * that only shows up when there is bad news teaches a reader to skim past it.
 */
export function renderReport(note: TesterNote): string {
  const observations = note.observations ?? [];
  const questions = note.openQuestions ?? [];
  const plan = proposalsFrom(note);
  const lines: string[] = [];

  lines.push(`Session ${note.session}`, endingSentence(note), '');

  lines.push('On your last change', verdictSentence(note), '');

  lines.push('Anything worse', regressionSentence(note.regression).text, '');

  lines.push('What it saw');
  if (observations.length === 0) {
    lines.push('It did not write down anything it saw this session.');
  } else {
    for (const observation of observations) {
      const where = observationReach(observation) === 'placed' ? ', placed' : '';
      lines.push(`Picture ${observation.frame}${where}: ${trimDot(observation.text)}`);
    }
    if (anythingPlaced(note)) lines.push('', REACHABILITY_CAVEAT);
  }
  lines.push('');

  lines.push('Still could not work out');
  if (questions.length === 0) {
    lines.push('Nothing it wanted to raise.');
  } else {
    for (const question of questions) lines.push(sentence(question));
  }
  lines.push('');

  lines.push('Worth changing');
  if (plan.length === 0) {
    // Not an empty state and not a failure. Most sessions of a game that is
    // going well should end here.
    lines.push('It found nothing here worth changing.');
  } else {
    for (const proposal of plan) lines.push(proposalSentence(proposal));
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
