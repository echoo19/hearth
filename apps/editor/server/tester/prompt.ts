/**
 * Everything the tester is told, and everything it says back.
 *
 * This file is the sycophancy defence. Two of the three mitigations in the
 * design are properties of what is asked and in what order, so they live here
 * rather than in the loop:
 *
 *  1. The tester writes down what it saw THIS session before it is shown its own
 *     previous verdict. That is an ordering, not a request: `testerPrompts`
 *     returns the observation prompt strictly before the comparison prompt, and
 *     the comparison prompt is the only one carrying the old verdict. It cannot
 *     anchor on praise it has not read yet.
 *  2. Whether anything got worse is a required answer. When it goes unanswered
 *     the note says it went unanswered, because filling it in with "nothing" is
 *     how silence becomes approval forever.
 *
 * The reply format is markers in prose rather than JSON. The tester is a model
 * playing a game, and a reply the parser cannot read must degrade to waiting,
 * never to a guess: an input nobody chose would put a claim in the note that
 * nothing did.
 */
import type { ProbeState } from '@hearth/probe-core';
import type { ChangeVerdict, TesterObservation, TesterProposal } from './types.js';

/** What the tester decided to do with one frame. */
export type Decision =
  | { kind: 'actions'; actions: string[] }
  | { kind: 'enter'; id: string }
  | { kind: 'pointer'; x: number; y: number; click: boolean }
  | { kind: 'done' }
  | { kind: 'wait' };

/** What the note says when the tester never answered whether anything got worse. */
export const MISSING_REGRESSION = 'The tester did not say whether anything got worse.';

/** What the note says when it gave no readable verdict at all. */
export const MISSING_VERDICT_WHY = 'The tester did not give a clear answer.';

/**
 * What the note says when the tester answered the verdict question with
 * something that is not one of the three answers.
 *
 * Its own sentence, and it names the tester rather than the file: this note is
 * perfectly readable and everything else on it stands. Only the verdict is
 * absent, and it is absent because the tester declined to give one.
 */
export const UNCLEAR_VERDICT =
  'It answered the verdict question with something that is not better, worse or no difference, so no verdict is recorded for this session rather than a guess at which one it meant.';

const ENTER_LINE = /^[^\S\n]*ENTER[^\S\n]*:(.*)$/im;
const ACTION_LINE = /^[^\S\n]*ACTION[^\S\n]*:(.*)$/im;
const CLICK_LINE = /^[^\S\n]*(CLICK|MOVE)[^\S\n]*:(.*)$/im;
const DONE_LINE = /^[^\S\n]*DONE\b/im;

/**
 * Read one decision out of a reply. Order matters: an action or a click wins
 * over a trailing DONE, so a tester that plays a turn and then announces it has
 * seen enough still has its input applied. The budget ends the session either
 * way, so the cost of continuing one turn too long is one turn.
 */
export function decideFromReply(text: string): Decision {
  // Asking to be moved comes first. A reply that asks to be put somewhere and
  // holds a key in the same breath means the key was for after the move, and
  // pressing it where the tester no longer wants to be is the wrong reading.
  const enter = ENTER_LINE.exec(text);
  if (enter) {
    const id = enter[1].trim();
    if (id !== '') return { kind: 'enter', id };
  }

  const action = ACTION_LINE.exec(text);
  if (action) {
    const actions = action[1]
      .split(/[,\s]+/)
      .map((name) => name.trim())
      .filter((name) => name !== '' && name.toLowerCase() !== 'none');
    if (actions.length > 0) return { kind: 'actions', actions };
  }

  const pointer = CLICK_LINE.exec(text);
  if (pointer) {
    const numbers = pointer[2].match(/-?\d+(?:\.\d+)?/g);
    if (numbers && numbers.length >= 2) {
      return {
        kind: 'pointer',
        x: Number(numbers[0]),
        y: Number(numbers[1]),
        click: pointer[1].toUpperCase() === 'CLICK',
      };
    }
  }

  if (DONE_LINE.test(text)) return { kind: 'done' };
  return { kind: 'wait' };
}

