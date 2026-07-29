// @vitest-environment jsdom
/**
 * The Tester screen as a place of its own.
 *
 * A playtest belongs to a game. The HISTORY of playtests belongs to you, so
 * this screen spans every game: it used to show only whichever project
 * happened to be open, silently, with a Play button aimed at a game it never
 * named. Reaching yesterday's run meant guessing which project it came from,
 * opening that project, then coming back.
 *
 * Two things have to hold, and the second one is the subtle one:
 *
 *   1. Runs from more than one game appear on one list, each wearing its own
 *      game's name, and opening a report does not switch project.
 *   2. A verdict is only ever read against the session BEFORE it IN THE SAME
 *      GAME. `testerRows` compares neighbours to say "last time you were told
 *      the opposite", so building rows from the mixed list would have session 4
 *      of one game answering session 9 of another. That is exactly the kind of
 *      confident wrong sentence the tester exists not to produce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiTesterHistory: vi.fn(async () => null),
  apiTesterHistoryAll: vi.fn(async () => null),
  apiRecentWorkspaces: vi.fn(async () => []),
  apiTesterPlay: vi.fn(async () => ({ ok: true })),
}));

import { TesterHistory, runRows } from '../src/components/tester/TesterHistory';
import { useApp } from '../src/store';
import type { TesterNote } from '../server/tester/types';
import type { TesterRun } from '../src/types';

const LIGHTHOUSE = '/work/lighthouse';
const HARBOUR = '/work/harbour';

function note(session: number, verdict: 'better' | 'worse', finishedAt: string): TesterNote {
  return {
    session,
    startedAt: '2026-07-27T10:00:00.000Z',
    finishedAt,
    onTheChange: { seen: 'you changed the jump', verdict, why: 'it reads that way' },
    regression: 'nothing',
    observations: [],
    openQuestions: [],
    steps: 4,
    stopped: 'done',
  } as TesterNote;
}

const run = (path: string, name: string, note: TesterNote): TesterRun => ({ note, project: { path, name } });

beforeEach(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  useApp.setState({ projectPath: null, projectName: null, testerRuns: null, testerTarget: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('runRows', () => {
  it('compares a session only against the one before it in the same game', () => {
    // Interleaved in time, so a naive pass over the mixed list would read
    // lighthouse 2 against harbour 1.
    const rows = runRows([
      run(LIGHTHOUSE, 'lighthouse', note(2, 'worse', '2026-07-28T04:00:00.000Z')),
      run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T03:00:00.000Z')),
      run(LIGHTHOUSE, 'lighthouse', note(1, 'better', '2026-07-28T02:00:00.000Z')),
    ]);

    const lighthouse2 = rows.find((r) => r.run.project.path === LIGHTHOUSE && r.row.session === 2)!;
    const harbour1 = rows.find((r) => r.run.project.path === HARBOUR)!;

    // Lighthouse said better, then worse: a real change of mind, within one
    // game, and the row is allowed to say so.
    expect(lighthouse2.row.reversal).toBeTruthy();
    // Harbour has played once. It has nothing to be compared against, and
    // borrowing lighthouse's verdict would be inventing a history.
    expect(harbour1.row.previously).toBeFalsy();
    expect(harbour1.row.reversal).toBeFalsy();
  });

  it('keeps the order it was given, which is newest first', () => {
    const rows = runRows([
      run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z')),
      run(LIGHTHOUSE, 'lighthouse', note(9, 'worse', '2026-07-28T01:00:00.000Z')),
    ]);
    expect(rows.map((r) => r.run.project.name)).toEqual(['harbour', 'lighthouse']);
  });

  it('drops nothing on the floor', () => {
    const runs = [
      run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z')),
      run(LIGHTHOUSE, 'lighthouse', note(9, 'worse', '2026-07-28T01:00:00.000Z')),
    ];
    expect(runRows(runs)).toHaveLength(runs.length);
  });
});

describe('the Tester screen', () => {
  it('lists runs from more than one game, each saying which', async () => {
    useApp.setState({
      testerRuns: {
        runs: [
          run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z')),
          run(LIGHTHOUSE, 'lighthouse', note(9, 'worse', '2026-07-28T01:00:00.000Z')),
        ],
        dropped: 0,
      },
    });
    render(<TesterHistory />);
    await act(async () => {});

    expect(document.querySelectorAll('.tester-run')).toHaveLength(2);
    expect(screen.getByText(/harbour · Session 1/)).toBeTruthy();
    expect(screen.getByText(/lighthouse · Session 9/)).toBeTruthy();
  });

  it('opens a report without switching project', async () => {
    useApp.setState({
      projectPath: LIGHTHOUSE,
      projectName: 'lighthouse',
      testerRuns: { runs: [run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z'))], dropped: 0 },
    });
    render(<TesterHistory />);
    await act(async () => {});

    await act(async () => {
      (document.querySelector('.tester-run') as HTMLElement).click();
    });

    expect(document.querySelector('dialog')).toBeTruthy();
    // Reading what your tester said about one game is not a reason to tear
    // down the game you have running.
    expect(useApp.getState().projectPath).toBe(LIGHTHOUSE);
  });

  it('aims at the most recently played game, not at whatever is open', async () => {
    useApp.setState({
      projectPath: LIGHTHOUSE,
      projectName: 'lighthouse',
      testerRuns: {
        runs: [
          run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z')),
          run(LIGHTHOUSE, 'lighthouse', note(9, 'worse', '2026-07-28T01:00:00.000Z')),
        ],
        dropped: 0,
      },
    });
    render(<TesterHistory />);
    await act(async () => {});

    // Named out loud on the control, so the aim is never something you have to
    // infer from which project you last clicked.
    expect(screen.getByRole('button', { name: /^Project: / })).toBeTruthy();
    expect(useApp.getState().testerTarget).toBeNull();
  });

  it('tells "never played" apart from "not read yet"', async () => {
    render(<TesterHistory />);
    // Nothing read yet: saying "your tester has not played this game" here
    // would be a claim the screen has to take back a moment later.
    expect(screen.queryByText(/has not played/i)).toBeNull();

    await act(async () => {
      useApp.setState({ testerRuns: { runs: [], dropped: 0 } });
    });
    expect(screen.getByText(/has not played/i)).toBeTruthy();
  });

  it('says out loud what the cap left out', async () => {
    useApp.setState({
      testerRuns: { runs: [run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z'))], dropped: 14 },
    });
    render(<TesterHistory />);
    await act(async () => {});
    // A capped list that looks complete is a list that lies about your history.
    expect(screen.getByText(/14 older sessions are not shown/i)).toBeTruthy();
  });
});
