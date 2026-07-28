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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/components/agent/Terminal', () => ({
  Terminal: () => <div data-testid="xterm" />,
  resendTerminalSizeThenFocus: () => {},
}));

import { ConversationHead } from '../src/components/chat/ConversationHead';
import { ProjectHome } from '../src/components/project/ProjectHome';
import { useApp } from '../src/store';

type State = ReturnType<typeof useApp.getState>;

const PROJECT = '/work/ember';

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
