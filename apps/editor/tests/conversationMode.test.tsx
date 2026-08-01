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
import { providerLabel } from '../src/components/chat/ConversationHead';
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
const devTeamLayer = () => document.querySelector('.conversation-layer.is-devteam');

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
    anthropic: { hasKey: false, source: null, cli: false, loggedIn: false, email: null, planType: null },
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
  it('states the kind rather than offering to change it', () => {
    // A conversation is a chat or a terminal from the moment it starts, and
    // one cannot become the other: what ran in a shell is not replayable as a
    // transcript. So the head reports the kind where it used to switch it, and
    // changing kind means starting a conversation.
    render(<ChatColumn />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(document.querySelector('.conversation-kind')?.textContent).toBe('Chat');
  });

  it('will not start a terminal conversation without a project', () => {
    // The shell runs in the project folder, so with no folder open there is
    // nothing to start and nowhere to write the record. The refusal moved into
    // the store when the switch was removed.
    useApp.setState({ projectPath: null, conversationMode: 'chat' });
    useApp.getState().setConversationMode('terminal');
    expect(useApp.getState().conversationMode).toBe('chat');
  });

  it('reads out who would answer while in chat mode', () => {
    render(<ChatColumn />);
    expect(document.querySelector('.conversation-provider')).not.toBeNull();
  });

  it('names the known drivers, and does not call an unknown one nobody', () => {
    expect(providerLabel(null, 'agent-sdk')).toBe('Claude');
    expect(providerLabel(null, 'codex')).toBe('ChatGPT');
    // Transcripts written by builds that still had registered agents carry
    // `custom` (see ChatDriverKind's note in types.ts). Narrowing that to
    // "No agent" told the reader of a real conversation that nobody had
    // answered it; somebody did, through a door this app no longer has. The
    // label says that and stops, in the past tense the fact deserves.
    expect(providerLabel(null, 'custom')).toBe('Custom agent (retired)');
    // And "No agent" stays reserved for when there genuinely was none.
    expect(providerLabel(null, null)).toBe('No agent');
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

describe('the dev team is a lazy third conversation layer', () => {
  it('mounts only after first use, then stays mounted when another conversation kind is shown', () => {
    render(<ChatColumn />);
    expect(devTeamLayer()).toBeNull();

    act(() => useApp.setState({ conversationMode: 'devteam' }));
    const mounted = devTeamLayer();
    expect(mounted).not.toBeNull();
    expect(mounted?.getAttribute('data-active')).toBe('true');

    act(() => useApp.setState({ conversationMode: 'chat' }));
    expect(devTeamLayer()).toBe(mounted);
    expect(mounted?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the chat empty state without a key', () => {
  beforeEach(() => {
    // `chatDriver: 'stub'` is the part that makes this state real: the socket
    // bound and found nothing to talk to. Settings alone is not enough to say
    // so, because a CLI agent needs no key.
    resetStore({ settings: { hasKey: false, source: null }, chatDriver: 'stub' });
  });

  it('offers exactly one way forward, and it is Settings', () => {
    // It used to offer three (terminal, ChatGPT sign-in, add a key), which is
    // three chances to pick the wrong one. Settings is where all of those
    // routes already live, so the empty state points at the room rather than
    // reproducing its doors.
    render(<ChatColumn />);
    const opened = vi.fn();
    window.addEventListener('hearth:open-settings', opened);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    window.removeEventListener('hearth:open-settings', opened);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Switch to Terminal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in with ChatGPT' })).toBeNull();
  });

  it('does not push once an agent is connected', () => {
    resetStore({ settings: { hasKey: true, source: 'project' }, chatDriver: 'agent-sdk' });
    render(<ChatColumn />);
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull();
  });

  it('says nothing at all while it does not know yet', () => {
    // The first moment of a new chat: the socket has not said which driver
    // bound and the settings call has not returned. Reporting that as "no
    // agent is connected" told people with a working setup that it was broken.
    resetStore({ settings: null, providers: null, chatDriver: null });
    render(<ChatColumn />);
    expect(screen.queryByText(/No agent is connected/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull();
  });
});

describe('the game pane stack', () => {
  it('shows Game, Tester and Console — the shell is not one of its surfaces', () => {
    useApp.setState({ projectPath: null });
    render(<PaneStack />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Game', 'Tester', 'Console']);
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
