// @vitest-environment jsdom
/**
 * Every place the app can go INTO has to have a way out, and the way out has
 * to name where it comes out.
 *
 * Two surfaces are covered here, for opposite reasons:
 *
 *   1. A conversation had no way back to the project it belongs to. It has one
 *      now, in the conversation's own head, labelled with the project's name —
 *      and it appears only when there is a project to go back to, because a
 *      control that leads nowhere is worse than no control at all.
 *
 *   2. The project screen had a "Projects /" breadcrumb whose clickable crumb
 *      called closeWorkspace() — it did not go to a list of projects (the app
 *      has no such screen; the rail is the list), it shut the open one. That
 *      crumb is gone, and these pin that it stays gone while the honest way to
 *      close a project stays where it is.
 *
 * xterm is mocked for the same reason conversationMode.test.tsx mocks it: the
 * head's terminal read-out shares a socket hook with the pane, and a real xterm
 * needs canvas metrics jsdom does not have.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/components/agent/Terminal', () => ({
  Terminal: () => <div data-testid="xterm" />,
  resendTerminalSizeThenFocus: () => {},
}));

import { ConversationHead } from '../src/components/chat/ConversationHead';
import { ProjectHome } from '../src/components/project/ProjectHome';
import { screenBackLabel } from '../src/components/ui/ScreenHeader';
import { useApp } from '../src/store';
import type { DevTeamSnapshot } from '../src/types';

type State = ReturnType<typeof useApp.getState>;

const PROJECT = '/work/ember';

const DEV_TEAM: DevTeamSnapshot = {
  version: 1,
  runId: 'run-1',
  phase: 'wrapping',
  plan: null,
  tasks: [],
  approvals: [],
  history: [],
  currentMilestone: 0,
  spec: '# Ember',
  specVersion: 1,
  summary: null,
  wrap: null,
  error: null,
};

/** The action a back control must land on: the project's own screen. */
const showProject = vi.fn();

function patchStore(over: Partial<State> = {}): void {
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'Ember',
    conversationMode: 'chat',
    conversationModePinned: true,
    chats: [],
    messages: [],
    providers: null,
    chatDriver: null,
    settings: { hasKey: true, source: 'project' },
    wsStatus: 'disconnected',
    showProject,
    ...over,
  } as unknown as Partial<State>);
}

/** The recents read ProjectHome does on mount, answered without a server. */
function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, projects: [] }) }) as Response),
  );
}

