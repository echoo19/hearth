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
import { FOLDER_DRAFT_KEYS, useApp } from '../src/store';
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
    chatDriver: null,
    slashCommands: [],
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
  // So is the draft. It outlives the composer on purpose (that is the whole
  // point of it living in the store), which means it outlives a test too.
  useApp.getState().clearDrafts();
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

    expect(startFromHome).toHaveBeenCalledWith('a top-down space shooter', [], 'chat');
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('sends with the button too', () => {
    render(<Composer variant="home" />);
    type('snake, but the walls wrap');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(startFromHome).toHaveBeenCalledWith('snake, but the walls wrap', [], 'chat');
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

  it('selects dev team without losing the draft and resets only after a successful send', async () => {
    startFromHome.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    render(<Composer variant="home" />);
    type('a puzzle game about tides');

    const toggle = screen.getByRole('button', { name: 'Dev team' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(box().value).toBe('a puzzle game about tides');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(startFromHome).toHaveBeenLastCalledWith('a puzzle game about tides', [], 'devteam'));
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(box().value).toBe('a puzzle game about tides');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('false'));
    expect(box().value).toBe('');
  });

  it('does not offer the new-conversation toggle inside an existing chat', () => {
    render(<Composer />);
    expect(screen.queryByRole('button', { name: 'Dev team' })).toBeNull();
  });
});

