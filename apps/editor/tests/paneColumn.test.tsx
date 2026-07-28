// @vitest-environment jsdom
/**
 * The playtest column: whether it is there at all.
 *
 * It used to be unconditional — open a folder and half the window became a
 * frame that usually said "No game to show yet", with no way to dismiss it.
 * These pin the four things that make it a guest instead of a fixture:
 *
 *   1. opening a folder does NOT open it; a game appearing does;
 *   2. a folder that has closed it stays closed, including when a game appears;
 *   3. New chat clears it, without forgetting that this folder likes it open —
 *      the old conversation's game must not sit beside a blank one;
 *   4. it has a close button, and the choice survives reopening the folder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiGameStatus: vi.fn(),
  apiProbeStatus: vi.fn(),
}));

import { apiGameStatus, apiProbeStatus } from '../src/api';
import { PaneStack } from '../src/components/game/PaneStack';
import { paneOpenStorageKey, readPaneOpen, useApp } from '../src/store';

const PROJECT = '/work/game';
const NO_GAME = { present: false, entry: null, mtime: 0 };
const A_GAME = { present: true, entry: 'index.html', mtime: 42 };

function resetStore(over: Partial<ReturnType<typeof useApp.getState>> = {}): void {
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'game',
    game: NO_GAME,
    paneOpen: false,
    paneChoice: null,
    paneTab: 'game',
    narrowTab: 'chat',
    messages: [],
    ...over,
  });
}

const paneOpen = () => useApp.getState().paneOpen;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiProbeStatus).mockResolvedValue(null);
  vi.mocked(apiGameStatus).mockResolvedValue(NO_GAME);
  resetStore();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('what opens the column', () => {
  it('stays closed while the folder has no game in it', async () => {
    await act(async () => useApp.getState().refreshGame());
    expect(paneOpen()).toBe(false);
  });

  it('opens itself the moment a game appears', async () => {
    vi.mocked(apiGameStatus).mockResolvedValue(A_GAME);
    await act(async () => useApp.getState().refreshGame());
    expect(paneOpen()).toBe(true);
  });

  it('does not re-open a column this folder has closed', async () => {
    act(() => useApp.getState().setPaneOpen(false));
    vi.mocked(apiGameStatus).mockResolvedValue(A_GAME);
    await act(async () => useApp.getState().refreshGame());
    expect(paneOpen()).toBe(false);
  });

  it('does not re-open on a game that was already there', async () => {
    // Every poll re-reads the folder; only the transition is an event.
    resetStore({ game: A_GAME });
    act(() => useApp.getState().setPaneOpen(false));
    vi.mocked(apiGameStatus).mockResolvedValue({ ...A_GAME, mtime: 99 });
    await act(async () => useApp.getState().refreshGame());
    expect(paneOpen()).toBe(false);
  });
});

describe('the choice', () => {
  it('is remembered per folder', () => {
    act(() => useApp.getState().setPaneOpen(true));
    expect(readPaneOpen(PROJECT)).toBe(true);
    expect(localStorage.getItem(paneOpenStorageKey(PROJECT))).toBe('1');

    act(() => useApp.getState().setPaneOpen(false));
    expect(readPaneOpen(PROJECT)).toBe(false);
  });

  it('is null for a folder that has never made one', () => {
    expect(readPaneOpen('/somewhere/else')).toBeNull();
  });

  it('leaves the narrow layout on a tab that exists', () => {
    resetStore({ paneOpen: true, narrowTab: 'pane' });
    act(() => useApp.getState().setPaneOpen(false));
    expect(useApp.getState().narrowTab).toBe('chat');
  });
});

describe('a new conversation', () => {
  it('takes the previous one’s game off the screen', () => {
    resetStore({ paneOpen: true, paneChoice: true });
    act(() => useApp.getState().newChat());
    expect(paneOpen()).toBe(false);
  });

  it('does not forget that this folder likes the column open', async () => {
    // The distinction that makes the rule liveable: closing for a blank page
    // is not the same act as closing the column, so the next game brings it
    // back for a folder that asked for it.
    act(() => useApp.getState().setPaneOpen(true));
    act(() => useApp.getState().newChat());
    expect(paneOpen()).toBe(false);
    expect(useApp.getState().paneChoice).toBe(true);

    vi.mocked(apiGameStatus).mockResolvedValue(A_GAME);
    await act(async () => useApp.getState().refreshGame());
    expect(paneOpen()).toBe(true);
  });
});

describe('the close button', () => {
  it('is there, and closes the column', () => {
    resetStore({ paneOpen: true });
    render(<PaneStack />);
    fireEvent.click(screen.getByRole('button', { name: 'Close playtest' }));
    expect(paneOpen()).toBe(false);
    expect(readPaneOpen(PROJECT)).toBe(false);
  });
});
