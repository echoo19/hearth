// @vitest-environment jsdom
/**
 * Where am I. The app has to have exactly one answer to that, and every
 * surface has to give the same one.
 *
 * New chat, Skills and Tester belong to the person, not to a game. Standing on
 * one of them means you are not in a project — even though a project may still
 * be OPEN underneath, socket up and game running, because tearing that down
 * would make every visit to Skills cost a reconnect.
 *
 * The rail used to say the opposite. It kept `aria-current` on both the open
 * project row and the active chat row while Skills filled the window, so a
 * screen reader was told you were in a conversation that was not on the
 * screen, and the nav rows carried no active state at all — their apparent
 * highlight was `:hover`, which vanished the moment the pointer moved. Sighted
 * users got no answer and blind users got a wrong one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiRecentWorkspaces: vi.fn(),
  apiRecentChats: vi.fn(async () => []),
}));

import { apiRecentWorkspaces } from '../src/api';
import { Sidebar } from '../src/components/shell/Sidebar';
import { TopBar } from '../src/components/shell/TopBar';
import { globalPlace, useApp } from '../src/store';
import type { RecentChatEntry, RecentWorkspace } from '../src/types';

const PROJECT = '/work/lighthouse';
const OTHER = '/work/harbour';

const workspace = (path: string, name: string): RecentWorkspace => ({ path, name, exists: true });

/**
 * The conversation row's open button. Queried by class rather than by name:
 * its accessible name is the mark, the kind, the title and the time run
 * together, and the row's overflow menu answers to the title too.
 */
const chatRow = (container: HTMLElement): HTMLElement => {
  const row = container.querySelector('.chat-open');
  if (!row) throw new Error('no conversation row in the rail');
  return row as HTMLElement;
};

const chat = (id: string, project: string, name: string): RecentChatEntry =>
  ({
    id,
    title: `About ${id}`,
    updatedAt: '2026-07-28T12:00:00.000Z',
    project: { path: project, name },
  }) as RecentChatEntry;

function resetStore(over: Partial<ReturnType<typeof useApp.getState>> = {}): void {
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'lighthouse',
    sidebarCollapsed: false,
    chats: [],
    recentChats: [chat('c1', PROJECT, 'lighthouse')],
    activeChatId: 'c1',
    composing: false,
    projectView: false,
    screen: null,
    ...over,
  } as Partial<ReturnType<typeof useApp.getState>>);
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiRecentWorkspaces).mockResolvedValue([workspace(PROJECT, 'lighthouse'), workspace(OTHER, 'harbour')]);
  resetStore();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('globalPlace', () => {
  it('is null inside a project, however the project is being viewed', () => {
    expect(globalPlace({ screen: null, composing: false, projectPath: PROJECT })).toBeNull();
  });

  it('names the screen you are standing on', () => {
    expect(globalPlace({ screen: 'skills', composing: false, projectPath: PROJECT })).toBe('skills');
    expect(globalPlace({ screen: 'tester', composing: false, projectPath: PROJECT })).toBe('tester');
    expect(globalPlace({ screen: null, composing: true, projectPath: PROJECT })).toBe('new-chat');
  });

  it('lets a screen win over the blank composer it was opened from', () => {
    // Skills opened from New chat is Skills. Leaving it returns to the blank
    // composer, which is why `composing` is left standing rather than cleared.
    expect(globalPlace({ screen: 'skills', composing: true, projectPath: PROJECT })).toBe('skills');
  });

  it('is New chat with no folder open, which is where the app starts', () => {
    // The state this got wrong. At first launch and after every Close project,
    // `projectPath` is null and `composing` is false, and the window shows the
    // blank composer. Reading only `composing` answered "you are in a project"
    // and the rail marked nothing at all, which is the exact failure this
    // function exists to prevent.
    expect(globalPlace({ screen: null, composing: false, projectPath: null })).toBe('new-chat');
    // A screen still wins, with or without a folder underneath it.
    expect(globalPlace({ screen: 'skills', composing: false, projectPath: null })).toBe('skills');
  });
});

