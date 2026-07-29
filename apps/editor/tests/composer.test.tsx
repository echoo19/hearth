// @vitest-environment jsdom
/**
 * The composer as a live control: one card, mounted in two places, with the
 * only difference being where a submit goes.
 *
 * On Home there is no folder and no socket yet — sending must still work,
 * because that submit is what CREATES the folder. In a conversation the same
 * keystroke has to reach `sendChat` instead. These pin both paths, plus the
 * Enter/Shift+Enter contract at the DOM level (the pure helper is covered in
 * chatSurface.test.ts) and the + menu's hand-off to the sidebar's picker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { Composer } from '../src/components/chat/Composer';
import { setModelChoice } from '../src/chat/modelChoice';
import { useApp } from '../src/store';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../src/chat/attachments';

type State = ReturnType<typeof useApp.getState>;

const sendChat = vi.fn();
const startFromHome = vi.fn();

/** `startFromHome` lands with the store in this same wave; stub it until then. */
function patchStore(over: Partial<State> = {}): void {
  useApp.setState({
    projectPath: null,
    projectName: null,
    messages: [],
    chatBusy: false,
    wsStatus: 'connected',
    providers: null,
    sendChat,
    startFromHome,
    ...over,
  } as unknown as Partial<State>);
}

const box = () => screen.getByLabelText('Message the agent') as HTMLTextAreaElement;

function type(value: string): void {
  fireEvent.change(box(), { target: { value } });
}

beforeEach(() => {
  localStorage.clear();
  // The model choice is a module-level store; clearing storage alone would
  // leave one test's pick standing in the next one.
  setModelChoice(null);
  sendChat.mockReset();
  startFromHome.mockReset();
  patchStore();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the home variant — sending is what creates the project', () => {
  it('hands the prompt to startFromHome, not to the chat socket', () => {
    render(<Composer variant="home" />);
    type('a top-down space shooter');
    fireEvent.keyDown(box(), { key: 'Enter' });

    expect(startFromHome).toHaveBeenCalledWith('a top-down space shooter', []);
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('sends with the button too', () => {
    render(<Composer variant="home" />);
    type('snake, but the walls wrap');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(startFromHome).toHaveBeenCalledWith('snake, but the walls wrap', []);
  });

  it('does not send an empty or whitespace-only box', () => {
    render(<Composer variant="home" />);
    fireEvent.keyDown(box(), { key: 'Enter' });
    type('   ');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(startFromHome).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts a project once, however impatiently the key is pressed', async () => {
    let settle = (): void => {};
    startFromHome.mockImplementation(() => new Promise<void>((resolve) => (settle = () => resolve())));
    render(<Composer variant="home" />);
    type('a one-screen platformer');

    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(startFromHome).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
    });
  });

  it('keeps what was typed until the folder actually exists', () => {
    startFromHome.mockImplementation(() => new Promise<void>(() => {}));
    render(<Composer variant="home" />);
    type('a puzzle game about tides');
    fireEvent.keyDown(box(), { key: 'Enter' });
    // Losing the prompt to a failed create is the worst outcome here.
    expect(box().value).toBe('a puzzle game about tides');
  });

  it('is not blocked by a chat socket it does not use', () => {
    patchStore({ wsStatus: 'disconnected' });
    render(<Composer variant="home" />);
    type('a racing game');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(startFromHome).toHaveBeenCalledTimes(1);
  });
});

