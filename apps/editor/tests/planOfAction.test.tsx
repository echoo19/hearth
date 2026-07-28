// @vitest-environment jsdom
/**
 * The plan of action, and the moment someone commits work to an agent.
 *
 * The tester proposes and the person disposes, so what these pin is the
 * disposing. Nothing arrives ticked, because approval that starts half-made is
 * not approval. A bug it watched happen and a preference it cannot really
 * judge are told apart where they are read. A claim from somewhere the game
 * put the tester carries that on its own row, at the moment it is being
 * decided rather than a paragraph earlier. And a session with nothing worth
 * changing says so, plainly: a tester whose plan is never empty will start
 * inventing work, since a list of fixes always looks like value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, within } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiTesterPlay: vi.fn(),
  apiTesterStop: vi.fn(),
  apiTesterHistory: vi.fn(async () => null),
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
    session: 3,
    startedAt: '2026-07-27T10:00:00.000Z',
    finishedAt: new Date().toISOString(),
    onTheChange: { seen: 'you rewrote the intake rules', verdict: 'better', why: 'the queue cleared' },
    regression: 'nothing',
    observations: [
      { frame: 4, text: 'the audit total came out negative', reached: 'played' },
      { frame: 6, text: 'the queue took nine turns to clear', reached: 'placed' },
    ],
    proposals: [
      { kind: 'bug', text: 'the audit total goes negative once a refund is filed', evidence: [4] },
      { kind: 'suggestion', text: 'the intake queue could clear faster', evidence: [6] },
    ],
    openQuestions: [],
    steps: 12,
    stopped: 'done',
    ...over,
  };
}

function seed(sessions: TesterNote[]): void {
  useApp.setState({
    projectPath: '/work/game',
    projectName: 'game',
    game: { present: true, entry: 'index.html', mtime: 1 },
    tester: { ...IDLE, sessions },
  });
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

/** Open the first session's report and hand back the dialog it opened. */
function open(): HTMLElement {
  const trigger = screen.getAllByRole('button', { name: /read the whole session/i })[0];
  act(() => {
    trigger.click();
  });
  return document.querySelector('dialog') as HTMLElement;
}

function ticks(report: HTMLElement): HTMLInputElement[] {
  return within(report).getAllByRole('checkbox') as HTMLInputElement[];
}

function approveButton(report: HTMLElement): HTMLButtonElement {
  return within(report).getByRole('button', { name: /start work/i }) as HTMLButtonElement;
}

describe('the plan of action', () => {
  it('arrives with nothing ticked, so approving is always something you did', () => {
    seed([note()]);
    render(<TesterHistory />);
    const report = open();
    expect(ticks(report)).toHaveLength(2);
    expect(ticks(report).every((box) => !box.checked)).toBe(true);
  });

  it('will not start work until something is ticked', () => {
    seed([note()]);
    render(<TesterHistory />);
    const report = open();
    expect(approveButton(report).disabled).toBe(true);
    act(() => {
      ticks(report)[0].click();
    });
    expect(approveButton(report).disabled).toBe(false);
  });

  it('tells a bug it watched apart from a preference it cannot judge', () => {
    seed([note()]);
    render(<TesterHistory />);
    const report = open();
    expect(within(report).getByText(/watched these go wrong/i)).toBeTruthy();
    expect(within(report).getByText(/cannot judge fun/i)).toBeTruthy();
  });

  it('says on the row itself when the game put it there', () => {
    seed([note()]);
    render(<TesterHistory />);
    const report = open();
    const placed = within(report).getByText(/intake queue could clear faster/).closest('li');
    expect(placed?.textContent).toMatch(/put it there/i);
    const played = within(report).getByText(/audit total goes negative/).closest('li');
    expect(played?.textContent).not.toMatch(/put it there/i);
  });

  it('says plainly when nothing is worth changing, and offers nothing to approve', () => {
    seed([note({ proposals: [] })]);
    render(<TesterHistory />);
    const report = open();
    expect(within(report).getByText(/found nothing here worth changing/i)).toBeTruthy();
    expect(within(report).queryByRole('button', { name: /start work/i })).toBeNull();
    expect(within(report).queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('sends the ticked ones and no others', async () => {
    seed([note()]);
    const approveProposals = vi.fn(async () => ({ ok: true }));
    const sendChat = vi.fn();
    useApp.setState({ approveProposals, sendChat });
    render(<TesterHistory />);
    const report = open();
    act(() => {
      ticks(report)[1].click();
    });
    await act(async () => {
      approveButton(report).click();
    });
    expect(approveProposals).toHaveBeenCalledWith(3, ['s3-p1']);
    // Into a conversation that does not exist yet, never into the open one.
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('unticks as readily as it ticks, so a mistake costs one click', async () => {
    seed([note()]);
    const approveProposals = vi.fn(async () => ({ ok: true }));
    useApp.setState({ approveProposals });
    render(<TesterHistory />);
    const report = open();
    act(() => {
      ticks(report)[0].click();
      ticks(report)[1].click();
      ticks(report)[0].click();
    });
    await act(async () => {
      approveButton(report).click();
    });
    expect(approveProposals).toHaveBeenCalledWith(3, ['s3-p1']);
  });
});
