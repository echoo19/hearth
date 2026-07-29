// @vitest-environment jsdom
/**
 * Watching the tester play.
 *
 * The point of this surface is that a person can see what their tester is
 * doing while it does it. So these pin the four things that makes it that
 * rather than a progress bar: the picture is on screen, the thinking arrives
 * beside it in the order it was thought, the way to stop exists for exactly as
 * long as there is something to stop, and a folder whose tester has never
 * played is invited rather than shown an empty log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiTesterPlay: vi.fn(),
  apiTesterStop: vi.fn(),
  apiTesterHistory: vi.fn(),
}));

import { apiTesterStop } from '../src/api';
import {
  TesterStage,
  readableThought,
  testerEndingLine,
  testerTurnLine,
  whyNoPlay,
} from '../src/components/tester/TesterStage';
import { useApp } from '../src/store';
import { resetProbeStream } from '../src/probeStream';
import type { TesterState } from '../src/store';
import type { TesterNote } from '../server/tester/types';

const PROJECT = '/work/game';

const IDLE: TesterState = {
  running: false,
  starting: false,
  session: null,
  phase: null,
  maxSteps: 0,
  thoughts: [],
  lastNote: null,
  error: null,
  sessions: [],
  memory: '',
  historyLoaded: true,
};

function note(over: Partial<TesterNote> = {}): TesterNote {
  return {
    session: 3,
    startedAt: '2026-07-27T10:00:00.000Z',
    finishedAt: '2026-07-27T10:12:00.000Z',
    onTheChange: { seen: 'you raised the jump', verdict: 'better', why: 'I cleared the gap' },
    regression: 'nothing',
    observations: [],
    openQuestions: [],
    proposals: [],
    steps: 12,
    frames: 12,
    stopped: 'done',
    ...over,
  };
}

function seed(tester: Partial<TesterState>): void {
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'game',
    game: { present: true, entry: 'index.html', mtime: 1 },
    // Somebody looked, and this is what they found. Stated rather than
    // implied: `game.present` alone cannot tell an empty folder from an
    // unanswered question, which is what `gameKnown` exists to say.
    gameKnown: true,
    tester: { ...IDLE, ...tester },
  });
}

beforeEach(() => {
  seed({});
});

afterEach(() => {
  cleanup();
  resetProbeStream();
  vi.clearAllMocks();
});

describe('readableThought', () => {
  it('drops the instructions the tester sends the loop', () => {
    // "ACTION: right, jump" is addressed to the play loop. The person watching
    // sees what it did in the picture beside the column.
    expect(readableThought('I will jump the gap.\nACTION: right, jump')).toBe('I will jump the gap.');
    expect(readableThought('Seen enough.\nDONE')).toBe('Seen enough.');
  });

  it('turns a bare verdict token into a sentence', () => {
    expect(readableThought('VERDICT: no-difference')).toMatch(/no real difference/i);
    expect(readableThought('VERDICT: better')).toMatch(/helped/i);
  });

  it('never turns a negated verdict into the verdict it denies', () => {
    // This is the surface the person is WATCHING, and it used to print "the
    // change helped" for a reply that said the opposite, seconds before the
    // note recorded "worse". One rule, read from one place, or the pane and
    // the note drift apart again.
    expect(readableThought('VERDICT: not better, if anything worse')).toBe(
      'Its verdict: the change made things worse.',
    );
    expect(readableThought('VERDICT: not the same, it is better')).toBe(
      'Its verdict: the change helped.',
    );
  });

  it('says the tester gave no verdict rather than choosing one for it', () => {
    // "mixed" and "I cannot tell" are not "no real difference". The note calls
    // this unclear, and so must the pane.
    for (const answer of ['mixed', 'I cannot tell', 'hard to say']) {
      expect(readableThought(`VERDICT: ${answer}`), answer).toBe('Its verdict: it did not give one.');
    }
  });

  it('says which picture a claim is about, in words', () => {
    expect(readableThought('SAW 3: The player fell in the pit')).toBe(
      'On picture 3, the player fell in the pit',
    );
  });

  it('leaves plain prose exactly as it was written', () => {
    expect(readableThought('The coin did nothing when I touched it.')).toBe(
      'The coin did nothing when I touched it.',
    );
  });
});

describe('the tester stage', () => {
  it('shows the picture the tester is playing while a session runs', () => {
    seed({ running: true, session: 1, maxSteps: 8, phase: 'playing' });
    render(<TesterStage />);
    expect(screen.getByAltText(/as the tester is playing it/i)).toBeTruthy();
  });

  it('shows no picture before anything has ever played', () => {
    render(<TesterStage />);
    expect(screen.queryByAltText(/as the tester is playing it/i)).toBeNull();
  });

  it('invites a first session rather than showing an empty log', () => {
    render(<TesterStage />);
    expect(screen.getByText(/has not played/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /play/i })).toBeTruthy();
  });

  it('keeps the thinking in the order it was thought', () => {
    seed({
      running: true,
      session: 2,
      maxSteps: 8,
      phase: 'playing',
      thoughts: [
        { turn: 1, text: 'The player is standing on a ledge.' },
        { turn: 2, text: 'I held right and fell in a pit.' },
      ],
    });
    render(<TesterStage />);
    const items = screen.getAllByRole('listitem').map((node) => node.textContent ?? '');
    expect(items[0]).toContain('standing on a ledge');
    expect(items[1]).toContain('fell in a pit');
  });

  it('offers a way to stop for exactly as long as there is something to stop', () => {
    seed({ running: true, session: 1, maxSteps: 8, phase: 'playing' });
    render(<TesterStage />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
    cleanup();

    seed({ running: false, session: 1, maxSteps: 8, phase: 'finished' });
    render(<TesterStage />);
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
  });

  it('stops the session when asked', async () => {
    seed({ running: true, session: 1, maxSteps: 8, phase: 'playing' });
    render(<TesterStage />);
    await act(async () => {
      screen.getByRole('button', { name: /stop/i }).click();
    });
    expect(vi.mocked(apiTesterStop)).toHaveBeenCalledWith(PROJECT);
  });

  it('says what it is doing in words, never a phase name', () => {
    seed({ running: true, session: 1, maxSteps: 8, phase: 'reflecting' });
    render(<TesterStage />);
    expect(screen.queryByText(/reflecting/i)).toBeNull();
    expect(screen.getByText(/writing up|what it saw/i)).toBeTruthy();
  });

  it('says plainly when a session could not run', () => {
    seed({ error: 'no browser on this machine' });
    render(<TesterStage />);
    expect(screen.getByText(/no browser on this machine/)).toBeTruthy();
  });
});

/**
 * Play used to be a natively disabled button with nothing beside it. A control
 * that will not respond and will not say why is a dead end, and this surface
 * had three of them. CapabilityStrip already solved this for the game pane's
 * own Play, with `aria-disabled` plus a tooltip, because a natively disabled
 * button dispatches no pointer events and so can never explain itself.
 */