/** What the tester is allowed to do with this particular game. */
export interface TesterControls {
  actions: string[];
  axes: string[];
  pointer: boolean;
  /**
   * Whether a key the game never declared can actually be sent to it.
   *
   * The offer below is only made when this is true, because a tester told it
   * may press what the screen tells it to, whose presses then go nowhere, is
   * worse off than one that was never told.
   */
  keys?: boolean;
}

export interface TesterPromptContext {
  /** The tester's durable memory of this game, or empty the first time. */
  memory: string;
  /** What the project recorded happening since it last played. */
  changes: string;
  /** The verdict it gave last time, or null when this is its first session. */
  lastVerdict: string | null;
}

const ROLE = [
  'You are the private playtester for this game. You play it yourself, you remember every',
  'previous time you played, and your job is to say whether the last change helped.',
  '',
  'You are not a good player and you must never claim to be. Report what you tried and what',
  'happened, including failing. Never say you finished something you did not see finish.',
  'Answer from the pictures you are shown. Do not use tools and do not read the source.',
].join('\n');

/**
 * The five prompts of a session, in the order they are sent: settle in, write
 * down this session, compare it with last time, say what is worth changing,
 * rewrite memory. The play turns happen between the first and the second.
 */
export function testerPrompts(ctx: TesterPromptContext): string[] {
  const memory = ctx.memory.trim() === '' ? 'You have never played this game before.' : ctx.memory.trim();
  const changes = ctx.changes.trim() === '' ? 'Nothing was recorded.' : ctx.changes.trim();

  // Deliberately carries no previous verdict. This is what the tester holds in
  // mind while it plays and while it writes down what it saw.
  const briefing = [
    ROLE,
    '',
    'What you remember about this game:',
    memory,
    '',
    'What the project recorded happening since you last played:',
    changes,
    '',
    'You are about to be shown one picture of the game at a time. Each time, reply with a',
    'short sentence about what you see and then exactly one line of one of these forms:',
    '',
    '  ACTION: <input names, comma separated>   hold these for the next moment of play',
    '  CLICK: <x>, <y>                          click at that pixel of the picture',
    '  MOVE: <x>, <y>                           move the pointer there without clicking',
    '  DONE                                     you have learned what you came to learn',
    '',
    'Say DONE when you have seen enough, and do not draw it out: every turn costs the person',
    'whose game this is. Reply with nothing else after that line.',
  ].join('\n');

  const observe = [
    'That is the end of your play. What did you see this session?',
    '',
    'Write one line per thing you actually saw, each anchored to the picture it happened on:',
    '',
    '  SAW <picture number>: <what happened>',
    '',
    'Then, for anything you could not work out, one line each:',
    '',
    '  QUESTION: <what you could not work out>',
    '',
    'Only write down what you saw in a picture. If you did not see it, leave it out.',
  ].join('\n');

  // The only prompt carrying the old verdict, and it arrives after the tester
  // has already committed to what it saw.
  const compare = [
    ctx.lastVerdict === null
      ? 'This was your first session with this game, so there is nothing to compare it with yet.'
      : `Last time you played, your verdict on the change was: ${ctx.lastVerdict}. You are allowed to disagree with yourself, and saying so plainly is more useful than being consistent.`,
    '',
    'What the project recorded changing since you last played:',
    changes,
    '',
    'Now answer these four, one per line, in this format:',
    '',
    '  CHANGE: <what you understood was changed, in your own words>',
    '  VERDICT: <one of: better, worse, no-difference>',
    '  WHY: <what in this session made you say that>',
    '  WORSE: <did anything get worse? name it, or write "nothing">',
    '',
    'The WORSE line is required. If nothing got worse, say so on purpose. Do not soften a',
    'verdict to be encouraging: a playtester who says every change is an improvement is worse',
    'than no playtester at all.',
  ].join('\n');

  // Asked last of the questions about this session, so nothing it wants
  // changed can rewrite what it already said it saw.
  const plan = [
    'Last question about this session, and nothing is a common answer to it.',
    '',
    'Is anything you saw worth changing? Only from the pictures. One line each:',
    '',
    '  BUG <picture numbers>: <what went wrong>',
    '  IDEA <picture numbers>: <what you would rather it did>',
    '',
    'Every line has to name at least one picture number from this session. Any picture will',
    'do, including ones you did not write a SAW line about. A line that names no picture is',
    'not carried into the plan at all, because a claim with no picture behind it is advice',
    'anyone could have written without playing this game.',
    '',
    'BUG is for something you watched go wrong. IDEA is for a preference, and a preference is',
    'all it can be: you cannot tell whether a game is fun, so do not write as though you can.',
    '',
    'If nothing is worth changing, reply with NOTHING on its own. Finding something every time',
    'you play is how a playtester ends up inventing work, so say nothing when there is nothing.',
  ].join('\n');

  const remember = [
    'Last thing. Rewrite what you know about this game, for yourself to read next time.',
    '',
    'Plain markdown, short, and written so the person who owns this game could read it and',
    'correct anything you got wrong. Keep what is still true, add what you learned, drop what',
    'you now know was wrong. Reply with the markdown and nothing else.',
  ].join('\n');

  return [briefing, observe, compare, plan, remember];
}

