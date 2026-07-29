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
import { paneOnScreen } from '../src/App';
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

/**
 * What the top bar is describing when it says "Hide playtest".
 *
 * The flag is remembered per folder, so a folder that likes the column open
 * arrives on its project screen with `paneOpen` already true — and the project
 * screen renders instead of the working area, so there is no column there to
 * hide. The toggle said "Hide playtest" over nothing, and pressing it closed a
 * column nobody could see: the second half of the same dead button.
 */
describe('whether the column is on screen at all', () => {
  const state = (over: Partial<ReturnType<typeof useApp.getState>> = {}) => {
    resetStore({ paneOpen: true, projectPath: PROJECT, projectView: false, composing: false, screen: null, ...over });
    return useApp.getState();
  };

  it('is not, on the project screen', () => {
    expect(paneOnScreen(state({ projectView: true }))).toBe(false);
  });

  it('is not, on the blank composer or a global screen', () => {
    expect(paneOnScreen(state({ composing: true }))).toBe(false);
    expect(paneOnScreen(state({ screen: 'skills' }))).toBe(false);
    expect(paneOnScreen(state({ projectPath: null }))).toBe(false);
  });

  it('is, in the folder’s working view, which is the only place it renders', () => {
    expect(paneOnScreen(state({ projectView: false }))).toBe(true);
    expect(paneOnScreen(state({ projectView: false, paneOpen: false }))).toBe(false);
  });
});

/**
 * The project screen renders ProjectHome INSTEAD of the working area (App.tsx),
 * so the column has nowhere to appear while `projectView` is set. The top bar
 * still offers the toggle there — `globalPlace` answers null on the project
 * screen — so asking for the column has to be a way of leaving that screen,
 * exactly as `playTester` already treats it. Otherwise the press flips a flag
 * nothing is rendering and the button reads as broken.
 */
describe('asking for the column from the project screen', () => {
  it('leaves the project screen, so the column has somewhere to be', () => {
    resetStore({ projectView: true, composing: false, screen: null });
    act(() => useApp.getState().setPaneOpen(true));
    expect(paneOpen()).toBe(true);
    expect(useApp.getState().projectView).toBe(false);
  });

  it('shows the column rather than the conversation in the narrow layout', () => {
    // Below the breakpoint the two regions are tabs, so opening the column
    // without moving the tab answers the press with the conversation.
    resetStore({ projectView: true, narrowTab: 'chat' });
    act(() => useApp.getState().setPaneOpen(true));
    expect(useApp.getState().narrowTab).toBe('pane');
  });

  it('does not drag a blank composer along with it', () => {
    // New chat is a place too; the column belongs to a folder's work, not to
    // the blank page, so opening it lands in the folder's conversation.
    resetStore({ composing: true });
    act(() => useApp.getState().setPaneOpen(true));
    expect(useApp.getState().composing).toBe(false);
  });

  it('closes without sending anybody back to the project screen', () => {
    resetStore({ paneOpen: true, projectView: false });
    act(() => useApp.getState().setPaneOpen(false));
    expect(paneOpen()).toBe(false);
    expect(useApp.getState().projectView).toBe(false);
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

/**
 * Below the breakpoint the conversation and the playtest column are two tabs
 * of one region (App.tsx, `chatActive`), so `narrowTab` decides which of them
 * the window is actually showing. Anything that says "here is a conversation"
 * has to move it, or the app answers a click by carrying on showing the game:
 * the row was clicked, the conversation was opened, and nothing changed.
 */
describe('the narrow layout’s tab', () => {
  it('comes back to the conversation when one is opened', () => {
    resetStore({ paneOpen: true, narrowTab: 'pane', activeChatId: 'c1' });
    act(() => useApp.getState().openChat('c1'));
    expect(useApp.getState().narrowTab).toBe('chat');
  });

  it('comes back for a conversation that is already the open one', () => {
    // Clicking the row you are already on is still "show me this", and the
    // early return for the same id must not skip the part that shows it.
    resetStore({ paneOpen: true, narrowTab: 'pane', activeChatId: 'c1' });
    act(() => useApp.getState().openChat('c1'));
    expect(useApp.getState().narrowTab).toBe('chat');
    expect(useApp.getState().activeChatId).toBe('c1');
  });

  it('comes back on New chat, rather than being left stale', () => {
    // New chat closes the column directly rather than through setPaneOpen, so
    // it used to leave the tab on 'pane'. The next game to appear reopens the
    // column, and the window would have landed on the game.
    resetStore({ paneOpen: true, paneChoice: true, narrowTab: 'pane' });
    act(() => useApp.getState().newChat());
    expect(useApp.getState().narrowTab).toBe('chat');
  });
});

describe('closing the column', () => {
  it('is not offered a second time inside the tab strip', () => {
    // The top bar's toggle both opens and closes this column. A second way out
    // at the far end of the tab strip was a control you had to find again in a
    // different place from the one that put the column there.
    resetStore({ paneOpen: true });
    render(<PaneStack />);
    expect(screen.queryByRole('button', { name: 'Close playtest' })).toBeNull();
  });

  it('still happens through the store the top bar drives', () => {
    resetStore({ paneOpen: true });
    act(() => useApp.getState().setPaneOpen(false));
    expect(paneOpen()).toBe(false);
    expect(readPaneOpen(PROJECT)).toBe(false);
  });
});
