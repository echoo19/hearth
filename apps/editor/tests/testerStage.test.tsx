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
import { TesterStage, readableThought } from '../src/components/tester/TesterStage';
import { useApp } from '../src/store';
import { resetProbeStream } from '../src/probeStream';
import type { TesterState } from '../src/store';

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

function seed(tester: Partial<TesterState>): void {
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'game',
    game: { present: true, entry: 'index.html', mtime: 1 },
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
