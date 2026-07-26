// @vitest-environment jsdom
/**
 * The conversation column is either a chat with the built-in agent or a real
 * shell running the user's own CLI agent, and the choice is theirs.
 *
 * These pin the four contracts that make that true rather than merely present:
 *   1. choosing a mode moves the column and the choice persists per folder
 *      (the control itself now lives in the sidebar, not in this column — see
 *      the sidebar's own tests for the pill);
 *   2. flipping back to chat HIDES the terminal — the xterm host stays mounted,
 *      because unmounting it would drop the pty's scrollback and (worse)
 *      re-attaching a second instance would double-render the session;
 *   3. the game pane's tabs are Game / Console — the shell is not a readout and
 *      no longer lives there (a second xterm on one pty is the bug this
 *      prevents);
 *   4. the empty state's "Switch to Terminal" is a real control, not prose.
 *
 * xterm is mocked: this file is about mounting and persistence, and a real
 * xterm instance needs canvas metrics jsdom doesn't have. Its own units are
 * covered DOM-free in useAgentSocket.test.ts / terminalEpoch.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../src/components/agent/Terminal', () => ({
  Terminal: ({ onData }: { onData: (data: string) => void }) => (
    <div data-testid="xterm" onClick={() => onData('x')} />
  ),
  resendTerminalSizeThenFocus: () => {},
}));

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiAppSettings: vi.fn(),
}));

import { apiAppSettings } from '../src/api';
import type { ChatProviderStatus } from '../src/types';
import { ChatColumn } from '../src/components/chat/ChatColumn';
import { PaneStack } from '../src/components/game/PaneStack';
import { terminalStatusLabel } from '../src/components/chat/TerminalPane';
import {
  conversationModeStorageKey,
  defaultConversationMode,
  readConversationMode,
  useApp,
} from '../src/store';

const PROJECT = '/work/game';

function resetStore(over: Partial<ReturnType<typeof useApp.getState>> = {}): void {
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'game',
    conversationMode: 'chat',
    conversationModePinned: true,
    messages: [],
    chatDriver: null,
    settings: { hasKey: true, source: 'project' },
    wsStatus: 'disconnected',
    paneTab: 'game',
    ...over,
  });
}

/** What the sidebar's mode pill does, without depending on the sidebar. */
const chooseMode = (mode: 'chat' | 'terminal') => act(() => useApp.getState().setConversationMode(mode));
const terminalLayer = () => document.querySelector('.conversation-layer.is-terminal');
const chatLayer = () => document.querySelector('.conversation-layer.is-chat');

