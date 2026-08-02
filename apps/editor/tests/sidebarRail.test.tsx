// @vitest-environment jsdom
/**
 * The rail.
 *
 * Four contracts, all of them about honesty:
 *   1. Recents is global — a conversation in a folder that isn't open still
 *      shows, and opening it opens its folder first;
 *   2. it never offers an action it can't perform: rename/delete belong to the
 *      folder's own index, so they appear only for the folder that is open,
 *      and the mode switch is not here at all (it moved to the column);
 *   3. search hides rows and nothing else — an empty box hides nothing;
 *   4. the update banner is present exactly when an update is, and its button
 *      really does relaunch.
 *
 * The harness folds are stubbed: they have their own suite, and they fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
import { FOCUS_SEARCH_EVENT } from '../src/components/shell/ShortcutLayer';
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
    devTeam: null,
    devTeamByChat: {},
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
  it('says who is signed in, and on what, for the agent that would answer', () => {
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
    expect(accountIdentity(providers, 'openai')).toEqual({
      initials: 'A',
      name: 'ada',
      status: 'Plus',
      pending: false,
    });
  });

  it('never reports one vendor’s plan while the other is answering', () => {
    // The bug this pins. Only the ChatGPT sign-in ships an email and a plan
    // word, so the row read them unconditionally: someone working entirely in
    // Claude saw their ChatGPT handle and "plus" underneath it, describing a
    // subscription that had nothing to do with anything on screen.
    const providers = {
      // Signed in through the CLI itself, not a key: this is the case the bug
      // was about, so `loggedIn` has to be true for the fixture to still mean
      // "Claude is the one actually answering" now that `cli` alone (the
      // binary merely being on PATH) no longer implies a sign-in.
      anthropic: { hasKey: false, source: null, cli: true, loggedIn: true },
      openai: {
        installed: true,
        version: '1.0.0',
        loggedIn: true,
        authMode: 'chatgpt',
        email: 'ada@example.com',
        planType: 'Plus',
        hasKey: false,
      },
      active: 'anthropic',
    } as ChatProviderStatus;
    const identity = accountIdentity(providers, 'anthropic');
    expect(identity.status).not.toBe('Plus');
    expect(identity.name).not.toBe('ada');
    // How it is reached, which is the whole of what that CLI reports. A tier
    // is NOT invented from anything else to hand: it is the one fact a reader
    // would most reasonably trust, so an unknown one stays unsaid.
    expect(identity).toEqual({ initials: 'C', name: 'Claude', status: 'Claude Code sign in', pending: false });
  });

  it('falls back to the key when the Claude CLI is not there', () => {
    const providers = {
      anthropic: { hasKey: true, source: 'project', cli: false },
      openai: { installed: false, version: null, loggedIn: false, authMode: null, email: null, planType: null, hasKey: false },
      active: 'anthropic',
    } as ChatProviderStatus;
    expect(accountIdentity(providers, 'anthropic')).toEqual({
      initials: 'C',
      name: 'Claude',
      status: 'API key',
      pending: false,
    });
  });

  it('says so plainly when the server has looked and found nothing configured', () => {
    // A real answer, not a missing one: the probe came back and there is no
    // sign-in and no key. THIS is the state allowed to say "Not signed in".
    const providers = {
      anthropic: { hasKey: false, source: null, cli: false, loggedIn: false },
      openai: { installed: false, version: null, loggedIn: false, authMode: null, email: null, planType: null, hasKey: false },
      active: null,
    } as unknown as ChatProviderStatus;
    expect(accountIdentity(providers, 'anthropic')).toEqual({
      initials: 'C',
      name: 'Claude',
      status: 'Not signed in',
      pending: false,
    });
  });

  it('claims nothing while the first providers read is still out', () => {
    // Null providers is "not looked yet", not "not signed in". This function
    // used to answer "Not signed in" for it, so every fresh window opened on
    // a signed-in machine called its owner signed out for the length of the
    // auth probe, then took it back. The pending answer keeps the one fact
    // that is not about anyone's sign-in (which agent would answer) and
    // refuses the status line entirely.
    expect(accountIdentity(null, 'anthropic')).toEqual({
      initials: 'C',
      name: 'Claude',
      status: null,
      pending: true,
    });
    expect(accountIdentity(null, 'openai')).toEqual({
      initials: 'C',
      name: 'ChatGPT',
      status: null,
      pending: true,
    });
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
    expect(screen.getByRole('button', { name: /Conversation options for Mine/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Conversation options for Theirs/ })).toBeNull();
  });

  /**
   * Titles here are sentences and the rail is 260px wide, so nearly all of
   * them ellipsize. Measured in a real browser, the longest row showed 147 of
   * its 320 pixels — the title was cut mid-phrase with no way to read the
   * rest, because the row carries no tooltip of its own. jsdom cannot see the
   * clipping (it lays nothing out), so what is pinned is the affordance that
   * makes the clipping survivable, the same `title` the truncating spans in
   * Usage and Skills already carry.
   */
  it('keeps the whole title readable on a row too narrow to show it', async () => {
    const long = 'lets make a simple platformer game with a double jump and coins';
    reset({ recentChats: [chat('a', long, ELSEWHERE)] });
    const { container } = render(<Sidebar />);

    await screen.findByText(long);
    const title = container.querySelector('.chat-title');
    expect(title).not.toBeNull();
    expect(title?.getAttribute('title')).toBe(long);
  });

  it('annotates the active team conversation with live build activity', async () => {
    const entry = { ...chat('team', 'Build together', HERE), kind: 'devteam' as const };
    reset({
      projectPath: HERE,
      projectName: 'game',
      activeChatId: entry.id,
      recentChats: [entry],
      devTeam: {
        version: 1,
        runId: 'run-1',
        phase: 'building',
      phaseSince: null,
        steering: [],
        plan: null,
        tasks: [
          { taskId: 'one', engineerId: 'one', status: 'running' },
          { taskId: 'two', engineerId: 'two', status: 'running' },
        ],
        approvals: [],
        history: [],
        currentMilestone: 0,
        spec: null,
        specVersion: 0,
        summary: null,
        wrap: null,
        error: null,
      },
    });
    render(<Sidebar />);

    expect((await screen.findByRole('status')).textContent).toBe('building · 2 working');
  });

  it('keeps annotating a live team conversation after another chat is selected', async () => {
    const team = { ...chat('team', 'Build together', HERE), kind: 'devteam' as const };
    const ordinary = chat('ordinary', 'Plan the next game', HERE);
    const snapshot = {
      version: 1 as const,
      runId: 'run-1',
      phase: 'paused' as const,
      phaseSince: null,
      steering: [],
      plan: null,
      tasks: [],
      approvals: [],
      history: [],
      currentMilestone: 0,
      spec: null,
      specVersion: 0,
      summary: null,
      wrap: null,
      error: null,
    };
    reset({
      projectPath: HERE,
      projectName: 'game',
      activeChatId: ordinary.id,
      recentChats: [team, ordinary],
      devTeam: null,
      devTeamByChat: { [team.id]: snapshot },
    });
    render(<Sidebar />);

    expect((await screen.findByRole('status')).textContent).toBe('paused');
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
    const box = screen.getByLabelText('Search projects and chats');

    fireEvent.change(box, { target: { value: 'aster' } });
    expect(screen.queryByText('Platformer')).toBeNull();
    expect(screen.queryByText('other')).toBeNull();
    expect(screen.getByText('Asteroids')).toBeTruthy();

    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByText('Platformer')).toBeTruthy();
  });

  it('finds a project by the folder it is in, not only by the name it shows', async () => {
    // The two stopped being the same string once a name could be written in
    // any script: "Café Adventure" lives in `cafe-adventure`, and someone
    // typing the folder they can see in Finder, or just the unaccented
    // spelling, was told no such project existed.
    vi.mocked(apiRecentWorkspaces).mockResolvedValue([
      { path: '/Users/someone/Hearth/cafe-adventure', name: 'Café Adventure', exists: true },
    ]);
    reset();
    render(<Sidebar />);
    await screen.findByText('Café Adventure');

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const box = screen.getByLabelText('Search projects and chats');

    fireEvent.change(box, { target: { value: 'cafe-adv' } });
    expect(screen.getByText('Café Adventure')).toBeTruthy();

    // The folder, not the whole path: "Users" is on every row on the machine
    // and matching it would filter nothing.
    fireEvent.change(box, { target: { value: 'Users' } });
    expect(screen.queryByText('Café Adventure')).toBeNull();
  });

  it('says nothing matches rather than looking empty', async () => {
    reset({ recentChats: [chat('a', 'Asteroids')] });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByLabelText('Search projects and chats'), { target: { value: 'zzz' } });
    expect(screen.getByText('No chats match that.')).toBeTruthy();
  });

  it('puts the caret in the field when the shortcut opens it', () => {
    reset({ recentChats: [chat('a', 'Asteroids')] });
    render(<Sidebar />);

    act(() => {
      window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT));
    });

    expect(document.activeElement).toBe(screen.getByLabelText('Search projects and chats'));
  });

  it('puts it there again when search was already open behind a collapsed rail', () => {
    // The reported failure. `setSearching(true)` on an already-searching rail
    // changes nothing, so the effect that focuses never re-ran and the direct
    // call from the handler ran while the field was still unmounted (it renders
    // only under `!collapsed && searching`). document.activeElement stayed on
    // BODY and everything typed went nowhere.
    reset({ recentChats: [chat('a', 'Asteroids')] });
    render(<Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByLabelText('Search projects and chats'), { target: { value: 'aster' } });
    act(() => {
      useApp.getState().setSidebarCollapsed(true);
    });
    expect(screen.queryByLabelText('Search projects and chats')).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT));
    });

    const box = screen.getByLabelText('Search projects and chats') as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    // And selected, so a second press means "search for something else".
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe('aster'.length);
  });
});

