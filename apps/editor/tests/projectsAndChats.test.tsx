// @vitest-environment jsdom
/**
 * The shape of the product, pinned: a project is a game is a folder, and the
 * user only ever sees the first of those three words.
 *
 * Two rules matter enough to hold still:
 *
 *   1. **New chat creates nothing.** It shows the same blank surface Home
 *      shows — a greeting, a composer, and a project to aim it at. The
 *      conversation is created by the message, which is why the surface is
 *      identical whether or not a project is already open.
 *   2. **Every project is distinct on sight.** A mark and a colour, derived
 *      from the path so they exist before anyone chooses anything, and stable
 *      forever after. A rail of six games that are six identical strings is
 *      the failure this prevents.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, within } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiRecentWorkspaces: vi.fn(),
  apiRecentChats: vi.fn(async () => []),
}));

import { apiRecentWorkspaces } from '../src/api';
import { ProjectHome } from '../src/components/project/ProjectHome';
import { Sidebar, stableOrder } from '../src/components/shell/Sidebar';
import { PROJECT_COLORS, PROJECT_ICONS, resolveIdentity } from '../src/projects/identity';
import { useApp } from '../src/store';
import type { RecentWorkspace } from '../src/types';

const PROJECT = '/work/lighthouse';

const workspace = (path: string, name: string, over: Partial<RecentWorkspace> = {}): RecentWorkspace => ({
  path,
  name,
  exists: true,
  ...over,
});

function resetStore(over: Partial<ReturnType<typeof useApp.getState>> = {}): void {
  useApp.setState({
    projectPath: null,
    projectName: null,
    sidebarCollapsed: false,
    chats: [],
    recentChats: [],
    messages: [],
    queued: [],
    activeChatId: null,
    composing: false,
    composeTarget: null,
    ...over,
  } as Partial<ReturnType<typeof useApp.getState>>);
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiRecentWorkspaces).mockResolvedValue([]);
  resetStore();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the general acts', () => {
  it('are the only ones the rail offers', () => {
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skills' })).toBeTruthy();
    // Offered with nothing open. The history of playtests spans every game,
    // so gating the row on an open folder meant reaching yesterday's run
    // required first guessing which project it had come from.
    expect(screen.getByRole('button', { name: 'Tester' })).toBeTruthy();
    // Opening an arbitrary directory is a File-menu act now; the rail is
    // Projects and Chats, and a third list of "folders" was the old model.
    expect(screen.queryByRole('button', { name: 'Open folder…' })).toBeNull();
  });

  it('keeps making a project out of the general acts and beside the list', () => {
    // Creating a project is not a general act — it belongs to the Projects
    // list, the way New chat belongs to the app. So the nav strip holds the
    // three global screens and no more, and the create lives on the heading.
    const { container } = render(<Sidebar />);
    const nav = container.querySelector('.sidebar-nav');
    expect(nav).toBeTruthy();
    expect(within(nav as HTMLElement).queryByRole('button', { name: /New project/ })).toBeNull();
    expect(within(nav as HTMLElement).getAllByRole('button')).toHaveLength(3);

    const head = container.querySelector('.sidebar-section-head');
    expect(head).toBeTruthy();
    expect(within(head as HTMLElement).getByRole('button', { name: 'New project…' })).toBeTruthy();
  });

  it('names its lists Projects and Chats', () => {
    render(<Sidebar />);
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Chats' })).toBeTruthy();
    // "Recents" was ambiguous the moment there were two lists to be recent.
    expect(screen.queryByRole('heading', { name: 'Recents' })).toBeNull();
  });
});

describe('New chat', () => {
  it('shows the blank surface rather than creating a conversation', () => {
    resetStore({ projectPath: PROJECT, projectName: 'lighthouse', activeChatId: 'c1' });
    act(() => useApp.getState().newChat());
    expect(useApp.getState().composing).toBe(true);
    // Nothing was created, and the project is still open behind it.
    expect(useApp.getState().projectPath).toBe(PROJECT);
  });

  it('aims at the project you were last in, so the common case needs no choice', () => {
    resetStore({ projectPath: PROJECT, projectName: 'lighthouse' });
    act(() => useApp.getState().newChat());
    expect(useApp.getState().composeTarget).toBe(PROJECT);
  });

  it('aims at a project that does not exist yet when none is open', () => {
    act(() => useApp.getState().newChat());
    expect(useApp.getState().composeTarget).toBeNull();
  });

  it('puts the playtest column away — a blank page has nothing beside it', () => {
    resetStore({ projectPath: PROJECT, paneOpen: true, paneChoice: true });
    act(() => useApp.getState().newChat());
    expect(useApp.getState().paneOpen).toBe(false);
    // ...without forgetting that this project likes it open.
    expect(useApp.getState().paneChoice).toBe(true);
  });

  it('stops the moment a real conversation opens', () => {
    resetStore({ projectPath: PROJECT, composing: true });
    act(() =>
      useApp
        .getState()
        .receiveFrame({ type: 'chat-opened', chat: { id: 'c9' }, records: [] } as never),
    );
    expect(useApp.getState().composing).toBe(false);
  });
});

describe('what a project looks like', () => {
  it('is never blank — a mark and a colour exist before anyone picks one', () => {
    const derived = resolveIdentity(PROJECT);
    expect(PROJECT_ICONS).toContain(derived.icon);
    expect(PROJECT_COLORS.map((c) => c.key)).toContain(derived.color);
    expect(derived.colorValue.startsWith('oklch(')).toBe(true);
  });

  it('is stable: the same project looks the same every session', () => {
    expect(resolveIdentity(PROJECT)).toEqual(resolveIdentity(PROJECT));
  });

  it('distinguishes projects rather than giving them all the same mark', () => {
    const paths = ['/a/one', '/a/two', '/a/three', '/b/four', '/b/five', '/c/six'];
    const marks = paths.map((p) => {
      const { icon, color } = resolveIdentity(p);
      return `${icon}:${color}`;
    });
    expect(new Set(marks).size).toBe(paths.length);
  });

  it('lets a project override one half without losing the other', () => {
    // Someone who picks a colour keeps the derived mark, rather than being
    // reset to a default glyph they never asked for.
    const derived = resolveIdentity(PROJECT);
    const picked = resolveIdentity(PROJECT, { color: 'teal' });
    expect(picked.color).toBe('teal');
    expect(picked.icon).toBe(derived.icon);
  });

  it('ignores a stored value that is not in the vocabulary', () => {
    // An older or hand-edited project.json must not render a missing glyph.
    const odd = resolveIdentity(PROJECT, { icon: 'not-a-real-icon', color: 'chartreuse' });
    expect(PROJECT_ICONS).toContain(odd.icon);
    expect(PROJECT_COLORS.map((c) => c.key)).toContain(odd.color);
  });
});

describe('the Projects list', () => {
  it('shows every project as one list, in the order the server gave them', async () => {
    vi.mocked(apiRecentWorkspaces).mockResolvedValue([
      workspace('/work/other', 'other'),
      workspace(PROJECT, 'lighthouse'),
    ]);
    resetStore({ projectPath: PROJECT, projectName: 'lighthouse' });
    render(<Sidebar />);
    const names = await screen.findAllByText(/lighthouse|other/);
    // The open project is marked, not moved. Hoisting it meant a click both
    // selected a project and rewrote the list under the pointer.
    expect(names.map((el) => el.textContent)).toEqual(['other', 'lighthouse']);
  });

  it('drops a project that is no longer on disk rather than showing a dead row', async () => {
    vi.mocked(apiRecentWorkspaces).mockResolvedValue([
      workspace('/work/gone', 'gone', { exists: false }),
      workspace('/work/here', 'here'),
    ]);
    render(<Sidebar />);
    expect(await screen.findByText('here')).toBeTruthy();
    expect(screen.queryByText('gone')).toBeNull();
  });

  it('teaches what a project is when there are none', () => {
    render(<Sidebar />);
    expect(screen.getByText('Every game you make is a project. Describe one to begin.')).toBeTruthy();
  });
});

/**
 * The name and the folder are two different facts, and the screen that is
 * ABOUT one project is where both belong: the name it was given, at the size
 * of a title, and the folder it actually landed in, quietly, for anyone who
 * has to find it on disk. Before the name was stored these were the same
 * string, so there was nothing to tell.
 */