beforeEach(() => {
  localStorage.clear();
  resetStore();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// ---------------------------------------------------------------------------

describe('defaultConversationMode — where a new folder lands', () => {
  it('opens the chat when a key can answer it', () => {
    expect(defaultConversationMode(true)).toBe('chat');
  });

  it('opens the terminal when nothing else can', () => {
    expect(defaultConversationMode(false)).toBe('terminal');
  });
});

describe('per-folder persistence', () => {
  it('keys the preference by folder root, so two projects can differ', () => {
    expect(conversationModeStorageKey('/a')).not.toBe(conversationModeStorageKey('/b'));
    localStorage.setItem(conversationModeStorageKey('/a'), 'terminal');
    localStorage.setItem(conversationModeStorageKey('/b'), 'chat');
    expect(readConversationMode('/a')).toBe('terminal');
    expect(readConversationMode('/b')).toBe('chat');
  });

  it('reads nothing back for a folder that has never chosen', () => {
    expect(readConversationMode('/never-opened')).toBeNull();
  });

  it('ignores a corrupted value rather than trusting it', () => {
    localStorage.setItem(conversationModeStorageKey(PROJECT), 'nonsense');
    expect(readConversationMode(PROJECT)).toBeNull();
  });

  it('writes the folder preference when the user picks a mode', () => {
    act(() => useApp.getState().setConversationMode('terminal'));
    expect(localStorage.getItem(conversationModeStorageKey(PROJECT))).toBe('terminal');
    expect(useApp.getState().conversationMode).toBe('terminal');
  });
});

/** A providers read-out with the given OpenAI facts and no Anthropic key. */
function providersWith(openai: Partial<{ loggedIn: boolean; hasKey: boolean }>): ChatProviderStatus {
  return {
    anthropic: { hasKey: false, source: null },
    openai: {
      installed: false,
      version: null,
      loggedIn: false,
      authMode: null,
      email: null,
      planType: null,
      hasKey: false,
      ...openai,
    },
    active: null,
  };
}

describe('first-run default vs. an explicit choice', () => {
  it('lands in the terminal when neither a key nor a sign-in can answer', async () => {
    resetStore({ conversationModePinned: false, settings: null, providers: providersWith({}) });
    vi.mocked(apiAppSettings).mockResolvedValue({ hasKey: false, source: null });

    await act(async () => {
      await useApp.getState().refreshSettings();
    });

    expect(useApp.getState().conversationMode).toBe('terminal');
    expect(useApp.getState().conversationModePinned).toBe(true);
  });

  it('lands in the chat when a signed-in Codex can answer, key or no key', async () => {
    resetStore({ conversationModePinned: false, settings: null, providers: providersWith({ loggedIn: true }) });
    vi.mocked(apiAppSettings).mockResolvedValue({ hasKey: false, source: null });

    await act(async () => {
      await useApp.getState().refreshSettings();
    });

    expect(useApp.getState().conversationMode).toBe('chat');
    expect(useApp.getState().conversationModePinned).toBe(true);
  });

  it('waits for the providers read before deciding, so codex is never missed', async () => {
    resetStore({ conversationModePinned: false, settings: null, providers: null });
    vi.mocked(apiAppSettings).mockResolvedValue({ hasKey: false, source: null });

    await act(async () => {
      await useApp.getState().refreshSettings();
    });

    // Settings alone must not park the folder in the terminal — the providers
    // read may still reveal a signed-in Codex.
    expect(useApp.getState().conversationModePinned).toBe(false);
  });

  it('never moves the column once the user has chosen — even if a key appears', async () => {
    resetStore({ conversationModePinned: false, settings: null });
    act(() => useApp.getState().setConversationMode('terminal'));
    vi.mocked(apiAppSettings).mockResolvedValue({ hasKey: true, source: 'project' });

    await act(async () => {
      await useApp.getState().refreshSettings();
    });

    expect(useApp.getState().conversationMode).toBe('terminal');
  });

  it('settles nothing when the settings read fails, so the next one still decides', async () => {
    resetStore({ conversationModePinned: false, settings: null });
    vi.mocked(apiAppSettings).mockResolvedValue(null);

    await act(async () => {
      await useApp.getState().refreshSettings();
    });

    expect(useApp.getState().conversationModePinned).toBe(false);
  });
});

describe('the conversation head', () => {
  it('carries no mode control of its own — that pill lives in the sidebar', () => {
    render(<ChatColumn />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(document.querySelector('.conversation-switch')).toBeNull();
  });

  it('reads out who would answer while in chat mode', () => {
    render(<ChatColumn />);
    expect(document.querySelector('.conversation-provider')).not.toBeNull();
  });

  it('switches the column to the terminal, and back, off the store', () => {
    render(<ChatColumn />);

    chooseMode('terminal');
    expect(useApp.getState().conversationMode).toBe('terminal');
    expect(terminalLayer()?.getAttribute('data-active')).toBe('true');

    chooseMode('chat');
    expect(useApp.getState().conversationMode).toBe('chat');
    expect(chatLayer()?.getAttribute('data-active')).toBe('true');
  });

  it('persists the switch for this folder', () => {
    render(<ChatColumn />);
    chooseMode('terminal');
    expect(localStorage.getItem(conversationModeStorageKey(PROJECT))).toBe('terminal');
  });

  it('names the folder the shell is running in, but only in terminal mode', () => {
    render(<ChatColumn />);
    expect(document.querySelector('.terminal-cwd')).toBeNull();
    chooseMode('terminal');
    expect(document.querySelector('.terminal-cwd')?.textContent).toContain('game');
  });
});

describe('the terminal survives the toggle', () => {
  it('does not spawn a shell for someone who never opens one', () => {
    render(<ChatColumn />);
    expect(terminalLayer()).toBeNull();
  });

  it('keeps the xterm host mounted after switching back to chat', () => {
    render(<ChatColumn />);

    chooseMode('terminal');
    const mounted = terminalLayer();
    expect(mounted).not.toBeNull();
    expect(mounted?.getAttribute('data-active')).toBe('true');

    chooseMode('chat');
    // Still the SAME element: hidden, never unmounted. Unmounting would drop
    // the pty's scrollback, and a later remount would attach a second view.
    expect(terminalLayer()).toBe(mounted);
    expect(mounted?.getAttribute('data-active')).toBe('false');
    expect(mounted?.getAttribute('aria-hidden')).toBe('true');

    chooseMode('terminal');
    expect(terminalLayer()).toBe(mounted);
    expect(mounted?.getAttribute('data-active')).toBe('true');
  });

  it('keeps the chat layer mounted too, so the transcript is not rebuilt per toggle', () => {
    render(<ChatColumn />);
    const chat = chatLayer();
    chooseMode('terminal');
    expect(chatLayer()).toBe(chat);
    expect(chat?.getAttribute('data-active')).toBe('false');
  });

  it('opens straight into a mounted terminal when that is the folder’s mode', () => {
    resetStore({ conversationMode: 'terminal' });
    render(<ChatColumn />);
    expect(terminalLayer()?.getAttribute('data-active')).toBe('true');
  });
});

describe('the chat empty state without a key', () => {
  beforeEach(() => {
    resetStore({ settings: { hasKey: false, source: null } });
  });

  it('offers switching to the terminal as a real control, not as prose', () => {
    render(<ChatColumn />);
    const button = screen.getByRole('button', { name: 'Switch to Terminal' });
    fireEvent.click(button);
    expect(useApp.getState().conversationMode).toBe('terminal');
    expect(terminalLayer()).not.toBeNull();
  });

  it('keeps adding a key as the other way forward', () => {
    render(<ChatColumn />);
    const opened = vi.fn();
    window.addEventListener('hearth:open-settings', opened);
    fireEvent.click(screen.getByRole('button', { name: 'Add a key in Settings' }));
    window.removeEventListener('hearth:open-settings', opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('does not push either way once an agent is connected', () => {
    resetStore({ settings: { hasKey: true, source: 'project' } });
    render(<ChatColumn />);
    expect(screen.queryByRole('button', { name: 'Switch to Terminal' })).toBeNull();
  });
});

describe('the game pane stack', () => {
  it('shows Game and Console — the shell is not one of its surfaces', () => {
    useApp.setState({ projectPath: null });
    render(<PaneStack />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Game', 'Console']);
  });
});

describe('terminalStatusLabel', () => {
  it('says nothing at all while the shell is simply running', () => {
    expect(terminalStatusLabel('running')).toBeNull();
  });

  it('names every state a user might need to act on', () => {
    expect(terminalStatusLabel('reconnecting')).toBe('Reconnecting');
    expect(terminalStatusLabel('exited')).toBe('Stopped');
    expect(terminalStatusLabel('idle')).toBe('Starting');
  });
});
