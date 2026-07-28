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
  return `It understood that ${clause(seen)}. That ${word}, because ${clause(why)}.`;
}

/** True when anything in this session happened somewhere the game put the tester. */
export function anythingPlaced(note: TesterNote): boolean {
  return (note.observations ?? []).some((observation) => observationReach(observation) === 'placed');
}

function trimDot(text: string): string {
  const value = text.trim();
  return value.endsWith('.') || value.endsWith('!') || value.endsWith('?') ? value : `${value}.`;
}

/** A fragment the tester wrote, dropped mid-sentence into one of ours. */
function clause(text: string): string {
  return text.trim().replace(/[.!?]+$/, '');
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

/** A picture's file name, zero-padded the way the session wrote it. */
export function frameFile(frame: number): string {
  return `${String(frame).padStart(4, '0')}.png`;
}

/** Words, commas and a final "and", the way a person writes a short list. */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** What a person sends an agent when they approve part of a plan of action. */
export interface ApprovalSeed {
  /** The message itself, in the person's voice, since that is whose it is. */
  text: string;
  /** Pictures behind what was ticked, in the order they were taken. */
  frames: number[];
}

/**
 * The message that opens the new conversation, carrying the ticked proposals
 * and nothing else.
 *
 * What is left out is the point. A proposal in an agent's context is a
 * proposal it may act on, so a seed that carried the whole plan would make the
 * ticking decorative. The rest of the session is left out for the same reason,
 * and the last line says so rather than letting the agent read a short brief
 * as a complete one.
 *
 * `framesPath` is where the session's pictures live, project-relative and
 * posix, because the agent opens them with its own tools. Handing over a path
 * rather than a copy is what the rest of the app does with an attachment, and
 * it means a plan resting on twenty pictures loses none of them.
 */
export function approvalSeed(
  note: TesterNote,
  selected: readonly string[],
  framesPath: string,
): ApprovalSeed | null {
  const wanted = new Set(selected);
  const picked = proposalsFrom(note).filter((proposal) => wanted.has(proposal.id));
  if (picked.length === 0) return null;

  const frames: number[] = [];
  for (const proposal of picked) {
    for (const frame of proposal.evidence) if (!frames.includes(frame)) frames.push(frame);
  }
  frames.sort((a, b) => a - b);

  const many = picked.length > 1;
  const files = listed(frames.map(frameFile));
  const lines = [
    `Your tester played session ${note.session} of this game. Out of what it wrote down I picked ${
      many ? `these ${picked.length}` : 'this one'
    } to work on.`,
    '',
    ...picked.map(proposalSentence),
    '',
    frames.length === 1
      ? `The picture behind that is in the project at ${framesPath}, as ${files}. Look at it before you change anything.`
      : `The pictures behind those are in the project at ${framesPath}, as ${files}. Look at them before you change anything.`,
    '',
    'That is what I ticked and nothing else. The rest of the session is not here, so ask me instead of filling in the gaps.',
  ];
  return { text: `${lines.join('\n')}\n`, frames };
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
