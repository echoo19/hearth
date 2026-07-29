/**
 * One session: the tester opens the game, plays it, and writes down what it
 * thinks.
 *
 * Hearth owns this loop rather than the chat agent. The app already drives a
 * browser, so it drives one here too and calls the model itself through the
 * same `ChatDriver` the conversation uses. That is what makes the tester work
 * for whichever agent the user configured, and why there is no second model
 * client anywhere in this feature.
 *
 * It is deliberately NOT a probe-core policy. `Policy.step()` is synchronous and
 * every turn here waits on a model, so the two could never have been the same
 * shape. Nothing under `packages/probe-core/src/policies/` is involved.
 *
 * The session always ends in a note, including when it crashed and including
 * when the person stopped it half way. A session that happened and left no
 * record is worse than one that recorded a failure.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ProbeState } from '@hearth/probe-core';
import type { ChatAttachment } from '../chatAttachments.js';
import { endsTurn, normalizeChatEvent, type ChatDriver, type ChatEvent } from '../chat.js';
import { changesSince } from './changes.js';
import {
  createSessionDir,
  framesDir,
  listSessions,
  nextSessionId,
  readMemory,
  writeMemory,
  writeNote,
  writeTranscript,
} from './memory.js';
import {
  decideFromReply,
  parseObservations,
  parseProposals,
  parseQuestions,
  parseVerdict,
  playPrompt,
  testerPrompts,
  howYouPlayed,
  MISSING_REGRESSION,
  REGRESSION_REMINDER,
  type TesterControls,
} from './prompt.js';
import {
  CRASHED_REGRESSION,
  type ChangeVerdict,
  type TesterNote,
  type TesterObservation,
  type TesterProposal,
} from './types.js';

/** The default step ceiling. Every turn is a model call on the user's own quota. */
export const DEFAULT_MAX_STEPS = 24;
/** The ceiling on the ceiling, so a hand-edited request cannot spend a fortune. */
export const MAX_MAX_STEPS = 60;

/** Where the session has got to, for whoever is watching it play. */
export type TesterPhase = 'opening' | 'playing' | 'reflecting' | 'writing' | 'finished';

/**
 * The one game surface this loop needs. Narrower than `GameUnderTest` on
 * purpose.
 *
 * `listStates` and `enterState` arrive together or not at all, and their
 * presence is the whole declaration: the adapter deletes them when the game
 * did not offer both, so there is nothing else to consult.
 */
export interface TesterGame {
  capabilities: { input: { actions: string[]; axes: string[]; pointer: boolean } };
  start(): Promise<void>;
  stop(): Promise<void>;
  step(): Promise<unknown>;
  setActionDown(name: string): Promise<void>;
  setActionUp(name: string): Promise<void>;
  setAxis(name: string, value: number): Promise<void>;
  sendPointer(x: number, y: number, kind: string): Promise<void>;
  /** The raw keyboard, when the adapter has one. See the contract for why. */
  setKeyDown?(key: string): Promise<void>;
  setKeyUp?(key: string): Promise<void>;
  screenshot?(): Promise<Uint8Array>;
  listStates?(): Promise<ProbeState[]>;
  enterState?(id: string): Promise<void>;
}

export interface RunTesterSessionOptions {
  /** Project root: where memory and the session folder live. */
  root: string;
  /** The game's directory, served to the tester's own browser. */
  dir: string;
  driver: ChatDriver;
  /** Hard step ceiling for this session. */
  maxSteps?: number;
  /** Every live picture of the tester's browser, for the pane. */
  onFrame?: (data: string) => void;
  /**
   * The tester's own words, as they arrive. `turn` counts the questions asked
   * of it, so a reader can tell one thought from the next: the text arrives in
   * fragments and nothing else in the stream says where one answer ends.
   */
  onThought?: (text: string, turn: number) => void;
  /** Where the session has got to. */
  onPhase?: (phase: TesterPhase) => void;
  /** The stop control. Honoured between turns and inside one. */
  signal?: AbortSignal;
  /** Test seam: stand in a game instead of launching Chromium. */
  openGame?: (opts: { dir: string; onFrame?: (data: string) => void }) => Promise<TesterGame>;
}