/**
 * How the declared states are put to the tester.
 *
 * An offer, never an instruction. A tester told to skip ahead stops playing the
 * opening, and the opening is the part a first session is worth the most for.
 * The full list arrives once; after that it is one line, because a reminder
 * repeated every turn reads as a nudge.
 */
function statesOffer(step: number, states: readonly ProbeState[]): string {
  if (states.length === 0) return '';
  if (step > 1) return '\nYou can still ask to be put somewhere with an ENTER line.';
  const lines = states.map((state) => {
    const detail = state.detail ? ` (${state.detail})` : '';
    return `  ENTER: ${state.id}    ${state.label}${detail}`;
  });
  return [
    '',
    'This game can put you into any of these, if you want. You do not have to use them,',
    'and what you find by playing from here is worth more.',
    '',
    ...lines,
    '',
    'Anything you see after being put somewhere is written down as placed rather than',
    'reached, so it says nothing about whether a player can get there.',
  ].join('\n');
}

/**
 * The standing invitation to read the game's own screen.
 *
 * The listed inputs are what Hearth could work out about a game from the
 * outside. What a game tells its player is a different and usually better list,
 * and the tester was never told to look at it: it read "R to restart" on the
 * screen, asked for R, and had the press dropped because R was not on Hearth's
 * list. It then decided the game was stuck. So the picture is named as a source
 * of controls, and it is only named when a key really can be sent.
 */
const READ_THE_SCREEN = [
  'Games usually tell you their own controls on screen, and that list is theirs rather than',
  'mine. If the picture names a key, you can put that key on an ACTION line whether or not it',
  'is listed above: single keys like R or 5, and named keys like Space, Enter, Escape or',
  'ArrowLeft, all reach the game. A word for an idea, like jump or restart, only reaches the',
  'game when it is one of the inputs listed above.',
].join('\n');

/**
 * What did not arrive, put to the tester before it looks at the next picture.
 *
 * The last sentence is the load-bearing one. Without it the tester reads its
 * own dropped input as the game failing to respond, which is how a session that
 * pressed nothing ends in a report saying the game was stuck.
 */
function undeliveredNotice(undelivered: readonly string[]): string {
  if (undelivered.length === 0) return '';
  return [
    '',
    undelivered.length === 1
      ? 'Before this picture, one thing you asked for never reached the game:'
      : 'Before this picture, some of what you asked for never reached the game:',
    ...undelivered.map((line) => `  ${line}`),
    'That is not the game failing to respond. It never got the input, so do not write it down',
    'as the game ignoring you.',
  ].join('\n');
}

