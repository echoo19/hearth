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
    expect(globalPlace({ screen: null, composing: false })).toBeNull();
  });

  it('names the screen you are standing on', () => {
    expect(globalPlace({ screen: 'skills', composing: false })).toBe('skills');
    expect(globalPlace({ screen: 'tester', composing: false })).toBe('tester');
    expect(globalPlace({ screen: null, composing: true })).toBe('new-chat');
  });

  it('lets a screen win over the blank composer it was opened from', () => {
    // Skills opened from New chat is Skills. Leaving it returns to the blank
    // composer, which is why `composing` is left standing rather than cleared.
    expect(globalPlace({ screen: 'skills', composing: true })).toBe('skills');
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
