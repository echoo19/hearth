// @vitest-environment jsdom
/**
 * Sending the first sentence from Home.
 *
 * This is the product's whole opening move — type, press send, and a project
 * exists — so the things worth pinning are the ones that would silently lose a
 * user's words: the message is not fired into a socket that hasn't opened yet,
 * a second press can't mint a second project, and a failure says so instead of
 * doing nothing.
 *
 * The folder is no longer named FROM the prompt. Sending with nowhere to land
 * asks (`askProjectName`), the dialog does the creating, and what comes back
 * here is a folder that already exists. So these tests stand in for the dialog
 * rather than asserting on `apiCreateWorkspace`, which the store no longer
 * calls.
 *
 * The turn's model choice rides the same frame (see `sendChat`), so it is
 * checked here too — the send path is the only place that reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api', () => ({
  apiCreateWorkspace: vi.fn(),
  apiOpenWorkspace: vi.fn(),
  apiRecentChats: vi.fn(async () => []),
  apiListChats: vi.fn(async () => []),
  apiChatProviders: vi.fn(async () => null),
  apiAppSettings: vi.fn(async () => null),
  apiGameStatus: vi.fn(async () => null),
  apiProbeStatus: vi.fn(async () => null),
  apiTesterHistory: vi.fn(async () => null),
  apiMeta: vi.fn(async () => null),
  apiOpenAiLogin: vi.fn(async () => ({ ok: false })),
  // The real ones never answer null: failure is `ok: false` with words.
  apiRenameChat: vi.fn(async () => ({ ok: false, error: 'Could not rename that conversation.' })),
  apiDeleteChat: vi.fn(async () => ({ ok: false, error: 'Could not delete that conversation.' })),
  // Every refresher `openWorkspace` fires has to be listed here. This mock
  // replaces the module wholesale rather than spreading the real one, so an
  // api function added later is undefined at the call site and the flow throws
  // somewhere far from the cause. It has now cost two debugging sessions.
  apiPermissionMode: vi.fn(async () => null),
  apiSetPermissionMode: vi.fn(async () => null),
  // `closeWorkspace` runs in afterEach, so a missing entry here fails every
  // test in the file at teardown rather than where the call is.
  apiCloseWorkspace: vi.fn(async () => {}),
}));

import { apiCreateWorkspace, apiDeleteChat, apiListChats, apiOpenWorkspace, apiRenameChat } from '../src/api';
import { setModelChoice } from '../src/chat/modelChoice';
import { useApp } from '../src/store';
import { currentToast, resetToasts } from '../src/toast';

/**
 * A socket that connects on the next tick and answers `chat-new` with a
 * `chat-opened` on the tick after, like the real server. Both delays matter:
 * the store waits for `wsStatus === 'connected'` AND an open conversation
 * before sending, so a fake that skipped either would test nothing.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  static autoOpen = true;
  /** Every `chat-new` mints a DIFFERENT conversation, as the server does. */
  static nextChatId = 1;

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    if (FakeSocket.autoOpen) setTimeout(() => this.open(), 0);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as { type: string; [key: string]: unknown };
    if (frame.type === 'chat-new') {
      const ts = new Date().toISOString();
      const reply = JSON.stringify({
        type: 'chat-opened',
        chat: { id: `chat-${FakeSocket.nextChatId++}`, title: 'New chat', createdAt: ts, updatedAt: ts },
        records: [],
      });
      setTimeout(() => this.onmessage?.({ data: reply }), 0);
    }
    if (frame.type === 'chat-open') {
      const ts = new Date().toISOString();
      const reply = JSON.stringify({
        type: 'chat-opened',
        chat: { id: frame.chatId, title: 'Old chat', kind: 'chat', createdAt: ts, updatedAt: ts },
        records: [],
      });
      setTimeout(() => this.onmessage?.({ data: reply }), 0);
    }
  }

  /** Push a frame at the store the way the server would. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(): void {
    this.readyState = 3;
  }
}

/** Every frame the app has put on the wire, parsed. */
function frames(): { type: string; [key: string]: unknown }[] {
  return FakeSocket.instances.flatMap((socket) => socket.sent.map((raw) => JSON.parse(raw)));
}

