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
  MISSING_REGRESSION,
  REGRESSION_REMINDER,
  type TesterControls,
} from './prompt.js';
import type { ChangeVerdict, TesterNote, TesterObservation, TesterProposal } from './types.js';

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

/** What one turn's decision did, for the loop and the transcript. */
interface Applied {
  /** False when the tester said it had seen enough. */
  keepPlaying: boolean;
  /** The state the game really was put into, when it was asked and agreed. */
  entered?: ProbeState;
  /** What the game said when it was asked and could not. */
  enterFailed?: string;
}

/** Play one turn's decision into the game. */
async function applyDecision(
  game: TesterGame,
  reply: string,
  held: Set<string>,
  states: readonly ProbeState[],
): Promise<Applied> {
  const decision = decideFromReply(reply);
  // Whatever was held last turn is released first: a tester that says "right"
  // then "left" means it changed its mind, not that it is holding both.
  for (const name of held) await game.setActionUp(name).catch(() => {});
  held.clear();

  if (decision.kind === 'done') return { keepPlaying: false };
  if (decision.kind === 'enter') {
    // Only a state the game itself named. An id nobody declared is ignored
    // rather than sent on, the same way an undeclared input is.
    const wanted = states.find((state) => state.id === decision.id);
    if (!wanted || !game.enterState) return { keepPlaying: true };
    try {
      await game.enterState(wanted.id);
      return { keepPlaying: true, entered: wanted };
    } catch (err) {
      // The game refused. That is worth writing down and is not worth ending a
      // session over: the tester is still where it was and can carry on.
      return { keepPlaying: true, enterFailed: (err as Error).message };
    }
  }
  if (decision.kind === 'actions') {
    for (const name of decision.actions) {
      const known = game.capabilities.input.actions.includes(name);
      const axis = game.capabilities.input.axes.includes(name);
      if (axis) {
        await game.setAxis(name, 1).catch(() => {});
      } else if (known) {
        await game.setActionDown(name).catch(() => {});
        held.add(name);
      }
      // An input the game never declared is ignored rather than guessed at.
    }
  } else if (decision.kind === 'pointer' && game.capabilities.input.pointer) {
    await game.sendPointer(decision.x, decision.y, decision.click ? 'click' : 'move').catch(() => {});
  }
  return { keepPlaying: true };
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

  let stopped: TesterNote['stopped'] = 'done';
  let steps = 0;
  let frameCount = 0;
  let crash: Error | null = null;
  let game: TesterGame | null = null;
  let states: ProbeState[] = [];
  /** The first picture taken after the game put the tester somewhere. */
  let placedFromFrame: number | null = null;

  onPhase?.('opening');
  try {
    const open =
      opts.openGame ??
      (async (options): Promise<TesterGame> => {
        const { openWebGame } = await import('@hearth/adapter-web');
        return (await openWebGame({ dir: options.dir, onFrame: options.onFrame })) as unknown as TesterGame;
      });
    game = await open({ dir, onFrame });
    await game.start();

    const controls: TesterControls = {
      actions: game.capabilities.input.actions,
      axes: game.capabilities.input.axes,
      pointer: game.capabilities.input.pointer,
    };
    const held = new Set<string>();

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
    for (let turn = 1; turn <= maxSteps; turn += 1) {
      if (signal?.aborted) {
        stopped = 'user';
        break;
      }
      let attachments: ChatAttachment[] | undefined;
      if (game.screenshot) {
        try {
          const bytes = await game.screenshot();
          frameCount += 1;
          await saveFrame(frames, frameCount, bytes);
          attachments = [
            attachmentFor(root, path.join(frames, `${String(frameCount).padStart(4, '0')}.png`), bytes.byteLength),
          ];
        } catch {
          // No picture this turn. The tester is told what it can do and asked
          // anyway, rather than the session ending over one missed frame.
        }
      }
      const prompt = playPrompt(turn, maxSteps, controls, states);
      const reply = await ask(turn === 1 ? `${briefing}\n\n${prompt}` : prompt, attachments);
      transcript.push(`## Picture ${frameCount}`, '', reply.trim(), '');
      steps = turn;
      const applied = await applyDecision(game, reply, held, states);
      if (applied.entered) {
        // The next picture is the first one taken of somewhere the tester was
        // put rather than got to. Everything from there is marked placed, and
        // a second placement does not move the line back.
        placedFromFrame ??= frameCount + 1;
        transcript.push(`It asked to be put into ${applied.entered.label}, and the game did.`, '');
      } else if (applied.enterFailed) {
        transcript.push(`It asked to be put somewhere and the game could not: ${applied.enterFailed}`, '');
      }
      if (!applied.keepPlaying) break;
      await game.step();
      if (turn === maxSteps) stopped = 'budget';
      if (signal?.aborted) {
        stopped = 'user';
        break;
      }
    }
    for (const name of held) await game.setActionUp(name).catch(() => {});
  } catch (err) {
    crash = err as Error;
    stopped = 'error';
  } finally {
    await game?.stop().catch(() => {});
  }

  let observations: TesterObservation[] = [];
  let proposals: TesterProposal[] = [];
  let openQuestions: string[] = [];
  let onTheChange: ChangeVerdict = {
    seen: 'It did not get far enough to say.',
    verdict: 'no-difference',
    why: crash ? crash.message : 'The session ended before it could say.',
  };
  let regression = crash ? `The session ended early: ${crash.message}` : MISSING_REGRESSION;

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

      const planReply = await ask(planPrompt);
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
      onTheChange = { seen: onTheChange.seen, verdict: onTheChange.verdict, why: crash.message };
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
    proposals,
    openQuestions,
    steps,
    stopped,
  };
  await writeNote(root, note);
  await writeTranscript(root, session, `${transcript.join('\n')}\n`);
  onPhase?.('finished');
  return note;
}
