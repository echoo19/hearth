// @vitest-environment jsdom
/**
 * Personalization and Usage: the two panes that showed a number or a sentence
 * the disk did not agree with.
 *
 * Both bugs here are the same species as the Agents pane's, one layer quieter.
 * Personalization saved less than it displayed and said nothing about it, so a
 * long paste came back shortened only after a reload, by which point there was
 * nothing to connect it to. Usage described what it counted in words that had
 * stopped being true when the count moved behind a filter. Neither failed
 * loudly; both left the user holding a wrong belief, which is the expensive
 * part.
 *
 * The limits are pinned against the server's own constants rather than
 * restated, because two numbers that have to agree and live in different files
 * are a drift waiting to happen, and the drift is invisible until someone
 * pastes something long.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { usage } = vi.hoisted(() => ({
  usage: vi.fn(),
}));

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return { ...actual, apiUsage: usage };
});

import { MAX_INSTRUCTIONS, MAX_NAME, PersonalizationPane } from '../src/components/settings/PersonalizationPane';
import { USAGE_TIMEOUT_MS, UsagePane } from '../src/components/settings/UsagePane';
import { MAX_INSTRUCTIONS as SERVER_MAX_INSTRUCTIONS, MAX_NAME as SERVER_MAX_NAME } from '../server/personalization';
import type { UsageReport } from '../src/api';
import { useApp } from '../src/store';

type State = ReturnType<typeof useApp.getState>;

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Personalization
// ---------------------------------------------------------------------------

describe('the limits the pane shows are the limits the server keeps', () => {
  it('matches server/personalization.ts, which is the thing that actually truncates', () => {
    expect(MAX_NAME).toBe(SERVER_MAX_NAME);
    expect(MAX_INSTRUCTIONS).toBe(SERVER_MAX_INSTRUCTIONS);
  });
});

/**
 * Stand in for the store's personalization slice. `savePersonalization`
 * normalizes the way the real server does, so the pane is tested against the
 * behaviour that caused the bug rather than against an obliging fake.
 */
function patchPersonalization(): { save: ReturnType<typeof vi.fn> } {
  const files = { name: '~/.hearth/name', instructions: '~/.hearth/instructions.md' };
  const save = vi.fn(async (patch: { name?: string; instructions?: string }) => {
    const current = useApp.getState().personalization?.personalization ?? { name: '', instructions: '' };
    const next = {
      name: (patch.name ?? current.name).slice(0, SERVER_MAX_NAME),
      instructions: (patch.instructions ?? current.instructions).slice(0, SERVER_MAX_INSTRUCTIONS).trim(),
    };
    useApp.setState({ personalization: { personalization: next, files } } as unknown as Partial<State>);
    return true;
  });
  useApp.setState({
    personalization: { personalization: { name: '', instructions: '' }, files },
    loadPersonalization: vi.fn(async () => {}),
    savePersonalization: save,
  } as unknown as Partial<State>);
  return { save };
}

describe('Personalization does not display what it did not save', () => {
  it('shows the text the server actually kept, not the text that was typed', async () => {
    patchPersonalization();
    render(<PersonalizationPane />);
    const box = screen.getByLabelText('Standing instructions') as HTMLTextAreaElement;

    // Trailing whitespace is the cheapest thing the server normalizes away,
    // and it used to survive on screen while never reaching the file. The
    // reconcile compared against the PRE-save value, found a difference, and
    // concluded the user must have kept typing.
    fireEvent.change(box, { target: { value: 'always run the tests   \n\n' } });
    fireEvent.blur(box);

    await waitFor(() => expect(box.value).toBe('always run the tests'));
  });

  it('cannot be given more than the server will keep', () => {
    patchPersonalization();
    render(<PersonalizationPane />);
    const box = screen.getByLabelText('Standing instructions') as HTMLTextAreaElement;
    const name = screen.getByLabelText('What to call you') as HTMLInputElement;
    // A limit the field enforces is a limit the user can see coming. Before
    // this, 20k+ characters went in, half of them were dropped on the way to
    // disk, and the box went on showing all of them.
    expect(box.maxLength).toBe(MAX_INSTRUCTIONS);
    expect(name.maxLength).toBe(MAX_NAME);
  });

  it('names the limit in the hint, rather than letting it be discovered', () => {
    patchPersonalization();
    render(<PersonalizationPane />);
    expect(screen.getByText(new RegExp(MAX_INSTRUCTIONS.toLocaleString()))).toBeTruthy();
    expect(screen.getByText(new RegExp(`${MAX_NAME} characters`))).toBeTruthy();
  });

  it('still refuses to overwrite a field the user is in the middle of typing', async () => {
    patchPersonalization();
    render(<PersonalizationPane />);
    const name = screen.getByLabelText('What to call you') as HTMLInputElement;
    const box = screen.getByLabelText('Standing instructions') as HTMLTextAreaElement;

    // The reason the reconcile is careful in the first place: saving one field
    // must not reach over and replace a half-typed paragraph in the other.
    fireEvent.change(box, { target: { value: 'half a thought' } });
    fireEvent.change(name, { target: { value: 'Jake' } });
    fireEvent.blur(name);

    await waitFor(() => expect(name.value).toBe('Jake'));
    expect(box.value).toBe('half a thought');
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function report(over: Partial<UsageReport> = {}): UsageReport {
  return {
    totals: { projects: 2, chats: 7, playtests: 1, changes: 3, missing: 0 },
    skills: { total: 4, enabled: 2 },
    projects: [],
    firstChatAt: null,
    ...over,
  } as UsageReport;
}

describe('Usage says what it counts', () => {
  beforeEach(() => usage.mockReset());

  it('does not claim to count every chat started, because it no longer does', async () => {
    // `readChatCounts` goes through `parseChatIndex`, which drops rows still
    // marked pending, and a conversation is pending until someone speaks into
    // it. The old hint promised the opposite.
    usage.mockResolvedValue(report());
    render(<UsagePane />);
    await screen.findByText('Conversations');
    expect(screen.queryByText(/Every chat started in those folders/)).toBeNull();
    expect(screen.getByText(/actually said something in/)).toBeTruthy();
  });
});

describe('Usage has a way out of a read that never lands', () => {
  beforeEach(() => {
    usage.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('stops saying "counting" once the wait is unreasonable, and offers a retry', async () => {
    // A stalled read used to leave "Counting what is on disk…" on screen for
    // the life of the dialog with nothing at all to press.
    usage.mockReturnValue(new Promise(() => {}));
    render(<UsagePane />);
    expect(screen.getByText(/Counting what is on disk/)).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(USAGE_TIMEOUT_MS + 1);
    });

    expect(screen.queryByText(/Counting what is on disk/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('reads again when the retry is pressed', async () => {
    usage.mockReturnValue(new Promise(() => {}));
    render(<UsagePane />);
    await act(async () => {
      vi.advanceTimersByTime(USAGE_TIMEOUT_MS + 1);
    });

    usage.mockResolvedValue(report());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(usage).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Conversations')).toBeTruthy();
  });

  it('recovers on its own if the slow read eventually arrives', async () => {
    // The deadline is on the wait, not on the request: `apiUsage` takes no
    // abort signal, so a late answer is still a good answer.
    let land: (value: UsageReport) => void = () => {};
    usage.mockReturnValue(new Promise<UsageReport>((resolve) => (land = resolve)));
    render(<UsagePane />);
    await act(async () => {
      vi.advanceTimersByTime(USAGE_TIMEOUT_MS + 1);
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();

    await act(async () => {
      land(report());
    });
    expect(screen.getByText('Conversations')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