/** What the tester is shown with each frame. Short: the picture is the message. */
export function playPrompt(
  step: number,
  maxSteps: number,
  controls: TesterControls,
  states: readonly ProbeState[] = [],
  undelivered: readonly string[] = [],
  /**
   * Which picture the tester is looking at, or null when this turn has none.
   *
   * Not the same number as the turn, and conflating the two was a real fault:
   * the picture count only moves when a screenshot succeeds, so one failure
   * made every later turn announce a picture number one ahead of the file
   * attached to it, and the tester's citations were then checked against the
   * real count and thrown away as pictures nobody took. Defaults to the turn
   * only so a caller that takes a picture every turn reads naturally.
   */
  picture: number | null = step,
): string {
  const left = maxSteps - step + 1;
  const inputs = controls.actions.length > 0 ? controls.actions.join(', ') : 'none detected';
  const axes = controls.axes.length > 0 ? `\nAxes you can drive: ${controls.axes.join(', ')}.` : '';
  const pointer = controls.pointer ? '\nYou can also click anywhere in the picture.' : '';
  const keys = controls.keys ? `\n${READ_THE_SCREEN}` : '';
  const offer = statesOffer(step, states);
  const closing =
    states.length > 0
      ? 'One sentence, then one ACTION, CLICK, MOVE, ENTER or DONE line.'
      : 'One sentence, then one ACTION, CLICK, MOVE or DONE line.';
  const turns = `You have ${left} ${left === 1 ? 'turn' : 'turns'} left.`;
  const heading =
    picture === null
      ? `There is no picture this turn: the game could not be photographed. ${turns} Do not write down anything about what you could not see.`
      : `Picture ${picture}. ${turns}`;
  return [
    heading,
    `Inputs you can hold: ${inputs}.${axes}${pointer}${keys}${offer}${undeliveredNotice(undelivered)}`,
    closing,
  ].join('\n');
}

/** Asked once when the tester answered the four questions without the required one. */
export const REGRESSION_REMINDER = [
  'You left out the required line. Answer it now, on its own:',
  '',
  '  WORSE: <did anything get worse? name it, or write "nothing">',
].join('\n');

function labelled(text: string, label: string): string | null {
  const match = new RegExp(`^[^\\S\\n]*${label}[^\\S\\n]*:(.*)$`, 'im').exec(text);
  const value = match?.[1].trim();
  return value !== undefined && value !== '' ? value : null;
}

/**
 * The claims the tester made, each anchored to a frame that exists. `frameCount`
 * is how many pictures the session actually took: a claim about picture forty of
 * a ten-picture session is a claim, not evidence, and is dropped here rather
 * than rendered with an apology later.
 *
 * `placedFromFrame` is the first picture taken after the game put the tester
 * somewhere, or null when that never happened. Everything from there on is
 * marked placed, because a claim about content the tester was dropped into says
 * nothing about whether a player can arrive at it.
 */
export function parseObservations(
  text: string,
  frameCount: number,
  placedFromFrame: number | null = null,
): TesterObservation[] {
  const out: TesterObservation[] = [];
  for (const line of text.split('\n')) {
    const match = /^[^\S\n]*SAW[^\S\n]*(\d+)[^\S\n]*:(.*)$/i.exec(line);
    if (!match) continue;
    const frame = Number.parseInt(match[1], 10);
    const body = match[2].trim();
    if (body === '' || !(frame >= 1) || frame > frameCount) continue;
    // Written down rather than left to be inferred later: which pictures came
    // after a placement is something only this session knows.
    const reached = placedFromFrame !== null && frame >= placedFromFrame ? 'placed' : 'played';
    out.push({ frame, text: body, reached });
  }
  return out;
}

/**
 * One BUG or IDEA line, as models actually write them rather than as the prompt
 * draws them.
 *
 * The old pattern was `^\s*(BUG|IDEA)\s*([\d,\s]*):` and it is the reason the
 * plan of action had never once worked against a live model. It demanded the
 * marker at the very start of the line with nothing but spaces before it, and
 * it demanded that the space between the marker and the colon hold digits and
 * commas and nothing else. Models write prose in markdown. Every one of these
 * was silently dropped, and a dropped proposal is indistinguishable from a
 * session that found nothing:
 *
 *     - BUG 7: the audit total goes negative
 *     **BUG 7:** the audit total goes negative
 *     1. BUG 7: the audit total goes negative
 *     BUG (pictures 7, 21): the audit total goes negative
 *
 * So three things are allowed in front of the marker, and each is a shape a
 * model reaches for on its own: one list bullet or ordinal, one markdown
 * heading, and a run of emphasis characters. Between the marker and the colon
 * anything short is allowed and only the digits in it are read, which is what
 * lets "(pictures 7, 21)" and "7 and 21" and "#7" all mean the same thing.
 *
 * What is NOT relaxed is the anchor. A line still has to name a picture to
 * become a proposal, and `report.ts` is where that is enforced, because the
 * count of what it dropped is something the reader is owed.
 */
