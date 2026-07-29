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
import {
  observationReach,
  CRASHED_REGRESSION,
  UNREADABLE_REGRESSION,
  type ObservationReach,
  type TesterNote,
} from './types.js';

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
  // Unanswered, not answered with nothing. An unreadable note is the third
  // way this can go unanswered and it gets its own words, because blaming the
  // tester for a file Hearth could not parse would be the wrong accusation.
  if (value === UNREADABLE_REGRESSION) return { text: UNREADABLE_REGRESSION, answered: false };
  // The fourth, and the one that used to answer "yes it looked": a session
  // that fell over put its crash message in this field, and a crash message is
  // neither empty nor a sentinel, so a stack trace was read as the tester
  // having checked whether anything got worse.
  if (value === CRASHED_REGRESSION) return { text: CRASHED_REGRESSION, answered: false };
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
    case 'unreadable':
      // Says nothing about how it ended, because nothing about how it ended
      // survived. The turn count on this note is a placeholder, not a count.
      return 'How this session went could not be read out of its note.';
    default:
      return `It played ${turns} and said it had seen enough.`;
  }
}

/** The verdict on your last change, as a sentence. */
export function verdictSentence(note: TesterNote): string {
  const { seen, verdict, why } = note.onTheChange;
  // Not a verdict, and never rendered as one. The note could not be read, so
  // the only true thing to say is that, and why.
  if (verdict === 'unreadable') return `${trimDot(seen)} ${trimDot(why)}`;
  // The note is fine and everything else on it stands. Only the verdict is
  // missing, and it is missing because the tester did not give one, so the
  // sentence says that instead of picking the nearest of the three.
  if (verdict === 'unclear') return `It understood that ${clause(seen)}. ${trimDot(why)}`;
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

/**
 * What the game offered by way of somewhere to be put, as a sentence.
 *
 * Null only for a session played before a game could name anywhere: that is a
 * fact about Hearth at the time rather than about the game, and claiming the
 * game named nothing would be putting words in its mouth. Every session that
 * could have had the answer gets the sentence, including the sessions where
 * the answer is none. A capability that goes unsaid is a capability whose
 * absence looks like a shortcoming of the report.
 */
export function placementSentence(note: TesterNote): string | null {
  const placement = note.placement;
  if (!placement) return null;
  if (placement.offered < 1) {
    return 'The game named nowhere it could be put, so it played from the start.';
  }
  const count = `${counted(placement.offered)} ${placement.offered === 1 ? 'place' : 'places'}`;
  return placement.entered
    ? `The game named ${count} it could be put, and it asked for ${trimDot(placement.entered)}`
    : `The game named ${count} it could be put. It played from the start anyway.`;
}

/**
 * The three sections of a report that are drawn from an empty list, worded so
 * that an empty list is only ever read as an answer when it is one.
 *
 * "It found nothing here worth changing" is a sentence about somebody's game.
 * It was rendered from `length === 0` alone, so a session that crashed on the
 * way in, and a note this Hearth cannot read, both produced three confident
 * absences about a run that was never asked anything: nothing seen, nothing to
 * raise, nothing worth changing. That is a clean bill of health issued by a
 * session that never played, on the feature this product leads with.
 *
 * A session that was stopped by the person, or that ran out of budget, still
 * gets asked every question, so those endings keep the plain sentence: an empty
 * answer there really is the tester's own. Only 'error' and 'unreadable' lose
 * it, and what they get instead claims nothing in either direction. It does not
 * say the tester was never asked either, because a crash after the answer is
 * just as possible as one before it and the note does not say which.
 */
const CUT_SHORT = 'It ran into trouble part way through, and nothing was written down here.';

/** What "What it saw" says when there is nothing under it. */
export function nothingSeenSentence(note: TesterNote): string {
  if (note.stopped === 'unreadable') return 'What it saw could not be read out of this note.';
  if (note.stopped === 'error') return `${CUT_SHORT} That is not the same as it having seen nothing.`;
  return 'It did not write down anything it saw this session.';
}

/** What "Still could not work out" says when there is nothing under it. */
export function nothingRaisedSentence(note: TesterNote): string {
  if (note.stopped === 'unreadable') {
    return 'What it could not work out could not be read out of this note.';
  }
  if (note.stopped === 'error') return `${CUT_SHORT} That is not the same as it having nothing to raise.`;
  return 'Nothing it wanted to raise.';
}

/** What "Worth changing" says when the plan is empty and nothing was dropped. */
export function nothingToChangeSentence(note: TesterNote): string {
  if (note.stopped === 'unreadable') {
    return 'What it thought was worth changing could not be read out of this note.';
  }
  if (note.stopped === 'error') {
    return `${CUT_SHORT} That is not the same as it finding nothing worth changing.`;
  }
  return 'It found nothing here worth changing.';
}

/** True when anything in this session happened somewhere the game put the tester. */
export function anythingPlaced(note: TesterNote): boolean {
  // The session's own record first. A session that was placed and then wrote
  // its SAW lines about earlier pictures is still a session that was placed,
  // and the caveat above the list is what stops the rest of it being read as
  // proof a player can get there.
  if (typeof note.placedFrom === 'number' && note.placedFrom >= 1) return true;
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

/** Why a proposal the tester wrote is not in the plan the reader sees. */
export type DropReason = 'no-picture' | 'unknown-picture';

/** One thing the tester proposed that did not survive, kept so it can be counted. */
export interface DroppedProposal {
  kind: 'bug' | 'suggestion';
  text: string;
  why: DropReason;
}

/** What survived, and what did not. The second half is what the reader is owed. */
export interface Plan {
  plan: Proposal[];
  dropped: DroppedProposal[];
}

/**
 * The highest picture number this session could possibly have taken.
 *
 * `frames` is the real count and is the answer whenever a note carries one,
 * INCLUDING when that count is zero. A known zero used to be treated as no
 * answer at all and fell through to the turn count, so a game with no
 * screenshot method reported three turns, took no pictures, wrote no files, and
 * still rendered "Picture 3:" against a claim, with a path to a png that does
 * not exist handed to an agent as the evidence behind it.
 *
 * Older notes carry no count, so the turn count stands in: a picture is taken
 * at most once per turn, so it is an upper bound and never a smaller one.
 * Observations widen it as a last resort, because a note that cites picture
 * nine has by its own account taken nine.
 */
function frameBound(note: TesterNote): number {
  if (typeof note.frames === 'number' && note.frames >= 0) return note.frames;
  let bound = typeof note.steps === 'number' && note.steps > 0 ? note.steps : 0;
  for (const observation of note.observations ?? []) {
    if (typeof observation.frame === 'number' && observation.frame > bound) bound = observation.frame;
  }
  return bound;
}

/**
 * Whether a picture was somewhere the game put the tester, for a picture the
 * tester never wrote a SAW line about.
 *
 * A session is placed from one picture onward and never goes back (see
 * `placedFromFrame` in session.ts), so the earliest observation marked placed
 * is where the line falls, and everything at or after it inherits the caveat.
 * Recorded reach still wins where there is one: a hand-edited note is allowed
 * to disagree with the rule, and its own words are the more specific claim.
 */
function reachOf(frame: number, seen: Map<number, ObservationReach>, placedFrom: number | null): ObservationReach {
  const recorded = seen.get(frame);
  if (recorded) return recorded;
  return placedFrom !== null && frame >= placedFrom ? 'placed' : 'played';
}

/**
 * The plan of action, drawn from what the tester wrote down, and what fell out
 * of it on the way.
 *
 * A proposal has to name a picture from this session. That rule is the whole
 * value of the plan: without it the tester can hand back advice anyone could
 * have written without playing the game, and a list of plausible changes is the
 * most flattering output a playtester can produce.
 *
 * What is NOT the rule, and used to be by accident, is that the picture also
 * has to be one the tester wrote a SAW line about. `seen` was built from the
 * observations because that is where reach is recorded, so a proposal about
 * picture 14 of a 21 picture session died silently whenever the tester had
 * written its SAW lines about six other pictures, which is what testers
 * actually do. Nothing in the prompt ever asked for that and nothing in the
 * report ever admitted to it. The bound is the session's picture count now, the
 * prompt says so in as many words, and reach for an unobserved picture is
 * derived from where the placement line fell rather than assumed away.
 *
 * Nothing is generated here. A session where the tester proposed nothing
 * produces nothing, and that is a legitimate and frequently correct result.
 */
export function planFrom(note: TesterNote): Plan {
  const seen = new Map<number, ObservationReach>();
  // What the session itself recorded, which is the only account that can be
  // complete. Deriving this from the observations alone was a real hole: a
  // session placed at picture four whose SAW lines all described pictures one
  // to three recovered nothing, so picture five was reported as reached by
  // playing, with no reachability caveat, and went out to an agent as evidence
  // that a player can get there. Notes written before the field existed still
  // fall back to the derivation, which is better than nothing and never worse
  // than what they had.
  let placedFrom = typeof note.placedFrom === 'number' && note.placedFrom >= 1 ? note.placedFrom : null;
  for (const observation of note.observations ?? []) {
    if (typeof observation.frame !== 'number') continue;
    const reach = observationReach(observation);
    seen.set(observation.frame, reach);
    if (reach === 'placed' && (placedFrom === null || observation.frame < placedFrom)) {
      placedFrom = observation.frame;
    }
  }
  const bound = frameBound(note);

  const plan: Proposal[] = [];
  const dropped: DroppedProposal[] = [];
  (note.proposals ?? []).forEach((raw, index) => {
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    if (text === '') return;
    const kind = raw.kind === 'bug' ? 'bug' : 'suggestion';
    const cited = raw.evidence ?? [];
    const evidence: number[] = [];
    for (const frame of cited) {
      // A picture past the end of the session is a claim, not evidence: a
      // finding about picture forty of a ten picture session is about a
      // picture nobody took.
      if (frame >= 1 && frame <= bound && !evidence.includes(frame)) evidence.push(frame);
    }
    if (evidence.length === 0) {
      dropped.push({ kind, text, why: cited.length === 0 ? 'no-picture' : 'unknown-picture' });
      return;
    }
    plan.push({
      id: `s${note.session}-p${index}`,
      kind,
      text,
      evidence,
      // One placed picture is enough. The proposal inherits the caveat rather
      // than averaging it away.
      reached: evidence.some((frame) => reachOf(frame, seen, placedFrom) === 'placed') ? 'placed' : 'played',
    });
  });
  return { plan, dropped };
}

/** The plan alone, for the readers that have nothing to say about the drops. */
export function proposalsFrom(note: TesterNote): Proposal[] {
  return planFrom(note).plan;
}

/**
 * What was dropped, as a sentence, or null when nothing was.
 *
 * Said out loud because the alternative is what shipped: everything the parser
 * or the anchor rule threw away came out as "It found nothing here worth
 * changing", which is a sentence about the game. Silence here is how a parse
 * miss gets read as a clean bill of health.
 */
export function droppedSentence(dropped: readonly DroppedProposal[], planEmpty: boolean): string | null {
  if (dropped.length === 0) return null;
  const one = dropped.length === 1;
  const count = one ? 'one thing' : `${counted(dropped.length)} things`;
  const clause = dropped.every((item) => item.why === 'no-picture')
    ? one
      ? 'it named no picture from this session'
      : 'none of them named a picture from this session'
    : dropped.every((item) => item.why === 'unknown-picture')
      ? one
        ? 'it pointed at a picture this session did not take'
        : 'none of them pointed at a picture this session took'
      : one
        ? 'it did not point at a picture from this session'
        : 'none of them pointed at a picture from this session';
  // "It proposed one thing more" was what the second branch used to read:
  // `count` already carries the noun, so `${count} more` glued "more" onto the
  // end of a complete phrase. The word belongs in front of the number, where a
  // person would put it.
  return planEmpty
    ? `It proposed ${count}, and ${clause}, so there is nothing here to tick.`
    : `It proposed ${one ? 'one more thing' : `${counted(dropped.length)} more things`}, and ${clause}, so ${
        one ? 'it is' : 'they are'
      } not on this list.`;
}

/**
 * What a claim from somewhere the game put the tester is worth.
 *
 * One sentence, used wherever such a claim appears: the report, the row in the
 * plan of action, and the message an agent receives. Rewording it per surface
 * would leave a reader wondering whether three warnings meant three things.
 */
export const PLACED_CLAIM =
  'The game put it there, so this says nothing about whether a player can reach it.';

/** Said once over the bugs, rather than restated on every one of them. */
export const PLAN_BUGS = 'It watched these go wrong';

/** Said once over the rest. It cannot judge fun, and the heading admits it. */
export const PLAN_PREFERENCES = 'These are preferences, and it cannot judge fun';

/** Which pictures a claim rests on, worded as the rest of the report words it. */
export function picturesFor(frames: readonly number[]): string {
  if (frames.length === 1) return `Picture ${frames[0]}`;
  return `Pictures ${frames.slice(0, -1).join(', ')} and ${frames[frames.length - 1]}`;
}

/**
 * One proposal, anchored to its pictures the way the observations above it are.
 *
 * The kind is deliberately NOT repeated here. Three proposals that each open
 * "A bug it watched happen" is a template, and a reader skims a template. It is
 * said once per group instead, by `planLines`.
 */
export function proposalLine(proposal: Proposal): string {
  const placed = proposal.reached === 'placed' ? ` ${PLACED_CLAIM}` : '';
  return `${picturesFor(proposal.evidence)}: ${trimDot(proposal.text)}${placed}`;
}

/**
 * A plan of action as prose, grouped by kind, for the report and for the
 * message an agent receives. Empty in, empty out.
 */
export function planLines(plan: readonly Proposal[]): string[] {
  const bugs = plan.filter((proposal) => proposal.kind === 'bug');
  const preferences = plan.filter((proposal) => proposal.kind !== 'bug');
  const lines: string[] = [];
  if (bugs.length > 0) lines.push(`${PLAN_BUGS}.`, ...bugs.map(proposalLine));
  if (preferences.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`${PLAN_PREFERENCES}.`, ...preferences.map(proposalLine));
  }
  return lines;
}

/** Small counts as words, the way a person writes them. */
function counted(n: number): string {
  return ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
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

  const files = listed(frames.map(frameFile));
  const lines = [
    // Opens on the WORK, and that is not a stylistic choice. A conversation is
    // titled from the first line of the message that started it, so the old
    // opening ("Your tester played session 3 of this game...") put a row in the
    // chat rail that read as the session's own record. The rail filled up with
    // what looked like one entry per playtest, and a session's record belongs
    // to the project rather than among somebody's own conversations. This
    // conversation is the agent doing work that was approved, so it says so.
    `Work on ${
      picked.length === 1 ? 'one thing' : `${counted(picked.length)} things`
    } I ticked from my tester's session ${note.session}.`,
    '',
    ...planLines(picked),
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
  const { plan, dropped } = planFrom(note);
  const lines: string[] = [];

  lines.push(`Session ${note.session}`, endingSentence(note), '');

  lines.push('On your last change', verdictSentence(note), '');

  lines.push('Anything worse', regressionSentence(note.regression).text, '');

  const placement = placementSentence(note);
  if (placement !== null) lines.push('Where it played', placement, '');

  lines.push('What it saw');
  if (observations.length === 0) {
    lines.push(nothingSeenSentence(note));
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
    lines.push(nothingRaisedSentence(note));
  } else {
    for (const question of questions) lines.push(sentence(question));
  }
  lines.push('');

  lines.push('Worth changing');
  const drops = droppedSentence(dropped, plan.length === 0);
  if (plan.length === 0) {
    // "It found nothing" is a sentence about the game, so it is only ever said
    // when the tester actually proposed nothing AND the session got far enough
    // for that to be its answer. Anything that fell out of the plan on the way
    // is said instead, and counted.
    lines.push(drops ?? nothingToChangeSentence(note));
  } else {
    lines.push(...planLines(plan));
    if (drops) lines.push('', drops);
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
