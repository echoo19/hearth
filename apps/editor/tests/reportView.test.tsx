// @vitest-environment jsdom
/**
 * Reading a session in full.
 *
 * The history answers "did my last change help". This answers "what actually
 * happened", which is a different question and a longer one. What these pin is
 * the honesty of it: a claim about somewhere the tester was put says so where
 * the claim is, and the reachability caveat shows up when it is true and stays
 * away when it is not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiTesterPlay: vi.fn(),
  apiTesterStop: vi.fn(),
  apiTesterHistory: vi.fn(async () => null),
  apiTesterHistoryAll: vi.fn(async () => null),
  apiRecentWorkspaces: vi.fn(async () => []),
}));

import { TesterHistory } from '../src/components/tester/TesterHistory';
import { useApp } from '../src/store';
import type { TesterState } from '../src/store';
import type { TesterNote } from '../server/tester/types';

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
    session: 1,
    startedAt: '2026-07-27T10:00:00.000Z',
    finishedAt: new Date().toISOString(),
    onTheChange: { seen: 'you rewrote the intake rules', verdict: 'better', why: 'the queue cleared' },
    regression: 'nothing',
    observations: [
      { frame: 2, text: 'the intake screen listed nobody', reached: 'played' },
      { frame: 6, text: 'the audit total came out negative', reached: 'placed' },
    ],
    openQuestions: [],
    steps: 8,
    stopped: 'done',
    ...over,
  };
}

const PROJECT = '/work/game';

/**
 * The Tester screen is global: it lists runs across every game, so a session
 * reaches it tagged with the project it came from rather than as the open
 * folder's history.
 */
function seed(sessions: TesterNote[]): void {
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'game',
    game: { present: true, entry: 'index.html', mtime: 1 },
    tester: { ...IDLE, sessions },
    testerRuns: {
      runs: sessions.map((note) => ({ note, project: { path: PROJECT, name: 'game' } })),
      dropped: 0,
      skippedProjects: 0,
    },
  });
}

/** Every run on the list. The row itself is the trigger. */
function runRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.tester-run')) as HTMLElement[];
}