const PROJECT = '/home/me/Hearth/space-shooter';

beforeEach(() => {
  localStorage.clear();
  setModelChoice(null);
  resetToasts();
  FakeSocket.instances = [];
  FakeSocket.autoOpen = true;
  FakeSocket.nextChatId = 1;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.mocked(apiCreateWorkspace).mockResolvedValue({
    ok: true,
    info: { path: '/home/me/Hearth/space-shooter', name: 'space-shooter', isHearthProject: false },
  });
  vi.mocked(apiOpenWorkspace).mockResolvedValue({
    ok: true,
    info: { path: '/home/me/Hearth/space-shooter', name: 'space-shooter', isHearthProject: false },
  });
  vi.mocked(apiListChats).mockResolvedValue([]);
  useApp.setState({ projectPath: null, projectName: null, homeBusy: false, chatError: null, messages: [] });
});

let unsubscribeDialog: (() => void) | null = null;

/**
 * Stand in for the naming dialog, which is what really creates the folder now.
 * Answers whatever gets asked with `path`, or dismisses when given null.
 *
 * Returns the suggestions it saw, so a test can check that the draft put in
 * front of the user came from what they typed.
 */
function standInForTheDialog(path: string | null = PROJECT): string[] {
  const seen: string[] = [];
  unsubscribeDialog = useApp.subscribe((state, previous) => {
    if (state.naming === null || previous.naming !== null) return;
    seen.push(state.naming.suggestion);
    useApp.getState().answerProjectName(path);
  });
  return seen;
}

afterEach(() => {
  unsubscribeDialog?.();
  unsubscribeDialog = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  useApp.getState().closeWorkspace();
});