describe('the rail with no project open', () => {
  it('marks New chat, because that is what the window is showing', async () => {
    resetStore({ projectPath: null, projectName: null, activeChatId: null, recentChats: [] });
    render(<Sidebar />);
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'New chat' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'lighthouse' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('the rail on a global screen', () => {
  for (const [place, label] of [
    ['skills', 'Skills'],
    ['tester', 'Tester'],
  ] as const) {
    it(`marks ${label} and nothing else`, async () => {
      resetStore();
      const { container } = render(<Sidebar />);
      await act(async () => {
        useApp.getState().openScreen(place);
      });

      expect(screen.getByRole('button', { name: label }).getAttribute('aria-current')).toBe('page');
      // The project is still open — the socket is up and the game is running —
      // but it is not where you are, so it is not announced as current.
      expect(screen.getByRole('button', { name: 'lighthouse' }).getAttribute('aria-current')).toBeNull();
      expect(chatRow(container).getAttribute('aria-current')).toBeNull();
    });
  }

  it('marks New chat and nothing else', async () => {
    const { container } = render(<Sidebar />);
    await act(async () => {
      useApp.getState().newChat();
    });

    expect(screen.getByRole('button', { name: 'New chat' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'lighthouse' }).getAttribute('aria-current')).toBeNull();
    expect(chatRow(container).getAttribute('aria-current')).toBeNull();
  });

  it('leaves the folder open, so coming back costs nothing', async () => {
    render(<Sidebar />);
    await act(async () => {
      useApp.getState().openScreen('skills');
    });
    expect(useApp.getState().projectPath).toBe(PROJECT);
  });

  it('restores the arrangement the screen covered', async () => {
    resetStore({ projectView: true });
    render(<Sidebar />);
    await act(async () => {
      useApp.getState().openScreen('skills');
    });
    await act(async () => {
      useApp.getState().closeScreen();
    });
    expect(useApp.getState().projectView).toBe(true);
    expect(globalPlace(useApp.getState())).toBeNull();
  });
});

/**
 * The strip above the working area has to give the same answer as the rail.
 *
 * It did not. While Skills filled the window it went on naming the
 * conversation underneath — the header saying one thing and the body showing
 * another — and it kept offering the playtest column's toggle, which moved a
 * column that was not on screen: pressing it did nothing anybody could see.
 */
describe('the top bar on a global screen', () => {
  const title = () => document.querySelector('.topbar-name');
  const playToggle = () => screen.queryByRole('button', { name: /playtest/i });

  it('names the conversation while you are actually in it', () => {
    resetStore({ chats: [{ id: 'c1', title: 'Raising the jump', updatedAt: '' }] as never });
    render(<TopBar narrow={false} paneOpen={false} />);
    expect(title()?.textContent).toBe('Raising the jump');
    expect(playToggle()).not.toBeNull();
  });

  for (const place of ['skills', 'tester'] as const) {
    it(`names nothing and offers nothing on ${place}`, async () => {
      resetStore({ chats: [{ id: 'c1', title: 'Raising the jump', updatedAt: '' }] as never });
      render(<TopBar narrow={false} paneOpen={false} />);
      await act(async () => {
        useApp.getState().openScreen(place);
      });
      expect(title()).toBeNull();
      expect(playToggle()).toBeNull();
    });
  }

  it('offers no column toggle on the blank new-chat surface either', async () => {
    // There is no playtest column beside a blank composer — the surface takes
    // the whole working area — so the toggle was a control that set a flag and
    // changed nothing on screen.
    render(<TopBar narrow={false} paneOpen={false} />);
    await act(async () => {
      useApp.getState().newChat();
    });
    expect(title()?.textContent).toBe('New chat');
    expect(playToggle()).toBeNull();
  });

  it('hides the narrow layout’s Conversation/Game switch on a screen', async () => {
    resetStore({ narrowTab: 'chat' } as never);
    render(<TopBar narrow paneOpen />);
    expect(screen.queryByRole('tablist', { name: 'Conversation or game' })).not.toBeNull();
    await act(async () => {
      useApp.getState().openScreen('skills');
    });
    expect(screen.queryByRole('tablist', { name: 'Conversation or game' })).toBeNull();
  });
});

/**
 * Closing a project is an act about a project. A global screen is not one, so
 * it must survive: Skills is the person's library and the Tester screen is a
 * history across every game, and neither reads the open folder.
 */
describe('closing a project from a global screen', () => {
  for (const place of ['skills', 'tester'] as const) {
    it(`leaves you standing on ${place}`, () => {
      useApp.setState({ screen: place });
      useApp.getState().closeWorkspace();
      expect(useApp.getState().projectPath).toBeNull();
      expect(globalPlace(useApp.getState())).toBe(place);
    });
  }

  it('still takes the project’s own view down with it', () => {
    useApp.setState({ screen: null, projectView: true });
    useApp.getState().closeWorkspace();
    expect(useApp.getState().projectView).toBe(false);
    // And lands on New chat, because that is what the window now shows. With
    // no folder open `Shell` renders `Home`, so "nowhere" is not an answer the
    // rail is allowed to give.
    expect(globalPlace(useApp.getState())).toBe('new-chat');
  });
});

describe('the rail inside a project', () => {
  it('marks the open project and the conversation being read', async () => {
    const { container } = render(<Sidebar />);
    // A render is enough: the store already says we are in a project.
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'lighthouse' }).getAttribute('aria-current')).toBe('true');
    expect(chatRow(container).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Skills' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('button', { name: 'Tester' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('button', { name: 'New chat' }).getAttribute('aria-current')).toBeNull();
  });

  it('keeps offering Close project for the open folder while a screen is up', async () => {
    // Not current is not the same as not open. The folder can still be closed
    // from its own row, which is the only place that act lives.
    render(<Sidebar />);
    await act(async () => {
      useApp.getState().openScreen('skills');
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Project options for lighthouse' }).click();
    });
    expect(screen.getByRole('menuitem', { name: 'Close project' })).toBeTruthy();
  });
});
