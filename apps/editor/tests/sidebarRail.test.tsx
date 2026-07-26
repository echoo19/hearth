// @vitest-environment jsdom
/**
 * The rail.
 *
 * Four contracts, all of them about honesty:
 *   1. Recents is global — a conversation in a folder that isn't open still
 *      shows, and opening it opens its folder first;
 *   2. it never offers an action it can't perform: rename/delete belong to the
 *      folder's own index, so they appear only for the folder that is open,
 *      and Terminal is unavailable (with a reason) until there is one;
 *   3. search hides rows and nothing else — an empty box hides nothing;
 *   4. the update banner is present exactly when an update is, and its button
 *      really does relaunch.
 *
 * The harness folds are stubbed: they have their own suite, and they fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/harness/HarnessSections', () => ({ HarnessSections: () => null }));

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiRecentWorkspaces: vi.fn(async () => []),
}));

import { apiRecentWorkspaces } from '../src/api';
import {
  Sidebar,
  accountIdentity,
  matchesQuery,
  mergeRecentChats,
  relativeTime,
} from '../src/components/shell/Sidebar';
import { useApp } from '../src/store';
import type { ChatProviderStatus, RecentChatEntry } from '../src/types';

const HERE = '/work/game';
const ELSEWHERE = '/work/other';

function chat(id: string, title: string, project = HERE, updatedAt = '2026-07-01T10:00:00.000Z'): RecentChatEntry {
  return { id, title, updatedAt, project: { path: project, name: project.split('/').pop()! } };
}

function reset(over: Partial<ReturnType<typeof useApp.getState>> = {}): void {
  useApp.setState({
    projectPath: null,
    projectName: null,
    chats: [],
    recentChats: [],
    activeChatId: null,
    providers: null,
    updateReady: null,
    sidebarCollapsed: false,
    conversationMode: 'chat',
    ...over,
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiRecentWorkspaces).mockResolvedValue([]);
  reset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

describe('matchesQuery', () => {
  it('hides nothing for an empty or whitespace query', () => {
    expect(matchesQuery('Asteroids', '')).toBe(true);
    expect(matchesQuery('Asteroids', '   ')).toBe(true);
  });

  it('matches on any part of the name, ignoring case', () => {
    expect(matchesQuery('Top-down shooter', 'SHOOT')).toBe(true);
    expect(matchesQuery('Top-down shooter', 'platformer')).toBe(false);
  });
});

describe('mergeRecentChats', () => {
  it('keeps conversations from every folder, newest first', () => {
    const merged = mergeRecentChats(
      [chat('a', 'Older', ELSEWHERE, '2026-07-01T09:00:00.000Z'), chat('b', 'Newer', HERE, '2026-07-01T12:00:00.000Z')],
      [],
      null,
    );
    expect(merged.map((entry) => entry.title)).toEqual(['Newer', 'Older']);
  });

  it('folds in the open folder’s live list, which the global read has not caught up with', () => {
    const merged = mergeRecentChats([], [{ id: 'fresh', title: 'Just made', updatedAt: '2026-07-02T00:00:00.000Z' }], {
      path: HERE,
      name: 'game',
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].project).toEqual({ path: HERE, name: 'game' });
  });

  it('lets the live copy win over the stale one rather than listing both', () => {
    const merged = mergeRecentChats(
      [chat('a', 'Untitled', HERE, '2026-07-01T09:00:00.000Z')],
      [{ id: 'a', title: 'Asteroids', updatedAt: '2026-07-01T12:00:00.000Z' }],
      { path: HERE, name: 'game' },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('Asteroids');
  });

  it('ignores the folder list entirely when no folder is open', () => {
    expect(mergeRecentChats([], [{ id: 'a', title: 'Ghost', updatedAt: '2026-07-01T09:00:00.000Z' }], null)).toEqual([]);
  });
});

describe('accountIdentity', () => {
  it('says who is signed in, and on what', () => {
    const providers = {
      anthropic: { hasKey: false, source: null },
      openai: {
        installed: true,
        version: '1.0.0',
        loggedIn: true,
        authMode: 'chatgpt',
        email: 'ada@example.com',
        planType: 'Plus',
        hasKey: false,
      },
      active: 'openai',
    } as ChatProviderStatus;
    expect(accountIdentity(providers)).toEqual({ initials: 'A', name: 'ada', status: 'Plus' });
  });

  it('falls back to the key when nobody is signed in', () => {
    const providers = {
      anthropic: { hasKey: true, source: 'project' },
      openai: { installed: false, version: null, loggedIn: false, authMode: null, email: null, planType: null, hasKey: false },
      active: 'anthropic',
    } as ChatProviderStatus;
    expect(accountIdentity(providers)).toEqual({ initials: 'H', name: 'Hearth', status: 'API key' });
  });

  it('says so plainly when nothing is configured at all', () => {
    expect(accountIdentity(null)).toEqual({ initials: 'H', name: 'Hearth', status: 'Not signed in' });
  });
});

describe('relativeTime', () => {
  it('answers in the fewest words that stay true', () => {
    const now = Date.parse('2026-07-01T12:00:00.000Z');
    expect(relativeTime('2026-07-01T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-07-01T11:30:00.000Z', now)).toBe('30m ago');
    expect(relativeTime('2026-06-29T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('says nothing rather than "NaN" for an unparseable date', () => {
    expect(relativeTime('not a date')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The rendered rail
// ---------------------------------------------------------------------------

describe('Recents, across folders', () => {
  it('lists conversations from folders that are not open', async () => {
    reset({ recentChats: [chat('a', 'Asteroids', ELSEWHERE)] });
    render(<Sidebar />);
    expect(await screen.findByText('Asteroids')).toBeTruthy();
  });

  it('opens the chat through openRecentChat, so the folder comes with it', async () => {
    const openRecentChat = vi.fn(async () => {});
    const entry = chat('a', 'Asteroids', ELSEWHERE);
    reset({ recentChats: [entry], openRecentChat });
    render(<Sidebar />);

    fireEvent.click(await screen.findByText('Asteroids'));
    expect(openRecentChat).toHaveBeenCalledWith(entry);
  });

  it('offers rename and delete only for the folder that is open', async () => {
    reset({
      projectPath: HERE,
      projectName: 'game',
      recentChats: [chat('mine', 'Mine', HERE), chat('theirs', 'Theirs', ELSEWHERE)],
    });
    render(<Sidebar />);

    await screen.findByText('Mine');
    expect(screen.getByRole('button', { name: /Conversation options — Mine/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Conversation options — Theirs/ })).toBeNull();
  });
});

describe('search', () => {
  it('filters both lists, and shows everything again when cleared', async () => {
    vi.mocked(apiRecentWorkspaces).mockResolvedValue([{ path: ELSEWHERE, name: 'other', exists: true }]);
    reset({ recentChats: [chat('a', 'Asteroids'), chat('b', 'Platformer')] });
    render(<Sidebar />);

    await screen.findByText('Asteroids');
    await waitFor(() => expect(screen.getByText('other')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const box = screen.getByLabelText('Search chats and folders');

    fireEvent.change(box, { target: { value: 'aster' } });
    expect(screen.queryByText('Platformer')).toBeNull();
    expect(screen.queryByText('other')).toBeNull();
    expect(screen.getByText('Asteroids')).toBeTruthy();

    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByText('Platformer')).toBeTruthy();
  });

  it('says nothing matches rather than looking empty', async () => {
    reset({ recentChats: [chat('a', 'Asteroids')] });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByLabelText('Search chats and folders'), { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches that.')).toBeTruthy();
  });
});

describe('the Chat / Terminal switch', () => {
  it('cannot reach the terminal without a folder, and says why', () => {
    render(<Sidebar />);
    const terminal = screen.getByRole('tab', { name: 'Terminal' });
    expect(terminal.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(terminal);
    expect(useApp.getState().conversationMode).toBe('chat');
  });

  it('switches the column once a folder is open', () => {
    reset({ projectPath: HERE, projectName: 'game' });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(useApp.getState().conversationMode).toBe('terminal');
  });
});

describe('the update banner', () => {
  it('is absent until there is an update', () => {
    render(<Sidebar />);
    expect(screen.queryByText('Relaunch to update')).toBeNull();
  });

  it('names the version and relaunches when pressed', () => {
    const relaunchToUpdate = vi.fn(async () => {});
    reset({ updateReady: { version: '1.4.0' }, relaunchToUpdate });
    render(<Sidebar />);

    expect(screen.getByText('Relaunch to update')).toBeTruthy();
    expect(screen.getByText('v1.4.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Relaunch now' }));
    expect(relaunchToUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('opening a folder', () => {
  it('serves the composer’s hearth:open-folder request, since the composer cannot reach the picker', async () => {
    const pickDirectory = vi.fn(async () => ELSEWHERE);
    const openWorkspace = vi.fn(async () => ({ ok: true }));
    (window as unknown as { hearthNative: unknown }).hearthNative = { pickDirectory, platform: 'darwin' };
    reset({ openWorkspace });
    render(<Sidebar />);

    window.dispatchEvent(new CustomEvent('hearth:open-folder'));

    await waitFor(() => expect(openWorkspace).toHaveBeenCalledWith(ELSEWHERE));
    delete (window as unknown as { hearthNative?: unknown }).hearthNative;
  });

  it('offers the same act as a nav row', async () => {
    const pickDirectory = vi.fn(async () => ELSEWHERE);
    const openWorkspace = vi.fn(async () => ({ ok: true }));
    (window as unknown as { hearthNative: unknown }).hearthNative = { pickDirectory, platform: 'darwin' };
    reset({ openWorkspace });
    render(<Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Open folder…' }));

    await waitFor(() => expect(openWorkspace).toHaveBeenCalledWith(ELSEWHERE));
    delete (window as unknown as { hearthNative?: unknown }).hearthNative;
  });
});

describe('the collapsed rail', () => {
  it('keeps the acts and drops the lists', () => {
    reset({ sidebarCollapsed: true, recentChats: [chat('a', 'Asteroids')] });
    render(<Sidebar />);

    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    // The switch has nothing honest to say at 60px; the View menu still has it.
    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull();
  });
});

describe('the account row', () => {
  it('is there before anything is configured, saying exactly that', () => {
    render(<Sidebar />);
    expect(screen.getByText('Hearth')).toBeTruthy();
    expect(screen.getByText('Not signed in')).toBeTruthy();
  });

  it('opens a menu with Settings', async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: /Account — Hearth/ }));
    expect(await screen.findByRole('menuitem', { name: 'Settings…' })).toBeTruthy();
  });
});