beforeEach(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Open the first run's report and hand back the dialog it opened. The whole
 * row is the button: reading a report is the only thing this list is for.
 */
function open(): HTMLElement {
  const trigger = runRows()[0];
  act(() => {
    trigger.click();
  });
  return document.querySelector('dialog') as HTMLElement;
}

describe('the report view', () => {
  it('offers a way into every session it lists', () => {
    seed([note({ session: 1 }), note({ session: 2 })]);
    render(<TesterHistory />);
    expect(runRows()).toHaveLength(2);
  });

  it('opens the session in full', () => {
    seed([note()]);
    render(<TesterHistory />);
    const report = open();
    expect(within(report).getByText(/the intake screen listed nobody/)).toBeTruthy();
    expect(within(report).getByText(/the audit total came out negative/)).toBeTruthy();
    expect(within(report).getByText(/it played 8 turns/i)).toBeTruthy();
  });

  it('says which claims came from somewhere the game put it', () => {
    seed([note()]);
    render(<TesterHistory />);
    const report = open();
    const placed = within(report).getByText(/the audit total came out negative/).closest('li');
    expect(placed?.textContent?.toLowerCase()).toContain('placed');
    const played = within(report).getByText(/the intake screen listed nobody/).closest('li');
    expect(played?.textContent?.toLowerCase()).not.toContain('placed');
  });

  it('warns about reachability only when something really was placed', () => {
    seed([note()]);
    render(<TesterHistory />);
    const report = open();
    expect(within(report).getByText(/say nothing about whether a player can reach/i)).toBeTruthy();
  });

  it('stays quiet about reachability when the tester played its way there', () => {
    seed([note({ observations: [{ frame: 2, text: 'the queue cleared', reached: 'played' }] })]);
    render(<TesterHistory />);
    open();
    expect(screen.queryByText(/say nothing about whether a player can reach/i)).toBeNull();
  });

  it('closes on Escape and hands focus back to what opened it', () => {
    seed([note()]);
    render(<TesterHistory />);
    const trigger = runRows()[0];
    act(() => {
      trigger.focus();
      trigger.click();
    });
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    act(() => {
      fireEvent(dialog, new Event('cancel', { cancelable: true }));
    });
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

/**
 * The report of a session that fell over.
 *
 * Three sections of this dialog are drawn from an empty list, and on a crashed
 * session all three read as a game with nothing wrong with it. That is the
 * opposite of the truth on the one surface this product calls its flagship, and
 * it lands where a person decides whether to act.
 */
describe('a session that ended early', () => {
  const crashed = () =>
    note({
      stopped: 'error',
      observations: [],
      openQuestions: [],
      proposals: [],
      regression: 'The session ended early, so nothing was recorded about whether anything got worse.',
      onTheChange: {
        seen: 'It did not get far enough to say.',
        verdict: 'unclear',
        why: 'The session ended early and it never gave a verdict: no browser on this machine',
      },
    });

  it('never reads as a game with nothing worth changing', () => {
    seed([crashed()]);
    render(<TesterHistory />);
    const report = open();
    expect(within(report).queryByText(/found nothing here worth changing/i)).toBeNull();
    expect(within(report).queryByText(/nothing it wanted to raise/i)).toBeNull();
    expect(within(report).queryByText(/did not write down anything it saw/i)).toBeNull();
  });

  it('says the session was cut short where each of those answers would have gone', () => {
    seed([crashed()]);
    render(<TesterHistory />);
    const report = open();
    expect(within(report).getAllByText(/nothing was written down here/i)).toHaveLength(3);
  });

  it('still lets a finished session say it found nothing', () => {
    seed([note({ observations: [], openQuestions: [], proposals: [] })]);
    render(<TesterHistory />);
    const report = open();
    expect(within(report).getByText(/found nothing here worth changing/i)).toBeTruthy();
    expect(within(report).getByText(/nothing it wanted to raise/i)).toBeTruthy();
  });
});

/**
 * A report you cannot scroll from a keyboard.
 *
 * `.report` is the scrolling box, and it had no tabindex. On a session with no
 * plan of action, which is what a first session and any clean session is, the
 * only focusable thing in the dialog is the close button, and that sits outside
 * the box. PageDown did nothing and scrollTop stayed at 0 for the whole report.
 */
describe('reading a long report from a keyboard', () => {
  it('makes the scrolling box a tab stop, since nothing inside it is one', () => {
    seed([note({ proposals: [] })]);
    render(<TesterHistory />);
    const report = open();
    const scroller = report.querySelector('.report') as HTMLElement;
    expect(scroller.getAttribute('tabindex')).toBe('0');
  });

  it('names the box, so a tab stop does not arrive as an unlabelled group', () => {
    seed([note({ session: 4, proposals: [] })]);
    render(<TesterHistory />);
    const report = open();
    const scroller = report.querySelector('.report') as HTMLElement;
    expect(scroller.getAttribute('role')).toBe('region');
    expect(scroller.getAttribute('aria-label')).toMatch(/session 4/i);
  });

  it('can take focus, which is the whole of what PageDown needed', () => {
    seed([note({ proposals: [] })]);
    render(<TesterHistory />);
    const report = open();
    const scroller = report.querySelector('.report') as HTMLElement;
    act(() => {
      scroller.focus();
    });
    expect(document.activeElement).toBe(scroller);
  });
});

/**
 * The observations and the open questions used to render at full ink inside the
 * report, because they sit straight in a `.report-part` rather than inside the
 * muted wrapper the history uses. The open questions ended up the loudest text
 * on the page. The rule that fixes it is scoped to `.report`, so it must not be
 * possible to satisfy it by muting the lists everywhere.
 */
describe('the report keeps its lists at the weight of the prose around them', () => {
  it('puts the tester lists inside .report, where the scoped rule can reach them', () => {
    seed([note({ openQuestions: ['what the second button does'] })]);
    render(<TesterHistory />);
    const report = open();
    for (const list of Array.from(report.querySelectorAll('.tester-saw'))) {
      expect(list.closest('.report')).not.toBeNull();
    }
  });
});
