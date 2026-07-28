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
import type { ChangeVerdict, TesterObservation } from './types.js';

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
 * The four prompts of a session, in the order they are sent: settle in, then
 * write down this session, then compare with last time, then rewrite memory.
 * The play turns happen between the first and the second.
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

  const remember = [
    'Last thing. Rewrite what you know about this game, for yourself to read next time.',
    '',
    'Plain markdown, short, and written so the person who owns this game could read it and',
    'correct anything you got wrong. Keep what is still true, add what you learned, drop what',
    'you now know was wrong. Reply with the markdown and nothing else.',
  ].join('\n');

  return [briefing, observe, compare, remember];
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

/** What the tester is shown with each frame. Short: the picture is the message. */
export function playPrompt(
  step: number,
  maxSteps: number,
  controls: TesterControls,
  states: readonly ProbeState[] = [],
): string {
  const left = maxSteps - step + 1;
  const inputs = controls.actions.length > 0 ? controls.actions.join(', ') : 'none detected';
  const axes = controls.axes.length > 0 ? `\nAxes you can drive: ${controls.axes.join(', ')}.` : '';
  const pointer = controls.pointer ? '\nYou can also click anywhere in the picture.' : '';
  const offer = statesOffer(step, states);
  const closing =
    states.length > 0
      ? 'One sentence, then one ACTION, CLICK, MOVE, ENTER or DONE line.'
      : 'One sentence, then one ACTION, CLICK, MOVE or DONE line.';
  return [
    `Picture ${step}. You have ${left} ${left === 1 ? 'turn' : 'turns'} left.`,
    `Inputs you can hold: ${inputs}.${axes}${pointer}${offer}`,
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

function readVerdictWord(raw: string | null): ChangeVerdict['verdict'] | null {
  if (!raw) return null;
  const word = raw.toLowerCase();
  if (/\bbetter\b|\bimprov/.test(word)) return 'better';
  if (/\bworse\b/.test(word)) return 'worse';
  if (/no.?difference|\bsame\b|unchanged/.test(word)) return 'no-difference';
  return null;
}

/**
 * The tester's verdict on the change, and its answer about regressions.
 *
 * An unanswered WORSE line becomes MISSING_REGRESSION rather than "nothing".
 * That difference is the whole point of the field: a note that fills in silence
 * with reassurance is a note that can only ever say the change was fine.
 */
export function parseVerdict(text: string): { onTheChange: ChangeVerdict; regression: string } {
  const verdict = readVerdictWord(labelled(text, 'VERDICT'));
  const seen = labelled(text, 'CHANGE') ?? 'It did not say what it thought had changed.';
  const why = labelled(text, 'WHY') ?? MISSING_VERDICT_WHY;
  const worse = labelled(text, 'WORSE');
  return {
    onTheChange: { seen, verdict: verdict ?? 'no-difference', why: verdict ? why : MISSING_VERDICT_WHY },
    regression: worse ?? MISSING_REGRESSION,
  };
}
