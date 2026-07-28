// @vitest-environment jsdom
/**
 * Sending the first sentence from Home.
 *
 * This is the product's whole opening move — type, press send, and a project
 * exists — so the things worth pinning are the ones that would silently lose a
 * user's words: the folder really is made from the prompt, the message is not
 * fired into a socket that hasn't opened yet, a second press can't mint a
 * second project, and a failure says so instead of doing nothing.
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
  apiRenameChat: vi.fn(async () => null),
  apiDeleteChat: vi.fn(async () => null),
  // Every refresher `openWorkspace` fires has to be listed here. This mock
  // replaces the module wholesale rather than spreading the real one, so an
  // api function added later is undefined at the call site and the flow throws
  // somewhere far from the cause. It has now cost two debugging sessions.
  apiPermissionMode: vi.fn(async () => null),
  apiSetPermissionMode: vi.fn(async () => null),
}));

import { apiCreateWorkspace, apiOpenWorkspace } from '../src/api';
import { setModelChoice } from '../src/chat/modelChoice';
import { useApp } from '../src/store';

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
    const frame = JSON.parse(data) as { type: string };
    if (frame.type === 'chat-new') {
      const ts = new Date().toISOString();
      const reply = JSON.stringify({
        type: 'chat-opened',
        chat: { id: `chat-${FakeSocket.nextChatId++}`, title: 'New chat', createdAt: ts, updatedAt: ts },
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

beforeEach(() => {
  localStorage.clear();
  setModelChoice(null);
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
  useApp.setState({ projectPath: null, projectName: null, homeBusy: false, chatError: null, messages: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  useApp.getState().closeWorkspace();
});

describe('startFromHome', () => {
  it('makes a folder from the prompt, opens it, and sends the message', async () => {
    const result = await useApp.getState().startFromHome('  a top-down space shooter  ');

    expect(result.ok).toBe(true);
    expect(apiCreateWorkspace).toHaveBeenCalledWith('a top-down space shooter');
    expect(useApp.getState().projectPath).toBe('/home/me/Hearth/space-shooter');

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
    await useApp.getState().startFromHome('make a platformer');
    const types = frames().map((frame) => frame.type);
    expect(types.indexOf('chat-new')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('chat-new')).toBeLessThan(types.indexOf('chat-send'));
  });

  it('carries the standing model choice on the turn', async () => {
    setModelChoice({ provider: 'anthropic', model: 'claude-opus-5', effort: null });
    await useApp.getState().startFromHome('make a platformer');

    const send = frames().find((frame) => frame.type === 'chat-send');
    expect(send?.agent).toEqual({ provider: 'anthropic', model: 'claude-opus-5', effort: null });
  });

  it('leaves the agent field off entirely when nothing has been chosen', async () => {
    await useApp.getState().startFromHome('make a platformer');
    const send = frames().find((frame) => frame.type === 'chat-send');
    expect(send && 'agent' in send).toBe(false);
  });

  it('refuses a second press while the first is still in flight', async () => {
    const first = useApp.getState().startFromHome('one');
    const second = await useApp.getState().startFromHome('two');

    expect(second.ok).toBe(false);
    await first;
    expect(apiCreateWorkspace).toHaveBeenCalledTimes(1);
  });

  it('sends nothing at all for an empty prompt', async () => {
    const result = await useApp.getState().startFromHome('   ');
    expect(result.ok).toBe(false);
    expect(apiCreateWorkspace).not.toHaveBeenCalled();
  });

  it('says why when the folder cannot be made, and stays on Home', async () => {
    vi.mocked(apiCreateWorkspace).mockResolvedValue({ ok: false, error: 'Disk is full.' });

    const result = await useApp.getState().startFromHome('make a platformer');

    expect(result).toEqual({ ok: false, error: 'Disk is full.' });
    expect(useApp.getState().chatError).toBe('Disk is full.');
    expect(useApp.getState().projectPath).toBeNull();
    // And it releases: a failed start must not lock the composer forever.
    expect(useApp.getState().homeBusy).toBe(false);
  });

  it('waits for the NEW conversation when the project is already open', async () => {
    // The bug this pins: `newChat` inside an open project leaves the previous
    // conversation open, so "a conversation exists" was already true and the
    // wait resolved synchronously. `chat-send` went out first, the `chat-opened`
    // that followed replayed an empty transcript over both bubbles, and every
    // event after it hit applyChatEvent's empty-list early return. The user saw
    // a cleared composer and a blank page while the turn really ran.
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

  it('leaves the project screen and the blank surface for the conversation it sent into', async () => {
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

  it('keeps the words in the composer when the socket never comes up', async () => {
    FakeSocket.autoOpen = false;
    vi.useFakeTimers();
    try {
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