describe('the in-chat variant', () => {
  it('sends the turn and clears the box', () => {
    render(<Composer />);
    type('add a second level');
    fireEvent.keyDown(box(), { key: 'Enter' });

    expect(sendChat).toHaveBeenCalledWith('add a second level', []);
    expect(startFromHome).not.toHaveBeenCalled();
    expect(box().value).toBe('');
  });

  it('breaks the line on Shift+Enter instead of sending', () => {
    render(<Composer />);
    type('first line');
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('keeps the ⌘↵ chord working for the people who learned it', () => {
    render(<Composer />);
    type('keep going');
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    expect(sendChat).toHaveBeenCalledWith('keep going', []);
  });

  it('says why it cannot send while the socket is down', () => {
    patchStore({ wsStatus: 'disconnected' });
    render(<Composer />);
    type('anything');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sendChat).not.toHaveBeenCalled();
    expect(document.querySelector('.composer-note')?.textContent).toContain('Reconnecting');
  });

  it('offers Stop instead of Send while a turn is running', () => {
    patchStore({ chatBusy: true });
    render(<Composer />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(useApp.getState().chatBusy).toBe(false);
  });
});

/**
 * Attaching several files at once.
 *
 * The caps are per-message, so they have to be judged against a count that is
 * true for every file in the batch. Reading that count through a functional
 * setState looked right and was not — React skips the eager updater once an
 * update is pending, so from the second file on nothing was checked at all.
 */
describe('the attachment tray', () => {
  function drop(files: File[]): void {
    const items = files.map((file) => ({ kind: 'file', getAsFile: () => file }));
    fireEvent.drop(document.querySelector('.composer-card')!, {
      dataTransfer: { items, files, types: ['Files'] },
    });
  }

  const png = (name: string, size = 64): File =>
    new File([new Uint8Array(size)], name, { type: 'image/png' });

  it('stops at the ceiling however many are dropped at once', async () => {
    render(<Composer />);
    drop(Array.from({ length: 20 }, (_, i) => png(`shot-${i}.png`)));
    // FileReader settles on its own turns; wait for the tray to fill.
    await waitFor(() => expect(document.querySelectorAll('.attach-item').length).toBe(MAX_ATTACHMENTS));
    // …and stay there rather than creeping past it a beat later.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.querySelectorAll('.attach-item').length).toBe(MAX_ATTACHMENTS);
  });

  it('refuses an oversized file even when a small one was dropped with it', async () => {
    render(<Composer />);
    drop([png('small.png'), png('huge.png', MAX_ATTACHMENT_BYTES + 1)]);
    await waitFor(() => expect(document.querySelectorAll('.attach-item').length).toBe(1));
    const names = [...document.querySelectorAll('.attach-item')].map((el) => el.getAttribute('title') ?? '');
    expect(names.some((title) => title.includes('huge.png'))).toBe(false);
    expect(names.some((title) => title.includes('small.png'))).toBe(true);
  });
});

describe('the + menu', () => {
  it('asks the sidebar for the folder picker rather than opening one itself', () => {
    render(<Composer variant="home" />);
    const asked = vi.fn();
    window.addEventListener('hearth:open-folder', asked);
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open a project…' }));
    window.removeEventListener('hearth:open-folder', asked);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('opens Settings through the same event the rest of the app uses', () => {
    render(<Composer variant="home" />);
    const opened = vi.fn();
    window.addEventListener('hearth:open-settings', opened);
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings…' }));
    window.removeEventListener('hearth:open-settings', opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});

describe('the model pill', () => {
  it('reads "Auto" until a choice is made, and groups the menu by vendor', () => {
    render(<Composer />);
    const pill = screen.getByRole('button', { name: 'Model' });
    expect(pill.textContent).toContain('Auto');

    fireEvent.click(pill);
    // The picker answers "how do you want to work", not just "which model":
    // Chat is what Hearth drives itself over an API or an OAuth session, and
    // Terminal is a CLI on this machine, started in a real shell. Those two are
    // alternatives, so they are a switch at the head of the menu rather than
    // two sections of one list. Only the chosen side's groups are below it, and
    // each names its own backend, so the separate Agent section that briefly
    // led this menu was the same question asked twice.
    const sides = [...document.querySelectorAll('.menu-heading [role="tab"]')].map((el) => el.textContent);
    expect(sides).toEqual(['Chat', 'Terminal']);

    const headers = [...document.querySelectorAll('.menu-header-name')].map((el) => el.textContent);
    // Chat is the side it opens on. Effort is absent until a model that
    // declares efforts is picked. "Your agents" is last and is always there,
    // empty or not: a group that appeared only once you had registered
    // something would answer "can I use my own agent here?" with silence.
    expect(headers).toEqual(['Claude', 'ChatGPT', 'Your agents']);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Opus 5' })).toBeTruthy();
  });

  it('shows the machine’s CLIs, and only those, once the switch is on Terminal', () => {
    render(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));

    // The models are gone rather than merely scrolled past: the point of the
    // switch is that one side at a time is what you are choosing from.
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Opus 5' })).toBeNull();
    expect(document.querySelector('.menu-heading .model-menu-blurb')?.textContent).toBeTruthy();
  });

  it('routes an unavailable provider to Settings instead of storing a dead choice', () => {
    render(<Composer />);
    const opened = vi.fn();
    window.addEventListener('hearth:open-settings', opened);
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Opus 5' }));
    window.removeEventListener('hearth:open-settings', opened);

    expect(opened).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('hearth:modelChoice')).toBeNull();
  });

  it('stores the pick, and shows it, once the provider can actually answer', () => {
    patchStore({
      providers: {
        anthropic: { hasKey: true, source: 'project' },
        openai: {
          installed: false,
          version: null,
          loggedIn: false,
          authMode: null,
          email: null,
          planType: null,
          hasKey: false,
        },
        active: 'anthropic',
      },
    });
    render(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Sonnet 5' }));

    expect(JSON.parse(localStorage.getItem('hearth:modelChoice') ?? 'null')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      effort: null,
    });
    expect(screen.getByRole('button', { name: 'Model' }).textContent).toContain('Sonnet 5');
  });
});
