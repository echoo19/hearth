// @vitest-environment jsdom
/**
 * An event belongs to the conversation it came from.
 *
 * For a long time `chat-event` said nothing about which conversation it was
 * about, and that was survivable only while one conversation was ever live. It
 * is not: a session being torn down goes on emitting by design, so its last
 * `approval-resolved` and `turn-complete` arrive AFTER the teardown. With no
 * id on the frame those tail events landed in whatever conversation had been
 * opened since, cleared its busy state in the middle of a live turn, and (per
 * `applyChatEvent`'s own rule about events after a turn ending) made the rest
 * of that turn's answer disappear from the screen.
 *
 * The server now names the conversation and drops sockets that have moved on.
 * This is the window's half: believe the id when there is one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeAgentMessage, makeUserMessage, settleMessage, useApp } from '../src/store';

const PROJECT = '/work/game';

/**
 * A turn already under way: what someone typed, and the bubble the answer is
 * streaming into. `applyChatEvent` folds deltas into the LAST message, and
 * drops everything on an empty transcript, so a test about ROUTING has to
 * start from a conversation that is genuinely mid-answer.
 */
const started = () => [makeUserMessage('go'), makeAgentMessage()];

/** Everything the agent has said so far, as one string. */
const answer = (): string =>
  useApp
    .getState()
    .messages.slice(1)
    .flatMap((message) => message.parts)
    .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
    .map((part) => part.text)
    .join('');

function resetStore(over: Partial<ReturnType<typeof useApp.getState>> = {}): void {
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'game',
    wsStatus: 'connected',
    messages: started(),
    chatBusy: true,
    chatError: null,
    queued: [],
    activeChatId: 'b',
    sendFrame: () => true,
    ...over,
  } as Partial<ReturnType<typeof useApp.getState>>);
}

const feed = (frame: Record<string, unknown>): void => {
  useApp.getState().receiveFrame(frame as never);
};

beforeEach(() => resetStore());

describe('a turn this window did not start', () => {
  /**
   * `applyChatEvent` folds into the last message and drops what it cannot fold,
   * which is right for a stale tail and catastrophic for a live turn nobody
   * here began. The runtime starts the dev team's planning turn when a spec is
   * approved, and the review turn, and the report; a second window watching a
   * conversation has no bubble of its own at all. Every one of those streamed
   * into a transcript that threw it away, and the words appeared only if you
   * reopened the conversation and the replay read them back off disk.
   */
  it('opens a bubble for itself rather than being dropped', () => {
    resetStore({ messages: [makeUserMessage('go'), settleMessage(makeAgentMessage())], chatBusy: false });

    feed({ type: 'chat-event', chatId: 'b', event: { type: 'message-delta', text: 'writing the plan' } });

    expect(answer()).toBe('writing the plan');
    expect(useApp.getState().messages).toHaveLength(3);
    expect(useApp.getState().messages[2].streaming).toBe(true);
  });

  it('keeps a question it raises answerable, in a window that sent nothing', () => {
    // The whole point. An ask that lands in a window with no open bubble used
    // to vanish, and the run then waited forever on an answer nobody could give.
    resetStore({ messages: [], chatBusy: false });

    feed({
      type: 'chat-event',
      chatId: 'b',
      event: {
        type: 'input-request',
        inputId: 'i1',
        title: 'Claude needs your input',
        questions: [{ id: 'q0', label: 'Which direction?', type: 'text' }],
        allowCancel: false,
      },
    });

    const parts = useApp.getState().messages.flatMap((message) => message.parts);
    expect(parts).toContainEqual(expect.objectContaining({ kind: 'input', id: 'i1', resolution: null }));
  });

  it('does not leave an empty bubble under a turn that has ended', () => {
    resetStore({ messages: [makeUserMessage('go'), settleMessage(makeAgentMessage())], chatBusy: false });

    feed({ type: 'chat-event', chatId: 'b', event: { type: 'turn-complete' } });
    feed({ type: 'chat-event', chatId: 'b', event: { type: 'done' } });

    expect(useApp.getState().messages).toHaveLength(2);
  });
});

describe('a chat event that names its conversation', () => {
  it('is ignored when it belongs to a conversation you are no longer reading', () => {
    // Conversation A is being torn down; B is open and mid-turn.
    feed({ type: 'chat-event', chatId: 'a', event: { type: 'message-delta', text: 'from A' } });
    // Nothing of A's landed in B's transcript.
    expect(answer()).toBe('');

    feed({ type: 'chat-event', chatId: 'a', event: { type: 'turn-complete' } });
    // B's turn is still running. A's ending is not B's ending.
    expect(useApp.getState().chatBusy).toBe(true);
  });

  it('is applied when it belongs to the conversation you are reading', () => {
    feed({ type: 'chat-event', chatId: 'b', event: { type: 'message-delta', text: 'from B' } });
    expect(answer()).toBe('from B');

    feed({ type: 'chat-event', chatId: 'b', event: { type: 'turn-complete' } });
    expect(useApp.getState().chatBusy).toBe(false);
  });
});

describe('a chat event that names nothing', () => {
  it('is still applied, because an older server does not say', () => {
    // The field is additive. A frame without it must keep working exactly as
    // it always did rather than being silently dropped.
    feed({ type: 'chat-event', event: { type: 'message-delta', text: 'unlabelled' } });
    expect(answer()).toBe('unlabelled');
  });
});

describe('before the window has a conversation of its own', () => {
  it('takes an event for the chat the server just minted', () => {
    // The server can create a conversation for a send before the window has an
    // `activeChatId`. Comparing unconditionally would drop exactly the events
    // that belong to the turn the person just started.
    resetStore({ activeChatId: null });
    feed({ type: 'chat-event', chatId: 'fresh', event: { type: 'message-delta', text: 'first words' } });
    expect(answer()).toBe('first words');
  });
});