describe('Play, when it cannot be pressed', () => {
  it('says why there is nothing to play, on the surface and not only on hover', () => {
    useApp.setState({
      projectPath: PROJECT,
      projectName: 'game',
      game: { present: false, entry: null, mtime: 0 },
      gameKnown: true,
      tester: { ...IDLE },
    });
    render(<TesterStage />);
    expect(screen.getByText(/no game in this project yet/i)).toBeTruthy();
  });

  it('marks itself unavailable without going deaf, so the reason can reach a pointer', () => {
    useApp.setState({
      projectPath: PROJECT,
      projectName: 'game',
      game: { present: false, entry: null, mtime: 0 },
      gameKnown: true,
      tester: { ...IDLE },
    });
    render(<TesterStage />);
    const play = screen.getByRole('button', { name: /^play$/i });
    expect(play.getAttribute('aria-disabled')).toBe('true');
    // Natively disabled would be the bug: no pointer events, so no tooltip.
    expect((play as HTMLButtonElement).disabled).toBe(false);
  });

  it('does nothing when pressed anyway, because aria-disabled does not stop a click', async () => {
    useApp.setState({
      projectPath: PROJECT,
      projectName: 'game',
      game: { present: false, entry: null, mtime: 0 },
      gameKnown: true,
      tester: { ...IDLE },
    });
    const playTester = vi.fn();
    useApp.setState({ playTester });
    render(<TesterStage />);
    await act(async () => {
      screen.getByRole('button', { name: /^play$/i }).click();
    });
    expect(playTester).not.toHaveBeenCalled();
  });

  it('presses through normally when there is a game', async () => {
    seed({});
    const playTester = vi.fn();
    useApp.setState({ playTester });
    render(<TesterStage />);
    await act(async () => {
      screen.getByRole('button', { name: /^play$/i }).click();
    });
    expect(playTester).toHaveBeenCalled();
  });
});

/**
 * The turn counter is a claim about how far into its budget the session is, and
 * the window that is watching does not own that number: the server does, and it
 * puts it on every thought. Counting the thoughts THIS window happened to
 * receive means a window that reloaded mid-session reads "Turn 1 of 24" beside
 * a session on its thirteenth.
 */
describe('testerTurnLine', () => {
  const playing = (over: Partial<TesterState>): TesterState => ({
    ...IDLE,
    running: true,
    phase: 'playing',
    session: 4,
    maxSteps: 24,
    ...over,
  });

  it('says the turn the session is really on, not how many thoughts this window saw', () => {
    expect(testerTurnLine(playing({ thoughts: [{ turn: 13, text: 'I held right.' }] }))).toBe(
      'Turn 13 of 24',
    );
  });

  it('says nothing about the turn before this window has heard one', () => {
    // A window that reloaded mid-session has watched nothing yet. "Turn 1" is
    // a number nobody sent it.
    expect(testerTurnLine(playing({ thoughts: [] }))).toBeNull();
  });

  it('stays inside the budget it is quoting', () => {
    expect(testerTurnLine(playing({ maxSteps: 6, thoughts: [{ turn: 9, text: 'x' }] }))).toBe(
      'Turn 6 of 6',
    );
  });
});