describe('the project screen', () => {
  const PLACE = '/Users/someone/Hearth/cafe-adventure';

  // The screen reads its instructions, its context and its playtests on
  // mount. None of that is what these two tests are about, and an unanswered
  // fetch is a page of noise per render.
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the name that was typed as the title', async () => {
    resetStore({ projectPath: PLACE, projectName: 'Café Adventure', chatsLoaded: true });
    render(<ProjectHome />);
    expect(await screen.findByRole('heading', { name: 'Café Adventure', level: 1 })).toBeTruthy();
  });

  it('says which folder that name landed in, so the game is findable on disk', async () => {
    resetStore({ projectPath: PLACE, projectName: 'Café Adventure', chatsLoaded: true });
    render(<ProjectHome />);
    const where = await screen.findByText(PLACE);
    expect(where.classList.contains('proj-path')).toBe(true);
  });
});

describe('stableOrder', () => {
  const rows = (...paths: string[]) => paths.map((path) => ({ path }));

  it('takes the incoming order the first time, when nothing is remembered', () => {
    expect(stableOrder(rows('a', 'b', 'c'), [])).toEqual(rows('a', 'b', 'c'));
  });

  it('holds the remembered order however the server reshuffles', () => {
    // The server sorts by last opened, so opening 'c' brings it back first.
    // The rail must not move under the pointer for that.
    expect(stableOrder(rows('c', 'a', 'b'), ['a', 'b', 'c'])).toEqual(rows('a', 'b', 'c'));
  });

  it('puts a project it has never seen at the front, where a new one is looked for', () => {
    expect(stableOrder(rows('a', 'fresh', 'b'), ['a', 'b'])).toEqual(rows('fresh', 'a', 'b'));
  });

  it('drops what is gone without disturbing what is left', () => {
    expect(stableOrder(rows('a', 'c'), ['a', 'b', 'c'])).toEqual(rows('a', 'c'));
  });
});