beforeEach(() => {
  localStorage.clear();
  showProject.mockClear();
  installFetch();
  patchStore();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const backButton = () => screen.queryByRole('button', { name: /^Back to / });

/**
 * The rule both global screens share. Skills named the project; the Tester
 * screen said "Back", which is the gesture rather than the destination and the
 * one thing a way out of a place must not say.
 */
describe('screenBackLabel', () => {
  it('names the project waiting underneath', () => {
    expect(screenBackLabel('Ember', PROJECT)).toBe('Ember');
  });

  it('names the blank surface when there is no project — never a screen the app lacks', () => {
    // "Chats" was the old answer. The rail has a Chats list; the app has no
    // Chats screen, and leaving lands on the blank surface, which is New chat.
    expect(screenBackLabel(null, null)).toBe('New chat');
    expect(screenBackLabel('Ember', null)).toBe('New chat');
    expect(screenBackLabel('', PROJECT)).toBe('New chat');
  });
});

describe('a conversation’s way back', () => {
  it('names the project rather than the gesture', () => {
    render(<ConversationHead />);
    const back = screen.getByRole('button', { name: 'Back to Ember' });
    // The label a reader sees is the destination itself.
    expect(back.textContent).toBe('Ember');
  });

  it('lands on the project’s own screen when clicked', () => {
    render(<ConversationHead />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Ember' }));
    expect(showProject).toHaveBeenCalledTimes(1);
  });

  it('is absent with no project open, rather than present and dead', () => {
    // Home's composer and a projectless conversation both live here.
    patchStore({ projectPath: null, projectName: null });
    render(<ConversationHead />);
    expect(backButton()).toBeNull();
  });

  it('is there in the terminal too — the way out does not depend on the mode', () => {
    patchStore({ conversationMode: 'terminal' });
    render(<ConversationHead />);
    expect(screen.getByRole('button', { name: 'Back to Ember' })).toBeTruthy();
  });

  it('leaves what the head already said alone', () => {
    // Adding a way out must not cost the head either of the two things it
    // already reported. The kind used to be a switch and is now a read-out,
    // because the choice is made when a conversation starts: what is checked
    // here is that the head still states it, not how.
    render(<ConversationHead />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(document.querySelector('.conversation-kind')?.textContent).toBe('Chat');
    expect(document.querySelector('.conversation-provider')).not.toBeNull();
  });

  it('wears the same back treatment as a full screen’s header', () => {
    // One back affordance in the app, not two that nearly match.
    render(<ConversationHead />);
    expect(screen.getByRole('button', { name: 'Back to Ember' }).classList.contains('screen-back')).toBe(true);
  });

  it('withholds CLI handoff until a dev team run is done', () => {
    patchStore({
      conversationMode: 'devteam',
      activeChatId: 'team-chat',
      chats: [{
        id: 'team-chat',
        title: 'Dev team',
        kind: 'devteam',
        claudeSessionId: 'claude-session-1',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      }],
      devTeam: DEV_TEAM,
    });
    render(<ConversationHead />);

    expect(screen.queryByRole('button', { name: 'Continue in CLI' })).toBeNull();

    act(() => useApp.setState({ devTeam: { ...DEV_TEAM, phase: 'done' } }));
    expect(screen.getByRole('button', { name: 'Continue in CLI' })).toBeTruthy();
  });
});

describe('the project screen’s crumbs', () => {
  async function mountProject(): Promise<void> {
    render(<ProjectHome />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  }

  it('offers no crumb to a list of projects, because there is no such screen', async () => {
    await mountProject();
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
    expect(document.querySelector('.proj-crumbs')).toBeNull();
  });

  it('still says where you are, in the one place that says it', async () => {
    await mountProject();
    expect(screen.getByRole('heading', { name: 'Ember', level: 1 })).toBeTruthy();
  });

  it('keeps closing the project as a named act, not a crumb', async () => {
    await mountProject();
    expect(screen.getByRole('button', { name: 'Project options for Ember' })).toBeTruthy();
  });

  it('renders nothing at all without a project', () => {
    patchStore({ projectPath: null, projectName: null });
    const { container } = render(<ProjectHome />);
    expect(container.textContent).toBe('');
  });
});

/**
 * A list that has not been read yet is not an empty list. The project screen
 * is shown the moment a project is clicked, ahead of its own round trip.
 */
describe('the project screen’s conversation list', () => {
  async function mount(over: Partial<State>): Promise<void> {
    patchStore(over);
    render(<ProjectHome />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  }

  it('offers no first-conversation invitation before the index has been read', async () => {
    // "No conversations yet" in front of a project with twelve of them is a
    // claim the screen has to take back a moment later.
    await mount({ chats: [], chatsLoaded: false } as Partial<State>);
    expect(screen.queryByText(/No conversations yet/i)).toBeNull();
    expect(screen.getByText(/Looking for this project/i)).toBeTruthy();
  });

  it('says it once the read has landed and the project really is empty', async () => {
    await mount({ chats: [], chatsLoaded: true } as Partial<State>);
    expect(screen.getByText(/No conversations yet/i)).toBeTruthy();
  });
});

/**
 * Playtesting is per-project, so the project's own screen is where it has to
 * be addressable.
 *
 * The section used to render nothing until a session existed: a game that had
 * never been played said nothing about playtesting on the one screen that is
 * about that game, and the only ways in were the rail's global Tester (aim it
 * at the right game first) or the top bar's column toggle and then a tab.
 */
describe('the project screen’s playtests', () => {
  const openTesterFor = vi.fn();

  async function mountWith(over: Partial<State>): Promise<void> {
    patchStore({ openTesterFor, ...over } as Partial<State>);
    render(<ProjectHome />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  }

  beforeEach(() => openTesterFor.mockClear());

  it('is there before anything has ever played', async () => {
    await mountWith({ tester: { ...useApp.getState().tester, sessions: [], historyLoaded: true } } as Partial<State>);
    expect(screen.getByRole('region', { name: 'Playtests' })).toBeTruthy();
    expect(screen.getByText(/has not played this game yet/i)).toBeTruthy();
  });

  it('does not claim "never played" before the folder has been read', async () => {
    // The folder's history arrives over a round trip. Hold that one open — the
    // rest of the screen still mounts — so what is on screen is what a person
    // sees while the read is in flight.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/tester/history')) return new Promise<Response>(() => {});
        return { ok: true, status: 200, json: async () => ({ ok: true, projects: [] }) } as Response;
      }),
    );
    await mountWith({ tester: { ...useApp.getState().tester, sessions: [], historyLoaded: false } } as Partial<State>);
    expect(screen.queryByText(/has not played this game yet/i)).toBeNull();
    expect(screen.getByText(/Looking for past sessions/i)).toBeTruthy();
  });

  it('aims its way in at THIS game, not at whatever played last', async () => {
    // The Tester screen is global and its Play defaults to the most recently
    // played game anywhere. A link pressed from Ember's own screen must not
    // put a Play for another game under the pointer.
    await mountWith({ tester: { ...useApp.getState().tester, sessions: [], historyLoaded: true } } as Partial<State>);
    fireEvent.click(screen.getByRole('button', { name: 'Playtest this game' }));
    expect(openTesterFor).toHaveBeenCalledWith(PROJECT);
  });
});