/**
 * A run that died is the run being reported on. The sentence that ends the run
 * BEFORE it, sitting under a red failure, reads as the failed session's own
 * ending and says the game was played through to the end.
 */
describe('testerEndingLine under a failure', () => {
  it('does not narrate the run before beneath the failure of the run that just died', () => {
    expect(testerEndingLine({ ...IDLE, error: 'the browser went away', lastNote: note() })).toBeNull();
  });

  it('still says how a session ended when nothing failed', () => {
    expect(testerEndingLine({ ...IDLE, lastNote: note() })).toMatch(/played 12 turns/i);
  });

  it('keeps the previous run off the screen under the red line', () => {
    seed({ error: 'the browser went away', lastNote: note(), sessions: [note()] });
    render(<TesterStage />);
    expect(screen.getByText(/the browser went away/)).toBeTruthy();
    expect(screen.queryByText(/played 12 turns/i)).toBeNull();
  });
});

/**
 * A session number is not an identity. The folder it comes out of is documented
 * as hand-editable, so two notes in one game can claim the same number, and the
 * rows are paired to their notes by position for exactly that reason. The
 * window's own record of finished sessions has to agree.
 */
describe('the window record of finished sessions', () => {
  const done = (note: TesterNote): void => {
    act(() => {
      useApp.getState().receiveFrame({ type: 'tester-done', note } as never);
    });
  };

  it('keeps a session it already had when a different one claims the same number', () => {
    const older = note({ session: 3, startedAt: '2026-01-01T00:00:00.000Z' });
    seed({ sessions: [older] });
    done(note({ session: 3, startedAt: '2026-07-27T10:00:00.000Z' }));
    expect(useApp.getState().tester.sessions).toHaveLength(2);
  });

  it('still replaces the one session it is about when its note arrives twice', () => {
    const same = note({ session: 3 });
    seed({ sessions: [same] });
    done(same);
    expect(useApp.getState().tester.sessions).toHaveLength(1);
  });
});

describe('whyNoPlay', () => {
  it('names the folder problem before the session one, since it outranks it', () => {
    expect(whyNoPlay(false, false, false)).toMatch(/no game in this project/i);
    expect(whyNoPlay(false, true, false)).toMatch(/no game in this project/i);
  });

  it('says a session is already under way rather than going quiet', () => {
    expect(whyNoPlay(true, true, false)).toMatch(/playing right now/i);
    expect(whyNoPlay(true, false, true)).toMatch(/waking up/i);
  });

  it('is null when there is nothing in the way', () => {
    expect(whyNoPlay(true, false, false)).toBeNull();
  });

  /**
   * `game.present` is false both when the folder has no game and when the
   * status read never landed, and `refreshGame` leaves the empty default
   * standing on a null answer. Taking a plain boolean here turned a request
   * that FAILED into "There is no game in this project yet": a statement about
   * somebody's disk, made from a question nobody got an answer to. The store
   * path was fixed with exactly this distinction; this one still had it wrong.
   *
   * Null is the pre-read value, and it neither claims nor blocks: it is not a
   * reason the tester cannot play, because nobody has looked. Pressing Play
   * asks the server, which does know, and answers "No game to play yet" for
   * itself.
   */
  it('never turns a question nobody answered into a claim about the folder', () => {
    // Null, which is neither the claim nor a refusal: there is nothing known
    // to be in the way, so Play stays pressable and the server answers.
    expect(whyNoPlay(null, false, false)).toBeNull();
  });

  it('still holds back a second session while one is under way', () => {
    expect(whyNoPlay(null, true, false)).toMatch(/playing right now/i);
    expect(whyNoPlay(null, false, true)).toMatch(/waking up/i);
  });
});

describe('the stage with the game status unread', () => {
  it('does not tell the reader their folder is empty', () => {
    // A window that has just opened, or whose status read was dropped: the
    // invitation used to sit under a Play button explaining that there is no
    // game here, having never found out either way.
    useApp.setState({
      projectPath: PROJECT,
      projectName: 'game',
      game: { present: false, entry: null, mtime: 0 },
      gameKnown: false,
      tester: { ...IDLE },
    });
    render(<TesterStage />);
    expect(screen.queryByText(/no game in this project/i)).toBeNull();
  });

  it('still says it plainly once the read has landed', () => {
    useApp.setState({
      projectPath: PROJECT,
      projectName: 'game',
      game: { present: false, entry: null, mtime: 0 },
      gameKnown: true,
      tester: { ...IDLE },
    });
    render(<TesterStage />);
    expect(screen.getByText(/no game in this project/i)).toBeTruthy();
  });
});