/** How last session's verdict is put to the tester, in words rather than a token. */
function describeVerdict(verdict: ChangeVerdict): string {
  switch (verdict.verdict) {
    case 'better':
      return `better, because ${verdict.why}`;
    case 'worse':
      return `worse, because ${verdict.why}`;
    case 'no-difference':
      return `no real difference, because ${verdict.why}`;
    case 'unclear':
      // Put back to the tester as the non-answer it was. Reporting it as one of
      // the three would anchor the next session on a verdict nobody gave.
      return 'not one of the three answers, so no verdict was recorded for that session';
    case 'unreadable':
      return 'something Hearth could not read back out of that session, so treat it as no verdict at all';
    default:
      return 'nothing, it was your first look at the game';
  }
}

/**
 * Ask the driver one thing and collect its prose.
 *
 * One iterator for the whole session, pulled turn by turn, so nothing else is
 * ever reading the same stream: two consumers would split a turn's text between
 * them. An approval request is denied on sight, because the thing that would
 * answer it is a person watching a conversation, and nobody is.
 */
function makeAsk(
  driver: ChatDriver,
  onThought?: (text: string, turn: number) => void,
  signal?: AbortSignal,
): (text: string, attachments?: ChatAttachment[]) => Promise<string> {
  const events = driver.events[Symbol.asyncIterator]();
  let interrupted = false;
  let turn = 0;
  return async function ask(text: string, attachments?: ChatAttachment[]): Promise<string> {
    turn += 1;
    driver.send(text, undefined, attachments);
    let reply = '';
    for (;;) {
      const next = await events.next();
      if (next.done) break;
      const event = normalizeChatEvent(next.value as ChatEvent);
      if (event.type === 'message-delta') {
        reply += event.text;
        onThought?.(event.text, turn);
      } else if (event.type === 'approval-request') {
        driver.approve?.(event.approvalId, 'deny');
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
      if (endsTurn(event)) break;
      // Asked to stop mid-turn: end the turn if the backend can, then keep
      // draining until it does end. Abandoning the iterator here would leave
      // this turn's tail to be read as the next turn's answer.
      if (signal?.aborted && !interrupted) {
        interrupted = true;
        driver.interrupt?.();
      }
    }
    return reply;
  };
}

/**
 * Keys that have a written name of their own, lower-cased for lookup.
 *
 * Every entry is a key's OWN name, and the aliases are spellings of that same
 * name rather than meanings: `esc` for Escape, `uparrow` for ArrowUp. There is
 * deliberately no entry mapping an idea to a key, so nothing here can turn
 * `jump` into Space or `fire` into Control.
 */
const NAMED_KEYS = new Map<string, string>(
  (
    [
      ['enter', 'Enter'],
      ['return', 'Enter'],
      ['space', 'Space'],
      ['spacebar', 'Space'],
      ['escape', 'Escape'],
      ['esc', 'Escape'],
      ['tab', 'Tab'],
      ['backspace', 'Backspace'],
      ['delete', 'Delete'],
      ['del', 'Delete'],
      ['insert', 'Insert'],
      ['ins', 'Insert'],
      ['home', 'Home'],
      ['end', 'End'],
      ['pageup', 'PageUp'],
      ['pgup', 'PageUp'],
      ['pagedown', 'PageDown'],
      ['pgdn', 'PageDown'],
      ['arrowup', 'ArrowUp'],
      ['uparrow', 'ArrowUp'],
      ['arrowdown', 'ArrowDown'],
      ['downarrow', 'ArrowDown'],
      ['arrowleft', 'ArrowLeft'],
      ['leftarrow', 'ArrowLeft'],
      ['arrowright', 'ArrowRight'],
      ['rightarrow', 'ArrowRight'],
      ['shift', 'Shift'],
      ['control', 'Control'],
      ['ctrl', 'Control'],
      ['alt', 'Alt'],
      ['meta', 'Meta'],
      ['capslock', 'CapsLock'],
    ] as [string, string][]
  ).concat(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`] as [string, string])),
);

/**
 * The key a name asks for, or null when the name is not a key at all.
 *
 * The rule, and it is the whole rule: a name becomes a key only when it is
 * ALREADY a key's name. One printable character is that character's key, upper
 * cased because `r` and `R` are one physical key. A longer name has to match a
 * key that has a written name, spelling variants allowed. Everything else is a
 * word for an idea and gets nothing.
 *
 * That is why `R`, `1`, `/`, `Space` and `ArrowLeft` all arrive at the game and
 * `jump`, `shoot`, `restart` and `pause` do not. Sending `jump` would mean
 * picking a key for it, and there is no key for jump: it is Space in a platform
 * game, Z in another, A on a pad, and nothing at all in a game with no jumping.
 * The moment this function held a table like that, Hearth would be telling the
 * person what kind of game they are allowed to have written. So it declines,
 * and the caller says out loud that it declined.
 */
export function keyForInputName(name: string): string | null {
  const raw = name.trim();
  if (raw === '') return null;
  const characters = [...raw];
  if (characters.length === 1) {
    const only = characters[0];
    // A control character is not something anyone can be shown on screen.
    if (only.codePointAt(0)! < 0x20) return null;
    return only.toUpperCase();
  }
  // Spaces, hyphens and underscores are how the same key name gets written
  // differently, not different keys: "page up", "page-up" and "PageUp" are one.
  return NAMED_KEYS.get(raw.toLowerCase().replace(/[\s_-]+/g, '')) ?? null;
}

/** Why the game never saw something, in the second person, for the tester. */
function why(err: unknown): string {
  const message = (err as Error)?.message;
  return message && message.trim() !== '' ? message.trim() : 'the game gave no reason';
}

/** What one turn's decision did, for the loop and the transcript. */
interface Applied {
  /** False when the tester said it had seen enough. */
  keepPlaying: boolean;
  /** The state the game really was put into, when it was asked and agreed. */
  entered?: ProbeState;
  /** What the game said when it was asked and could not. */
  enterFailed?: string;
  /**
   * Everything the tester asked for that the game never received, one sentence
   * each, addressed to the tester and shown to it on its next turn.
   *
   * This list is the difference between "I pressed it and the game did nothing"
   * and "my press was thrown away before it got there". A tester that cannot
   * tell those apart writes the first one down as a finding about someone's
   * game, which is exactly what happened: it asked for R, R went nowhere, and
   * it reported the game as stuck.
   */
  undelivered: string[];
}

/**
 * What is currently pressed, and how long each of it is meant to stay that way.
 *
 * The two lifetimes are the point. A held input stays down across the picture
 * the tester looks at next, so it sees the game while it is being driven; a
 * tapped one is let go the moment its step is over, so the next picture shows
 * what the game did with a press and then settled into. Keeping them in
 * separate sets is what lets both be true at once, and lets a turn that taps
 * one input while holding another mean exactly that.
 */
interface Holds {
  actions: Set<string>;
  keys: Set<string>;
  axes: Set<string>;
  tapActions: Set<string>;
  tapKeys: Set<string>;
  tapAxes: Set<string>;
}

function newHolds(): Holds {
  return {
    actions: new Set(),
    keys: new Set(),
    axes: new Set(),
    tapActions: new Set(),
    tapKeys: new Set(),
    tapAxes: new Set(),
  };
}

/**
 * Which inputs were tapped and which were leaned on, over the whole session.
 *
 * Kept so the tester can be shown its own record before it says what is worth
 * changing. See `howYouPlayed` in prompt.ts for why that is worth a paragraph.
 */
interface Usage {
  tapped: Set<string>;
  held: Set<string>;
}

/** Play one turn's decision into the game. */
async function applyDecision(
  game: TesterGame,
  reply: string,
  holds: Holds,
  usage: Usage,
  states: readonly ProbeState[],
): Promise<Applied> {
  const decision = decideFromReply(reply);
  const undelivered: string[] = [];
  const { actions: held, keys: heldKeys, axes: heldAxes } = holds;
  // Whatever was held last turn is released first: a tester that says "right"
  // then "left" means it changed its mind, not that it is holding both.
  for (const name of held) await game.setActionUp(name).catch(() => {});
  held.clear();
  for (const key of heldKeys) await game.setKeyUp?.(key).catch(() => {});
  heldKeys.clear();
  // Axes were the one input that was never let go. There is no setAxisUp, so
  // an axis driven to 1 stayed at 1 forever: the tester asked to go right once,
  // and the game went on going right through every turn after it, including
  // the turns where the tester asked for nothing at all. Every observation
  // after that first one was of a game being driven by a request the tester
  // had already stopped making, and it had no way to know.
  for (const name of heldAxes) await game.setAxis(name, 0).catch(() => {});
  heldAxes.clear();

  if (decision.kind === 'done') return { keepPlaying: false, undelivered };
  if (decision.kind === 'enter') {
    const wanted = states.find((state) => state.id === decision.id);
    if (!wanted) {
      return {
        keepPlaying: true,
        undelivered: [
          `You asked to be put into "${decision.id}", and this game never named anywhere by that id, so nothing moved. You are where you were.`,
        ],
      };
    }
    if (!game.enterState) {
      return {
        keepPlaying: true,
        undelivered: ['You asked to be put somewhere, and this game cannot be put anywhere, so nothing moved.'],
      };
    }
    try {
      await game.enterState(wanted.id);
      return { keepPlaying: true, entered: wanted, undelivered };
    } catch (err) {
      // The game refused. That is worth writing down and is not worth ending a
      // session over: the tester is still where it was and can carry on.
      return { keepPlaying: true, enterFailed: (err as Error).message, undelivered };
    }
  }
  if (decision.kind === 'actions' || decision.kind === 'tap') {
    // One path presses; only where the name is remembered differs, and that is
    // what decides whether it is still down when the next picture is taken.
    const sustained = decision.kind === 'actions';
    const intoAxes = sustained ? heldAxes : holds.tapAxes;
    const intoActions = sustained ? held : holds.tapActions;
    const intoKeys = sustained ? heldKeys : holds.tapKeys;
    const verb = sustained ? 'holding' : 'tapping';
    for (const name of decision.actions) {
      if (game.capabilities.input.axes.includes(name)) {
        try {
          await game.setAxis(name, 1);
          intoAxes.add(name);
          (sustained ? usage.held : usage.tapped).add(name);
        } catch (err) {
          undelivered.push(`"${name}" is an axis this game declared, and driving it failed: ${why(err)}.`);
        }
        continue;
      }
      if (game.capabilities.input.actions.includes(name)) {
        try {
          await game.setActionDown(name);
          intoActions.add(name);
          (sustained ? usage.held : usage.tapped).add(name);
        } catch (err) {
          undelivered.push(`"${name}" is an input this game declared, and ${verb} it failed: ${why(err)}.`);
        }
        continue;
      }

      // The line that used to be here read "An input the game never declared is
      // ignored rather than guessed at", and it looked principled while doing
      // real damage. The declared list is what Hearth could INFER about a game.
      // Games say their own controls on screen, so a game printing "R to
      // restart" and declaring only left, right and jump is normal, not broken.
      // The tester read that screen, asked for R, and R was dropped on the
      // floor in silence. It then concluded the game was stuck and wrote that
      // down about somebody's game.
      //
      // Two things had to change and both are here. A name that is already a
      // key goes to the real keyboard, because refusing to press a key a game
      // asked for is Hearth deciding which inputs a game is allowed to have. A
      // name that is not a key, or a key nobody can send, is SAID rather than
      // swallowed, because the only thing worse than dropping an input is
      // dropping it quietly.
      const key = keyForInputName(name);
      if (key === null) {
        undelivered.push(
          `"${name}" never reached the game: it is not an input this game declared and it is not the name of a key, so there was nothing to press. If the game tells you what to press, name that key exactly, like R or Space or ArrowLeft.`,
        );
        continue;
      }
      if (!game.setKeyDown) {
        undelivered.push(
          `"${name}" never reached the game: this game did not declare it, and no keys can be sent to this game beyond the ones it declared.`,
        );
        continue;
      }
      try {
        await game.setKeyDown(key);
        intoKeys.add(key);
        (sustained ? usage.held : usage.tapped).add(key);
      } catch (err) {
        undelivered.push(`The ${key} key could not be pressed: ${why(err)}.`);
      }
    }
  } else if (decision.kind === 'pointer') {
    if (!game.capabilities.input.pointer) {
      undelivered.push('Your pointer line never reached the game: this game declared no pointer at all.');
    } else {
      try {
        await game.sendPointer(decision.x, decision.y, decision.click ? 'click' : 'move');
      } catch (err) {
        undelivered.push(`Your pointer line could not be sent: ${why(err)}.`);
      }
    }
  }
  return { keepPlaying: true, undelivered };
}

/** The session's frames, written as it plays, so its claims have something behind them. */
async function saveFrame(dir: string, index: number, bytes: Uint8Array): Promise<void> {
  await fsp.writeFile(path.join(dir, `${String(index).padStart(4, '0')}.png`), bytes);
}

function attachmentFor(root: string, file: string, bytes: number): ChatAttachment {
  return {
    name: path.basename(file),
    mimeType: 'image/png',
    path: file,
    relPath: path.relative(root, file).split(path.sep).join('/'),
    bytes,
  };
}

/**
 * Play one session and write it down.
 *
 * Resolves with the note it wrote, in every ending: done, out of budget,
 * stopped, or crashed.
 */
export async function runTesterSession(opts: RunTesterSessionOptions): Promise<TesterNote> {
  const { root, dir, driver, onFrame, onThought, onPhase, signal } = opts;
  const maxSteps = Math.max(1, Math.min(opts.maxSteps ?? DEFAULT_MAX_STEPS, MAX_MAX_STEPS));
  const startedAt = new Date().toISOString();

  const past = await listSessions(root);
  const previous = past.length > 0 ? past[past.length - 1] : null;
  const changes = await changesSince(root, previous?.finishedAt ?? null);
  const memory = await readMemory(root);
  const [briefing, observePrompt, comparePrompt, planPrompt, rememberPrompt] = testerPrompts({
    memory,
    changes,
    lastVerdict: previous ? describeVerdict(previous.onTheChange) : null,
  });

  const session = await nextSessionId(root);
  await createSessionDir(root, session);
  const frames = framesDir(root, session);
  const ask = makeAsk(driver, onThought, signal);
  const transcript: string[] = [`# Session ${session}`, '', `Started ${startedAt}.`, ''];

  /** How it played, read back to it before it says what is worth changing. */
  const usage: Usage = { tapped: new Set(), held: new Set() };

  let stopped: TesterNote['stopped'] = 'done';
  let steps = 0;
  let frameCount = 0;
  let crash: Error | null = null;
  let game: TesterGame | null = null;
  let states: ProbeState[] = [];
  /** The first picture taken after the game put the tester somewhere. */
  let placedFromFrame: number | null = null;
  /** What the game called the first place it actually put the tester. */
  let enteredLabel: string | null = null;

  onPhase?.('opening');
  try {
    const open =
      opts.openGame ??
      (async (options): Promise<TesterGame> => {
        // The import is spoken for separately from the call because the two
        // fail for completely different reasons and the note only ever shows
        // one sentence. A game that will not open is about the game; a browser
        // adapter that will not even load is about this build of Hearth, and
        // the person reading the note is entitled to know which one they are
        // looking at instead of being handed whatever the failure said.
        const adapter = await import('@hearth/adapter-web').catch((err: unknown) => {
          const reason = (err as Error)?.message?.trim();
          throw new Error(
            `Hearth could not load the browser its tester plays games in, so your game was never opened. This is a fault in Hearth rather than in your game. ${reason || 'No reason was given.'}`,
          );
        });
        return (await adapter.openWebGame({ dir: options.dir, onFrame: options.onFrame })) as unknown as TesterGame;
      });
    game = await open({ dir, onFrame });
    await game.start();

    const controls: TesterControls = {
      actions: game.capabilities.input.actions,
      axes: game.capabilities.input.axes,
      pointer: game.capabilities.input.pointer,
      // Whether the tester may name a key the game never declared. Read off the
      // adapter rather than assumed, so the offer is never made to a tester
      // whose keypress would have nowhere to go.
      keys: typeof game.setKeyDown === 'function',
    };
    const holds = newHolds();

    // What the game says it can put itself into, in its own words. A game that
    // offers nothing is not asked again and is never told about the idea.
    if (game.listStates && game.enterState) {
      try {
        states = await game.listStates();
      } catch {
        // A hook that throws leaves the capability unavailable for this
        // session, which is the same answer as never having offered it.
        states = [];
      }
    }

    onPhase?.('playing');
    /** What the last turn asked for and never got, carried into this turn's prompt. */
    let undelivered: string[] = [];
    for (let turn = 1; turn <= maxSteps; turn += 1) {
      if (signal?.aborted) {
        stopped = 'user';
        break;
      }
      let attachments: ChatAttachment[] | undefined;
      /**
       * The picture the tester is looking at this turn, or null when there is
       * none. Null and a number are different situations and the prompt says
       * which: a turn with no picture is a turn the tester must not write
       * observations about.
       */
      let picture: number | null = null;
      if (game.screenshot) {
        try {
          const bytes = await game.screenshot();
          // Written to disk BEFORE the counter moves. The other order left
          // `frames` counting a picture that a failed write had never put in
          // the folder, and every reader treats that count as the number of
          // files that exist.
          const next = frameCount + 1;
          await saveFrame(frames, next, bytes);
          frameCount = next;
          picture = next;
          attachments = [
            attachmentFor(root, path.join(frames, `${String(frameCount).padStart(4, '0')}.png`), bytes.byteLength),
          ];
        } catch {
          // No picture this turn. The tester is told what it can do and asked
          // anyway, rather than the session ending over one missed frame.
        }
      }
      // Numbered by PICTURE, never by turn. The prompt used to say "Picture 5"
      // on turn five while attaching 0004.png, because a failed screenshot
      // costs a turn its picture and the frame counter had not moved. The
      // tester then cited picture 5, and the citation was checked against the
      // frame count and dropped as a picture nobody took. Both ends of that
      // are the same number now.
      const prompt = playPrompt(turn, maxSteps, controls, states, undelivered, picture);
      const reply = await ask(turn === 1 ? `${briefing}\n\n${prompt}` : prompt, attachments);
      transcript.push(`## Picture ${frameCount}`, '', reply.trim(), '');
      steps = turn;
      const applied = await applyDecision(game, reply, holds, usage, states);
      undelivered = applied.undelivered;
      // In the transcript as well as in the next prompt. A reader working out
      // why the tester said a game was stuck needs to see what never arrived.
      for (const line of undelivered) transcript.push(line, '');
      if (applied.entered) {
        // The next picture is the first one taken of somewhere the tester was
        // put rather than got to. Everything from there is marked placed, and
        // a second placement does not move the line back.
        placedFromFrame ??= frameCount + 1;
        enteredLabel ??= applied.entered.label;
        transcript.push(`It asked to be put into ${applied.entered.label}, and the game did.`, '');
      } else if (applied.enterFailed) {
        transcript.push(`It asked to be put somewhere and the game could not: ${applied.enterFailed}`, '');
      }
      if (!applied.keepPlaying) break;
      await game.step();
      // A tap is over the moment its step is. Let go here rather than at the
      // top of the next decision, which is where a HOLD is let go, so the next
      // picture shows the game after a press instead of during one. That
      // difference is the entire reason the two verbs exist.
      for (const name of holds.tapActions) await game.setActionUp(name).catch(() => {});
      holds.tapActions.clear();
      for (const key of holds.tapKeys) await game.setKeyUp?.(key).catch(() => {});
      holds.tapKeys.clear();
      for (const name of holds.tapAxes) await game.setAxis(name, 0).catch(() => {});
      holds.tapAxes.clear();
      if (turn === maxSteps) stopped = 'budget';
      if (signal?.aborted) {
        stopped = 'user';
        break;
      }
    }
    for (const name of [...holds.actions, ...holds.tapActions]) await game.setActionUp(name).catch(() => {});
    for (const key of [...holds.keys, ...holds.tapKeys]) await game.setKeyUp?.(key).catch(() => {});
    for (const name of [...holds.axes, ...holds.tapAxes]) await game.setAxis(name, 0).catch(() => {});
  } catch (err) {
    crash = err as Error;
    stopped = 'error';
  } finally {
    await game?.stop().catch(() => {});
  }

  let observations: TesterObservation[] = [];
  let proposals: TesterProposal[] = [];
  let openQuestions: string[] = [];
  // 'unclear' rather than 'no-difference', which is a verdict. A session that
  // crashed before it played gave none, and the default put "It says your last
  // change made no real difference" on the history for a game it never opened.
  let onTheChange: ChangeVerdict = {
    seen: 'It did not get far enough to say.',
    verdict: 'unclear',
    why: crash
      ? `The session ended early and it never gave a verdict: ${crash.message}`
      : 'The session ended before it could say.',
  };
  // The crash message used to go in here, and it read as an answer: it is
  // neither empty nor a sentinel, so `regressionSentence` said the tester had
  // looked and every surface then showed a stack trace as its answer about
  // whether anything got worse. The reason is on the verdict above, which is
  // where a reader looks for what went wrong; this field says only that nothing
  // was recorded, which is the true thing to say.
  let regression = crash ? CRASHED_REGRESSION : MISSING_REGRESSION;
  /** Whether the tester got as far as answering the verdict question at all. */
  let verdictGiven = false;

  // A crashed session is written down, not asked about. There is nothing it
  // could honestly say about a game it never got to play.
  if (!crash) {
    try {
      onPhase?.('reflecting');
      const seenReply = await ask(observePrompt);
      transcript.push('## What it saw', '', seenReply.trim(), '');
      observations = parseObservations(seenReply, frameCount, placedFromFrame);
      openQuestions = parseQuestions(seenReply);

      // Only now is it shown its own previous verdict. Everything above is
      // already committed, which is what stops it anchoring on its own praise.
      let verdictReply = await ask(comparePrompt);
      let parsed = parseVerdict(verdictReply);
      if (parsed.regression === MISSING_REGRESSION) {
        // Asked once more, because "did anything get worse" answered by silence
        // is the failure mode this whole field exists to prevent.
        const again = await ask(REGRESSION_REMINDER);
        verdictReply = `${verdictReply}\n${again}`;
        parsed = parseVerdict(verdictReply);
      }
      transcript.push('## Its verdict', '', verdictReply.trim(), '');
      onTheChange = parsed.onTheChange;
      regression = parsed.regression;
      verdictGiven = true;

      // The record of how it played rides with the question it could get wrong
      // by forgetting, and only when there is something in it to say.
      const record = howYouPlayed({ tapped: [...usage.tapped], held: [...usage.held] });
      const planReply = await ask(record === '' ? planPrompt : `${planPrompt}\n\n${record}`);
      transcript.push('## What it would change', '', planReply.trim(), '');
      proposals = parseProposals(planReply);

      onPhase?.('writing');
      const nextMemory = await ask(rememberPrompt);
      if (nextMemory.trim() !== '') await writeMemory(root, `${nextMemory.trim()}\n`);
    } catch (err) {
      // The play happened; only the writing up failed. Keep the session and say
      // what went wrong in it.
      crash = err as Error;
      stopped = 'error';
      // Only when the tester never got to answer. This used to overwrite the
      // reason unconditionally while leaving the verdict standing, which is how
      // "It says your last change helped, because ENOENT: ..." was reachable:
      // a crash in the step AFTER the verdict rewrote the tester's own words
      // with an error message and left the claim attached to it.
      if (!verdictGiven) {
        onTheChange = {
          seen: onTheChange.seen,
          verdict: onTheChange.verdict,
          why: `The session ended early and it never gave a verdict: ${crash.message}`,
        };
        // The regression answer is only ever assigned beside the verdict, so
        // reaching here means none was recorded. It says the session ended
        // early rather than blaming the tester for not answering.
        regression = CRASHED_REGRESSION;
      }
    }
  }

  // A first session has nothing to compare against. Forced here rather than
  // asked for, so no first note can ever claim a verdict on a change it never
  // saw the before-state of.
  if (!previous) {
    onTheChange = {
      seen: onTheChange.seen,
      verdict: 'first-session',
      why: crash ? onTheChange.why : 'This was my first look at this game, so there is nothing to compare it with.',
    };
  }

  const note: TesterNote = {
    session,
    startedAt,
    finishedAt: new Date().toISOString(),
    onTheChange,
    regression,
    observations,
    // Written every session, including the sessions where the answer is that
    // the game named nowhere. A game that cooperates with nothing is a
    // first-class outcome, and the report is where it gets said out loud.
    // Where the placement line fell, written down rather than left to be
    // recovered from the observations later. The recovery could only see
    // pictures the tester wrote a SAW line about, so a session that was placed
    // at picture four and wrote about pictures one to three recovered nothing,
    // and every later picture was then reported as reached by playing.
    ...(placedFromFrame === null ? {} : { placedFrom: placedFromFrame }),
    placement: { offered: states.length, ...(enteredLabel === null ? {} : { entered: enteredLabel }) },
    proposals,
    openQuestions,
    steps,
    // Written down rather than inferred from the turn count later: a turn whose
    // screenshot failed took no picture, and the plan of action uses this to
    // tell a claim about a picture from a claim about a picture nobody took.
    frames: frameCount,
    stopped,
  };
  await writeNote(root, note);
  await writeTranscript(root, session, `${transcript.join('\n')}\n`);
  onPhase?.('finished');
  return note;
}
