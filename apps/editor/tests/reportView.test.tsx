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

describe('the report view', () => {
  it('offers a way into every session it lists', () => {
    seed([note({ session: 1 }), note({ session: 2 })]);
    render(<TesterHistory />);
    expect(screen.getAllByRole('button', { name: /read the whole session/i })).toHaveLength(2);
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
    const trigger = screen.getAllByRole('button', { name: /read the whole session/i })[0];
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