describe('the collapsed rail', () => {
  it('takes its hidden lists out of the tab order and off the screen reader', async () => {
    // Collapsed, the lists are hidden with opacity alone, which is mouse-only:
    // 36 buttons existed and 4 were visible, so four Tabs off "Expand sidebar"
    // landed on a project row drawn outside the 60px rail, screen readers read
    // the whole hidden list out, and focusing a row scrolled a container nobody
    // could see.
    vi.mocked(apiRecentWorkspaces).mockResolvedValue([{ path: HERE, name: 'game', exists: true }]);
    reset({ sidebarCollapsed: true, recentChats: [chat('a', 'Asteroids')] });
    const { container } = render(<Sidebar />);

    await waitFor(() => expect(container.querySelector('.sidebar-scroll')).toBeTruthy());
    const lists = container.querySelector('.sidebar-scroll')!;
    expect(lists.hasAttribute('inert')).toBe(true);
    expect(lists.getAttribute('aria-hidden')).toBe('true');
  });

  it('gives them back the moment it is expanded', async () => {
    vi.mocked(apiRecentWorkspaces).mockResolvedValue([{ path: HERE, name: 'game', exists: true }]);
    reset({ sidebarCollapsed: false, recentChats: [chat('a', 'Asteroids')] });
    const { container } = render(<Sidebar />);

    const lists = container.querySelector('.sidebar-scroll')!;
    expect(lists.hasAttribute('inert')).toBe(false);
    expect(lists.hasAttribute('aria-hidden')).toBe(false);
  });
});