/**
 * Whatever a model puts in front of a marker: quote marks, bullets, ordinals,
 * task boxes, emphasis, in any order and any number. `> - BUG 7:` and
 * `- [ ] BUG 7:` and `**- BUG 7:**` are all things models write and the
 * single-slot version missed every one of them.
 *
 * One flat character class rather than a nested run of alternatives,
 * deliberately: alternatives that can all start on `*` backtrack badly on a
 * line of nothing but asterisks, and this runs over text a model wrote.
 *
 * The separator is a colon or a dash, because a model writes a dash instead
 * often enough to matter and `BUG 7 <dash> it crashes` used to vanish
 * entirely. `(?![A-Za-z])` rather than `\b` after the marker, so `BUG7:` is
 * read and `BUGGY:` is not.
 */
const PROPOSAL_LINE =
  /^[ \t]*[-*+•>#\d.)(\][xX_`\t ]*(BUG|IDEA)(?![A-Za-z])([^\n]{0,120}?)[:\u2014\u2013](.*)$/i;

/**
 * A span between the marker and the colon that is nothing but a list of
 * numbers: `7`, `7, 21`, `7 and 21`, `#7`.
 *
 * Numbers and the punctuation people join numbers with, and NOTHING else. The
 * moment a word gets in, the span stops being a list and becomes a sentence,
 * and the numbers in a sentence are as likely to be counts, coordinates,
 * levels or odds as they are to be pictures.
 */
const NUMBER_LIST = /^[\s*_`([]*#?\s*\d+(?:\s*(?:,|&|\+|and)\s*#?\s*\d+)*[\s*_`)\]]*$/i;

/**
 * A word that says the number after it is a picture, with the number it names.
 *
 * The marker has to come BEFORE the number, because that is the difference
 * between which one and how many: "frame 2" names a picture and "2 frames" is a
 * count. `BUG in 2 frames:` was read as a citation of picture 2 purely because
 * the word "frames" appeared somewhere in the span.
 *
 * A marker in front is still not enough on its own, which is the second half of
 * the same defect and one grammar step over: see `ownsItsNumbers` below.
 */
const MARKED_CITATION =
  /(?:pictures?|pics?|frames?|shots?|screenshots?|no\.)\s*#?\s*(\d+(?:\s*(?:,|&|\+|and)\s*#?\s*\d+)*)/gi;

/**
 * Whether the marker really owns the numbers that followed it, judged by what
 * comes after them.
 *
 * `BUG frames 3 seconds apart:` puts the marker in front of the number and the
 * number still is not a picture: it belongs to the word AFTER it, and it counts
 * seconds. A citation ends where a citation ends, which is a bracket, a comma,
 * a full stop or the end of the span. A word or another number running straight
 * on from the last one means the number was that word's.
 *
 * This drops citations a person would have recognised: `frames 4 and 9 show the
 * bug` is a real reference and fails this. That is the correct trade and the
 * same one the rest of this function makes. A dropped proposal is counted and
 * said out loud by `report.ts`; a minted anchor sends an agent to look at a
 * picture the tester never pointed at, and nothing downstream can tell it from
 * a real one.
 */
function ownsItsNumbers(after: string): boolean {
  return !/^\s*[\p{L}\p{N}]/u.test(after);
}

/**
 * The pictures a proposal line pointed at. Empty when it pointed at none, and
 * empty is a real answer that the report is required to say out loud.
 *
 * A number is evidence only when the span is unambiguously a reference to a
 * picture: either the span is nothing but a list of numbers, or a number
 * follows a word that says it is a picture. Everything else cites nothing.
 *
 * That is deliberately strict, and it will drop some citations a person would
 * have recognised. It is the correct trade. Harvesting every digit out of a
 * relaxed span INVENTED evidence: `BUG in level 2: the floor is missing` became
 * a finding anchored to picture 2, `BUG (x=140, y=60):` claimed pictures 140
 * and 60, `BUG 1 in 10:` claimed pictures 1 and 10, and `BUG at 12:30` claimed
 * picture 12. The report then rendered "Picture 2:" against a claim the tester
 * never made about picture 2, and `approvalSeed` told an agent "the picture
 * behind that is 0002.png, look at it before you change anything". A dropped
 * proposal is counted and said out loud by `report.ts`; an invented anchor is
 * a claim nobody made, and nothing downstream can tell it from a real one.
 *
 * Enumerating the bad shapes is not the answer here and was tried: every new
 * shape a model writes is a new way through. Requiring the citation to say what
 * it is pointing at fails closed instead.
 */