describe('the in-chat variant', () => {
  it('filters the live provider command catalogue and inserts a selection', () => {
    patchStore({
      chatDriver: 'codex',
      slashCommands: [
        { name: 'compact', description: 'Compact this thread', source: 'builtin' },
        { name: 'ship', description: 'Ship the project', source: 'skill' },
      ],
    });
    render(<Composer />);
    type('/sh');

    expect(screen.queryByText('/compact')).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: (name) => name.includes('/ship') }));
    expect(box().value).toBe('/ship');
  });

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
  it('offers only the active agent’s models, and a deliberate way to switch', () => {
    render(<Composer />);
    const pill = screen.getByRole('button', { name: 'Model' });
    // Not "Auto". There is no automatic row to be on, so nothing chosen is an
    // instruction rather than a setting: the pill says what to do about it.
    expect(pill.textContent).toContain('Choose a model');

    fireEvent.click(pill);
    // ONE agent's catalogue, not every vendor's at once. The menu used to list
    // both, which made picking a model a silent way to change who answered:
    // choosing a GPT model moved the conversation to codex with nothing saying
    // so, while the account row still described a different sign-in.
    const headers = [...document.querySelectorAll('.menu-header-name')].map((el) => el.textContent);
    expect(headers).toEqual(['Claude', 'Switch agent']);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Opus 5' })).toBeTruthy();
    // The other vendor's models are absent. Its NAME is present, once, as the
    // row that changes agent — which is the act, said out loud.
    expect(screen.queryByRole('menuitemcheckbox', { name: /GPT/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Codex CLI/ })).toBeTruthy();
  });

  it('follows the project to the other agent, catalogue and switch row both', () => {
    // The mirror image of the case above, and the one that proves the menu is
    // built from who is ACTIVE rather than from a favoured vendor. Nothing has
    // been picked in this window, so the active agent is the one the project
    // recorded: the models are ChatGPT's, and the row that changes agent names
    // Claude's backend. Hardcoding either side would pass the test above and
    // still show a Claude menu to someone whose project answers with codex.
    patchStore({
      providers: {
        anthropic: { hasKey: true, source: 'project', cli: false, loggedIn: false, email: null, planType: null },
        openai: {
          installed: true,
          version: '0.144.5',
          loggedIn: true,
          authMode: 'chatgpt',
          email: null,
          planType: null,
          hasKey: false,
          models: [
            { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', isDefault: true },
            { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
          ],
        },
        active: 'openai',
      },
    });
    render(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));

    const headers = [...document.querySelectorAll('.menu-header-name')].map((el) => el.textContent);
    expect(headers).toEqual(['ChatGPT', 'Switch agent']);
    expect(screen.getByRole('menuitemcheckbox', { name: /GPT-5.6-Sol/ })).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: /GPT-5.4-Mini/ })).toBeTruthy();
    // Claude's models are absent; its backend is present once, as the switch.
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Opus 5' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Claude Code CLI/ })).toBeTruthy();
  });

  it('changes who answers through the store, so the project hears about it too', () => {
    // The switch row is not a local pill. It writes the standing choice AND
    // records the agent in the project, which is the fix for the older bug
    // where the composer and Settings each held their own opinion.
    const setChatProvider = vi.fn();
    patchStore({
      setChatProvider,
      providers: {
        anthropic: { hasKey: true, source: 'project', cli: false, loggedIn: false, email: null, planType: null },
        openai: {
          installed: true,
          version: '0.144.5',
          loggedIn: true,
          authMode: 'chatgpt',
          email: null,
          planType: null,
          hasKey: false,
        },
        active: 'anthropic',
      },
    });
    render(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Codex CLI/ }));
    expect(setChatProvider).toHaveBeenCalledWith('openai');
  });

  it('has no Chat/Terminal switch, because a conversation’s kind is fixed when it starts', () => {
    // That switch minted a second conversation underneath the reader while
    // looking like a view toggle. Choosing between the two now happens where
    // conversations are created: New chat and New terminal.
    render(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    expect(document.querySelectorAll('.menu-heading [role="tab"]')).toHaveLength(0);
    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull();
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
        anthropic: { hasKey: true, source: 'project', cli: false, loggedIn: false, email: null, planType: null },
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

/**
 * What someone typed and has not sent yet is the one thing in this app that
 * cannot be reproduced from anywhere else.
 *
 * Opening Skills or the Tester screen takes the whole working area, which
 * unmounts the conversation column and the composer inside it. The words went
 * with the component, and the tray's object URLs were revoked on the way out,
 * so a trip to Skills to look something up cost a half-written message and
 * every picture attached to it. `startFromHome` already keeps the words in the
 * box when a send fails, for exactly this reason; leaving a screen is not a
 * more forgiving event than a failed send.
 *
 * The draft lives in the store now, so the composer holds no copy of its own
 * to lose. The object URLs live exactly as long as the draft does: they are
 * released when it is sent, and released when the folder it was typed in goes
 * away, which is the only thing that drops one.
 */
describe('a draft that outlives the surface it was typed on', () => {
  const png = (name: string, size = 64): File => new File([new Uint8Array(size)], name, { type: 'image/png' });

  function drop(files: File[]): void {
    const items = files.map((file) => ({ kind: 'file', getAsFile: () => file }));
    fireEvent.drop(document.querySelector('.composer-card')!, {
      dataTransfer: { items, files, types: ['Files'] },
    });
  }

  it('is still in the box when the composer comes back', () => {
    patchStore({ projectPath: '/work/ember' });
    const view = render(<Composer />);
    type('half a sentence about the jump');

    // What a trip to Skills does to this column: it is not there any more.
    view.unmount();
    render(<Composer />);

    expect(box().value).toBe('half a sentence about the jump');
  });

  it('brings its attachments back with their pictures still loading', async () => {
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => `blob:kept-${(blob as File).name ?? 'x'}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    });
    patchStore({ projectPath: '/work/ember' });
    const view = render(<Composer />);
    drop([png('shot.png')]);
    await waitFor(() => expect(document.querySelectorAll('.attach-item').length).toBe(1));

    view.unmount();
    render(<Composer />);

    expect(document.querySelectorAll('.attach-item').length).toBe(1);
    // A revoked object URL is a broken image. The tray that comes back must
    // not be a row of dead thumbnails.
    expect(revoked).toEqual([]);
    const image = document.querySelector('.attach-item img') as HTMLImageElement | null;
    expect(image?.getAttribute('src')).toBe('blob:kept-shot.png');
    vi.unstubAllGlobals();
  });

  it('does not carry Home’s first message into a conversation’s composer', () => {
    // Two composers, two different acts: one starts a project, the other
    // continues a conversation. A draft belongs to the surface it was typed on.
    const view = render(<Composer variant="home" />);
    type('a game about a lighthouse');
    view.unmount();

    patchStore({ projectPath: '/work/ember' });
    render(<Composer />);
    expect(box().value).toBe('');
  });

  it('does not empty Home’s box, or revoke its pictures, while it opens a folder', () => {
    // Home's composer is the one that OPENS a project: the open happens in the
    // middle of its own send, with the words and the tray still on screen
    // behind it. Treating that draft as the folder's would blank the box and
    // revoke the thumbnails the person is looking at, mid-send.
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:home-shot',
      revokeObjectURL: (url: string) => revoked.push(url),
    });
    render(<Composer variant="home" />);
    type('a game about a lighthouse');

    act(() => {
      useApp.getState().clearDrafts(FOLDER_DRAFT_KEYS);
    });

    expect(box().value).toBe('a game about a lighthouse');
    expect(revoked).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('is dropped, with its object URLs, when the folder it belongs to goes', () => {
    patchStore({ projectPath: '/work/ember' });
    const view = render(<Composer />);
    type('meant for ember');
    view.unmount();

    act(() => {
      useApp.getState().closeWorkspace();
    });
    render(<Composer />);
    expect(box().value).toBe('');
  });
});