describe('projects that share a name', () => {
  it('tells two same-named rows apart by where they live, and leaves lone names plain', async () => {
    // Two "proj"s in the rail were two identical strings with a button each:
    // the mark is derived from the path, but a reader cannot resolve a colour
    // back into a folder. The hint appears only on colliding names, so the
    // common case stays a clean list.
    vi.mocked(apiRecentWorkspaces).mockResolvedValue([
      { path: '/work/games/proj', name: 'proj', exists: true },
      { path: '/work/experiments/proj', name: 'proj', exists: true },
      { path: '/work/lighthouse', name: 'lighthouse', exists: true },
    ]);
    reset();
    const { container } = render(<Sidebar />);
    await screen.findByText('lighthouse');

    const hints = [...container.querySelectorAll('.project-where')].map((node) => node.textContent);
    expect(hints).toEqual(['games/proj', 'experiments/proj']);
    // The lone name explains nothing, because nothing about it needs explaining.
    const lighthouse = [...container.querySelectorAll('.project-row')].find((row) =>
      row.textContent?.includes('lighthouse'),
    );
    expect(lighthouse?.querySelector('.project-where')).toBeNull();
  });
});

describe('the Tester row', () => {
  it('carries the project you are standing in as the aim', () => {
    // Entering the Tester screen from inside a game used to default its
    // picker to the most recently played game ANYWHERE, so Play beside it
    // would have closed the game you came from and playtested another one.
    const openTesterFor = vi.fn();
    const openScreen = vi.fn();
    reset({ projectPath: HERE, projectName: 'game', screen: null, composing: false, openTesterFor, openScreen });
    render(<Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Tester' }));
    expect(openTesterFor).toHaveBeenCalledWith(HERE);
    expect(openScreen).not.toHaveBeenCalled();
  });

  it('leaves the default aim alone when there is no project to carry', () => {
    const openTesterFor = vi.fn();
    const openScreen = vi.fn();
    reset({ projectPath: null, screen: null, composing: false, openTesterFor, openScreen });
    render(<Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Tester' }));
    expect(openScreen).toHaveBeenCalledWith('tester');
    expect(openTesterFor).not.toHaveBeenCalled();
  });

  it('does not re-aim at a folder that is merely open under a global screen', () => {
    // Standing on Skills, the project is open underneath but it is not where
    // you are (globalPlace), so pressing Tester is not "coming from" it.
    const openTesterFor = vi.fn();
    const openScreen = vi.fn();
    reset({ projectPath: HERE, projectName: 'game', screen: 'skills', composing: false, openTesterFor, openScreen });
    render(<Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Tester' }));
    expect(openScreen).toHaveBeenCalledWith('tester');
    expect(openTesterFor).not.toHaveBeenCalled();
  });
});

describe('the Chat / Terminal switch', () => {
  it('is not in the rail — it moved to the conversation it changes', () => {
    // The rail is Projects and Chats. A mode control belonged to neither list,
    // and sat above both pretending to. Its behaviour is covered where it now
    // lives, in conversationMode.test.tsx.
    reset({ projectPath: HERE, projectName: 'game' });
    render(<Sidebar />);
    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull();
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

  it('is no longer a row in the rail', () => {
    // Projects are the unit now, and "open some directory" is a File-menu act
    // (⌘O) rather than a third thing competing with the two lists.
    render(<Sidebar />);
    expect(screen.queryByRole('button', { name: 'Open folder…' })).toBeNull();
  });
});

describe('the collapsed rail', () => {
  it('keeps the acts and drops the lists', () => {
    reset({
      sidebarCollapsed: true,
      recentChats: [chat('a', 'Asteroids')],
      projectPath: '/work/game',
      projectName: 'game',
    });
    render(<Sidebar />);

    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skills' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });

  it('keeps both acts with nothing open at all', () => {
    // Neither depends on a project: New chat asks which one, and Skills are
    // the user's rather than any project's.
    reset({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skills' })).toBeTruthy();
  });
});

describe('the account row', () => {
  it('does not call anyone signed out while the auth probe is still out', () => {
    // On every fresh load `providers` is null until the first read lands, and
    // for those seconds this row said "Not signed in" as a fact, then flipped
    // to the real account in front of the person it had just misdescribed.
    // The truth of that moment is "we have not looked yet", so the row shows
    // the agent that would answer, dimmed, and claims nothing.
    const { container } = render(<Sidebar />);
    expect(useApp.getState().providers).toBeNull();
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.queryByText('Not signed in')).toBeNull();
    expect(container.querySelector('.account-status')).toBeNull();
  });

  it('says "Not signed in" only once the server has looked and found nothing', () => {
    reset({
      providers: {
        anthropic: { hasKey: false, source: null, cli: false, loggedIn: false },
        openai: {
          installed: false,
          version: null,
          loggedIn: false,
          authMode: null,
          email: null,
          planType: null,
          hasKey: false,
        },
        active: null,
      } as unknown as ChatProviderStatus,
    });
    render(<Sidebar />);
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('Not signed in')).toBeTruthy();
  });

  it('opens a menu with Settings', async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: /Account: Claude/ }));
    expect(await screen.findByRole('menuitem', { name: 'Settings…' })).toBeTruthy();
  });

  it('opens Settings with no project open', async () => {
    // It used to be gated on having a folder, from when Settings was nothing
    // but the two API-key fields that save into a project. Clicking it with no
    // project did nothing at all, which reads as a broken menu rather than as
    // a refusal. Every pane but one is about the person, not the project.
    render(<Sidebar />);
    expect(useApp.getState().projectPath).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Account: Claude/ }));
    const item = await screen.findByRole('menuitem', { name: 'Settings…' });
    expect(item.getAttribute('aria-disabled')).toBeNull();
    expect((item as HTMLButtonElement).disabled).toBe(false);

    const opened = vi.fn();
    window.addEventListener('hearth:open-settings', opened);
    fireEvent.click(item);
    window.removeEventListener('hearth:open-settings', opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('leaves checking for updates to Settings, where the version is', async () => {
    // Two doors to the same act, one of them next to the number it reports on
    // and one of them not, only makes the reader wonder if they differ.
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: /Account: Claude/ }));
    await screen.findByRole('menuitem', { name: 'Settings…' });
    expect(screen.queryByRole('menuitem', { name: /Check for updates/ })).toBeNull();
  });
});