describe('startFromHome', () => {
  it('asks for a name, opens the folder it gets back, and sends the message', async () => {
    const suggestions = standInForTheDialog();
    const result = await useApp.getState().startFromHome('  a top-down space shooter  ');

    expect(result.ok).toBe(true);
    // Asked, once, with a draft taken from the words already typed. The store
    // itself creates nothing: the dialog does, so a refusal can be shown next
    // to the name that caused it.
    expect(suggestions).toEqual(['Top-down space shooter']);
    expect(apiCreateWorkspace).not.toHaveBeenCalled();
    expect(useApp.getState().projectPath).toBe(PROJECT);

    const sends = frames().filter((frame) => frame.type === 'chat-send');
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe('a top-down space shooter');
    // The transcript shows the turn immediately — the user's words are on
    // screen before the agent says anything.
    expect(useApp.getState().messages[0]?.role).toBe('user');
    // The first thing this folder did was receive a chat message, so it is
    // pinned to chat — the key-derived settle must not park it in the terminal.
    expect(useApp.getState().conversationMode).toBe('chat');
    expect(useApp.getState().conversationModePinned).toBe(true);
  });

  it('asks for the conversation before it sends into it', async () => {
    standInForTheDialog();
    await useApp.getState().startFromHome('make a platformer');
    const types = frames().map((frame) => frame.type);
    expect(types.indexOf('chat-new')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('chat-new')).toBeLessThan(types.indexOf('chat-send'));
  });

  it('carries the standing model choice on the turn', async () => {
    setModelChoice({ provider: 'anthropic', model: 'claude-opus-5', effort: null });
    standInForTheDialog();
    await useApp.getState().startFromHome('make a platformer');

    const send = frames().find((frame) => frame.type === 'chat-send');
    expect(send?.agent).toEqual({ provider: 'anthropic', model: 'claude-opus-5', effort: null });
  });

  it('leaves the agent field off entirely when nothing has been chosen', async () => {
    standInForTheDialog();
    await useApp.getState().startFromHome('make a platformer');
    const send = frames().find((frame) => frame.type === 'chat-send');
    expect(send && 'agent' in send).toBe(false);
  });

  it('refuses a second press while the first is still in flight', async () => {
    const suggestions = standInForTheDialog();
    const first = useApp.getState().startFromHome('one');
    const second = await useApp.getState().startFromHome('two');

    expect(second.ok).toBe(false);
    await first;
    // Asked once, so only one project can come of two presses.
    expect(suggestions).toHaveLength(1);
  });

  it('sends nothing at all for an empty prompt', async () => {
    const suggestions = standInForTheDialog();
    const result = await useApp.getState().startFromHome('   ');
    expect(result.ok).toBe(false);
    expect(suggestions).toHaveLength(0);
  });

  it('stops quietly when the name is not given, and says nothing about it', async () => {
    // Dismissing the question is an answer, not a failure. Nothing is created,
    // nothing is claimed to have gone wrong, and `{ ok: false }` with no error
    // is what keeps the typed words in the composer (see Composer.send).
    standInForTheDialog(null);

    const result = await useApp.getState().startFromHome('make a platformer');

    expect(result).toEqual({ ok: false });
    expect(useApp.getState().chatError).toBeNull();
    expect(useApp.getState().projectPath).toBeNull();
    // And it releases: an abandoned start must not lock the composer forever.
    expect(useApp.getState().homeBusy).toBe(false);
    expect(frames().some((frame) => frame.type === 'chat-send')).toBe(false);
  });

  it('waits for the NEW conversation when the project is already open', async () => {
    // The bug this pins: `newChat` inside an open project leaves the previous
    // conversation open, so "a conversation exists" was already true and the
    // wait resolved synchronously. `chat-send` went out first, the `chat-opened`
    // that followed replayed an empty transcript over both bubbles, and every
    // event after it hit applyChatEvent's empty-list early return. The user saw
    // a cleared composer and a blank page while the turn really ran.
    standInForTheDialog();
    await useApp.getState().startFromHome('a top-down space shooter');
    expect(useApp.getState().activeChatId).toBe('chat-1');

    useApp.getState().newChat();
    // The previous conversation is still the open one at this point. That is
    // the state the wait has to tell apart from "the new one is ready".
    expect(useApp.getState().activeChatId).toBe('chat-1');

    const result = await useApp.getState().startFromHome('now make the enemies shoot back');
    expect(result.ok).toBe(true);
    // Let anything still in flight land. With the send racing ahead of the
    // open, this is the tick the `chat-opened` for the new chat arrived on and
    // replayed an empty transcript over the two bubbles already on screen.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The message went into the conversation that was minted for it, not the
    // one it was leaving.
    expect(useApp.getState().activeChatId).toBe('chat-2');
    const sends = frames().filter((frame) => frame.type === 'chat-send');
    expect(sends).toHaveLength(2);
    expect(sends[1].text).toBe('now make the enemies shoot back');

    // And the transcript still holds it: both bubbles survived the replay.
    const messages = useApp.getState().messages;
    expect(messages.map((message) => message.role)).toEqual(['user', 'agent']);
    expect(messages[0].parts).toEqual([{ kind: 'text', text: 'now make the enemies shoot back' }]);

    // The reply lands too. On an empty list every chat-event is dropped, so
    // this is the half the user actually complained about.
    FakeSocket.instances[0].deliver({ type: 'chat-event', event: { type: 'message-delta', text: 'On it.' } });
    expect(useApp.getState().messages[1].parts).toEqual([{ kind: 'text', text: 'On it.' }]);
  });

  it('starts a new conversation when New chat targets an existing project that is not open', async () => {
    const ts = new Date().toISOString();
    vi.mocked(apiListChats).mockResolvedValue([
      { id: 'chat-old', title: 'Old chat', kind: 'chat', createdAt: ts, updatedAt: ts },
    ]);
    useApp.setState({ composeTarget: PROJECT });

    const result = await useApp.getState().startFromHome('make something different');

    expect(result.ok).toBe(true);
    expect(useApp.getState().activeChatId).toBe('chat-1');
    expect(frames().map((frame) => frame.type)).not.toContain('chat-open');
    expect(frames().filter((frame) => frame.type === 'chat-new')).toHaveLength(1);
  });

  it('leaves the project screen and the blank surface for the conversation it sent into', async () => {
    standInForTheDialog();
    await useApp.getState().startFromHome('a top-down space shooter');
    // Someone reading the project's own screen, or a full screen over it, must
    // not have their message land behind it.
    useApp.setState({ projectView: true, screen: 'skills' });
    useApp.getState().newChat();
    useApp.setState({ projectView: true, screen: 'skills' });

    await useApp.getState().startFromHome('add a boss');

    expect(useApp.getState().projectView).toBe(false);
    expect(useApp.getState().screen).toBeNull();
    expect(useApp.getState().composing).toBe(false);
  });

  it('puts an open that never reached the server in the error banner, and releases', async () => {
    // The transport half is pinned in api.test.ts: apiOpenWorkspace answers a
    // dead server as `ok: false` with the reason in words, never as a throw.
    // This pins the other half — that startFromHome routes that answer through
    // `fail()` into chatError, the banner Home renders, exactly the way a
    // clean refusal goes. It used to reject instead, and the rejection flew
    // past the banner: the composer unlocked and nothing anywhere said why
    // nothing had happened.
    standInForTheDialog();
    const reason = 'Could not reach the Hearth server. Try again in a moment.';
    vi.mocked(apiOpenWorkspace).mockResolvedValue({ ok: false, error: reason });

    const result = await useApp.getState().startFromHome('make a platformer');

    expect(result).toEqual({ ok: false, error: reason });
    expect(useApp.getState().chatError).toBe(reason);
    // Released, not stuck: the composer can try again.
    expect(useApp.getState().homeBusy).toBe(false);
    expect(frames().some((frame) => frame.type === 'chat-send')).toBe(false);
  });

  it('keeps the words in the composer when the socket never comes up', async () => {
    FakeSocket.autoOpen = false;
    vi.useFakeTimers();
    try {
      standInForTheDialog();
      const pending = useApp.getState().startFromHome('make a platformer');
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(useApp.getState().pendingPrompt).toBe('make a platformer');
      expect(frames().some((frame) => frame.type === 'chat-send')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('renaming and deleting a conversation from the rail', () => {
  // What the rail acts on. `kind` matters only in that every summary has one.
  const CHAT = {
    id: 'chat-1',
    title: 'Old title',
    kind: 'chat' as const,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
  const REASON = 'Could not reach the Hearth server. Try again in a moment.';

  it('says a rename did not land, where the person is, and keeps the truth on screen', async () => {
    // The bug this pins: a rename over a dead server used to reject inside the
    // store, nothing caught it, and the only trace was a console the rail
    // never shows. The old title reappearing read as "Hearth ignored me".
    useApp.setState({ projectPath: PROJECT, chats: [CHAT] });
    vi.mocked(apiRenameChat).mockResolvedValue({ ok: false, error: REASON });

    await useApp.getState().renameChat('chat-1', 'New title');

    expect(currentToast()?.tone).toBe('error');
    expect(currentToast()?.message).toBe(REASON);
    // The list is untouched: the old title IS the truth until the server
    // confirms otherwise, and nothing may pretend the rename happened.
    expect(useApp.getState().chats).toEqual([CHAT]);
  });

  it('says a delete did not land, and the row it failed to delete stays', async () => {
    useApp.setState({ projectPath: PROJECT, chats: [CHAT], activeChatId: 'chat-1' });
    vi.mocked(apiDeleteChat).mockResolvedValue({ ok: false, error: REASON });

    await useApp.getState().deleteChat('chat-1');

    expect(currentToast()?.tone).toBe('error');
    expect(currentToast()?.message).toBe(REASON);
    expect(useApp.getState().chats).toEqual([CHAT]);
    // And it did not go looking for somewhere else to land: the conversation
    // it failed to delete is still the place to be.
    expect(frames().some((frame) => frame.type === 'chat-new')).toBe(false);
  });

  it('stays quiet and applies the refreshed list when the rename lands', async () => {
    useApp.setState({ projectPath: PROJECT, chats: [CHAT] });
    vi.mocked(apiRenameChat).mockResolvedValue({ ok: true, chats: [{ ...CHAT, title: 'New title' }] });

    await useApp.getState().renameChat('chat-1', 'New title');

    expect(currentToast()).toBeNull();
    expect(useApp.getState().chats[0].title).toBe('New title');
  });
});