export function citedFrames(span: string): number[] {
  // Emphasis is decoration a model wraps around anything, and it must not be
  // what decides whether a span is a list of numbers.
  const cleaned = span.replace(/[*_`]/g, ' ');
  const frames: number[] = [];
  const keep = (digits: string): void => {
    for (const number of digits.match(/\d+/g) ?? []) {
      const frame = Number.parseInt(number, 10);
      if (frame >= 1 && !frames.includes(frame)) frames.push(frame);
    }
  };
  if (NUMBER_LIST.test(cleaned)) {
    keep(cleaned);
    return frames;
  }
  for (const match of cleaned.matchAll(MARKED_CITATION)) {
    if (ownsItsNumbers(cleaned.slice((match.index ?? 0) + match[0].length))) keep(match[1]);
  }
  return frames;
}

/** Markdown emphasis around a claim is decoration, and it is not part of the claim. */
function unemphasised(text: string): string {
  return text.replace(/^[\s*_`]+/, '').replace(/[\s*_`]+$/, '');
}

/**
 * What the tester says is worth changing, read out of its reply.
 *
 * Nothing is added here. A reply with no BUG or IDEA line produces no
 * proposals, which is the answer a session on a game with nothing wrong with it
 * should give. `report.ts` decides which of these survive.
 */
export function parseProposals(text: string): TesterProposal[] {
  const out: TesterProposal[] = [];
  for (const line of text.split('\n')) {
    const match = PROPOSAL_LINE.exec(line);
    if (!match) continue;
    const body = unemphasised(match[3]);
    if (body === '') continue;
    out.push({
      kind: match[1].toUpperCase() === 'BUG' ? 'bug' : 'suggestion',
      text: body,
      evidence: citedFrames(match[2]),
    });
  }
  return out;
}

/** The things it could not work out, carried into the next session. */
export function parseQuestions(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^[^\S\n]*QUESTION[^\S\n]*:(.*)$/i.exec(line);
    const body = match?.[1].trim();
    if (body) out.push(body);
  }
  return out;
}

/**
 * The three answers the verdict question actually has.
 *
 * Narrower than `ChangeVerdict['verdict']` on purpose, and this is the type the
 * reader below answers in. The other three are not things a tester can say:
 * 'first-session' is forced by the loop when there is nothing to compare
 * against, 'unreadable' is a property of a file on disk, and 'unclear' is what
 * the CALLER records when this answers null. Keeping them out means a surface
 * mapping each answer to a sentence has to handle exactly these, and a missing
 * case is a type error rather than a silent fallback.
 */
export type StatedVerdict = 'better' | 'worse' | 'no-difference';

/** Words that turn the verdict word after them into its opposite, or into nothing. */
const NEGATED = /\b(?:not|never|no longer|hardly|barely|neither|nor|isn't|wasn't|aren't|doesn't|didn't)\b/;

/**
 * How far in front of the verdict word a negator still reaches, in words.
 *
 * "not better", "was not any better", "did not seem much better". Four covers
 * the way people actually write a denial and stops short of the width that put
 * this fault here in the first place, which was the whole clause.
 */
const NEGATION_REACH = 4;

/** "no difference" and its neighbours. */
const NO_DIFFERENCE = /\bno\b[^.]{0,20}\bdifference\b|\bunchanged\b|\bthe same\b|\bno change\b|\bnothing changed\b/g;

/** The words for getting worse, and for getting better. */
const WORSE = /\bworse\b|\bregress/g;
const BETTER = /\bbetter\b|\bimprov/g;

/**
 * Whether the verdict word starting at `index` is one a negator in front of it
 * denies.
 *
 * Scoped to the word, not to the clause, and that is the whole fix. Testing the
 * clause meant any negator anywhere in the sentence threw the verdict away, and
 * "never", "no longer" and "barely" are ordinary words in a sentence about a
 * bug that got FIXED: `VERDICT: much better now that it never crashes` was
 * recorded as no verdict at all, and the person was told "It did not give a
 * verdict on your last change" about a session that gave a clear one. That is
 * common rather than exotic, since a fixed bug is the usual reason to say
 * better.
 */
function deniedAt(clause: string, index: number): boolean {
  const before = clause.slice(0, index).trim();
  if (before === '') return false;
  return NEGATED.test(before.split(/\s+/).slice(-NEGATION_REACH).join(' '));
}

/** Whether this clause makes the claim `pattern` names, undenied. */
function claims(clause: string, pattern: RegExp): boolean {
  for (const match of clause.matchAll(pattern)) {
    if (!deniedAt(clause, match.index ?? 0)) return true;
  }
  return false;
}

/**
 * What one clause of the verdict line said, or null when it said none of the
 * three.
 *
 * A denied verdict word answers null rather than flipping: "not better" is not
 * a claim that things got worse, it is a refusal to say better, and inventing
 * the opposite would be the same fault in the other direction. What is denied
 * is the WORD, though, and never the whole clause: see `deniedAt`.
 *
 * Sameness used to be tested after the negation check, on the reasoning that
 * "no difference" carries a negator of its own. It does not: none of `no
 * difference`, `no change`, `nothing changed`, `unchanged` or `the same`
 * contains not, never, hardly, barely, neither or nor as a word. What the old
 * ordering did instead was make `VERDICT: not the same, it is better` come out
 * as "no real difference", the tester saying the change worked recorded as the
 * change doing nothing. Both of those readings are pinned as tests.
 */
function verdictInClause(clause: string): StatedVerdict | null {
  if (claims(clause, NO_DIFFERENCE)) return 'no-difference';
  if (claims(clause, WORSE)) return 'worse';
  if (claims(clause, BETTER)) return 'better';
  return null;
}

/**
 * The verdict the tester actually gave, or null when it gave none of the three.
 *
 * This used to be four ordered `test` calls against the whole line, with
 * `better` first, and that is a sentence-inverter. `VERDICT: not better, if
 * anything worse` contains the substring "better", so it was recorded as
 * better and rendered to the person as "That helped." The tester had said the
 * opposite. `mixed` and `I cannot tell` were both quietly recorded as
 * no-difference, which is a verdict nobody gave.
 *
 * So the line is cut into clauses and read in order, and the first clause that
 * makes one of the three claims wins. A line where no clause makes one answers
 * null, and the caller records that rather than picking a favourite.
 *
 * Exported because the live pane the person WATCHES has to say the same thing
 * this note will. It had its own copy of the ordered-substring version this
 * replaced, so it printed "the change helped" for `not better, if anything
 * worse` seconds before the note recorded "worse". Two readings of one reply is
 * one reading too many: there is one rule, and it is here.
 */
export function readVerdictWord(raw: string | null): StatedVerdict | null {
  if (!raw) return null;
  for (const clause of raw.toLowerCase().split(/[,;.()]|\bbut\b|\bthough\b|\bif\b|\bwhile\b|\bhowever\b/)) {
    const verdict = verdictInClause(clause);
    if (verdict) return verdict;
  }
  return null;
}

/**
 * The tester's verdict on the change, and its answer about regressions.
 *
 * An unanswered WORSE line becomes MISSING_REGRESSION rather than "nothing".
 * That difference is the whole point of the field: a note that fills in silence
 * with reassurance is a note that can only ever say the change was fine.
 *
 * A verdict line that says none of the three becomes 'unclear' rather than
 * no-difference. Falling back to one of the real answers is how "I cannot tell"
 * and "mixed" ended up on screen as a verdict the tester never gave.
 */
export function parseVerdict(text: string): { onTheChange: ChangeVerdict; regression: string } {
  const verdict = readVerdictWord(labelled(text, 'VERDICT'));
  const seen = labelled(text, 'CHANGE') ?? 'It did not say what it thought had changed.';
  const why = labelled(text, 'WHY') ?? MISSING_VERDICT_WHY;
  const worse = labelled(text, 'WORSE');
  return {
    onTheChange: verdict
      ? { seen, verdict, why }
      : { seen, verdict: 'unclear', why: UNCLEAR_VERDICT },
    regression: worse ?? MISSING_REGRESSION,
  };
}
