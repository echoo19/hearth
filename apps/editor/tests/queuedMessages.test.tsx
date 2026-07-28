// @vitest-environment jsdom
/**
 * Typing while the agent is still answering.
 *
 * The app used to disable the box for the length of a turn, which loses the
 * thought at exactly the moment someone has it — you think of the correction
 * BECAUSE you can see the answer going wrong. Now the message waits and goes
 * out on its own the moment the turn is over.
 *
 * What is pinned here is the part that would quietly rot: the ordering, and
 * the four moments a queue must NOT drain into.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MessageList } from '../src/components/chat/MessageList';
import { useApp } from '../src/store';

const PROJECT = '/work/game';

/** Frames that reached the socket, in order. */
let sent: unknown[] = [];

function resetStore(over: Partial<ReturnType<typeof useApp.getState>> = {}): void {
  sent = [];
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'game',
    wsStatus: 'connected',
    messages: [],
    chatBusy: false,
    chatError: null,
    queued: [],
    activeChatId: 'c1',
    sendFrame: (frame: unknown) => {
      sent.push(frame);
      return true;
    },
    ...over,
  } as Partial<ReturnType<typeof useApp.getState>>);
}

const send = (text: string) => act(() => useApp.getState().sendChat(text));
const queued = () => useApp.getState().queued.map((m) => m.text);
const sentText = () => sent.filter((f: any) => f.type === 'chat-send').map((f: any) => f.text);

/** A turn that actually said something, then ended — the one thing that drains. */
const finishTurn = (reply = 'ok') =>
  act(() => {
    useApp.getState().receiveFrame({ type: 'chat-event', event: { type: 'message-delta', text: reply } } as never);
    useApp.getState().receiveFrame({ type: 'chat-event', event: { type: 'turn-complete' } } as never);
  });

beforeEach(() => resetStore());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('sending while a turn is running', () => {
  it('sends the first message and queues the ones typed after it', () => {
    send('first');
    expect(useApp.getState().chatBusy).toBe(true);
    send('second');
    send('third');
    expect(sentText()).toEqual(['first']);
    expect(queued()).toEqual(['second', 'third']);
  });

  it('still refuses an empty message', () => {
    send('first');
    send('   ');
    expect(queued()).toEqual([]);
  });

  it('releases one message per finished turn, oldest first', () => {
    send('first');
    send('second');
    send('third');

    finishTurn();
    expect(sentText()).toEqual(['first', 'second']);
    expect(queued()).toEqual(['third']);

    finishTurn();
    expect(sentText()).toEqual(['first', 'second', 'third']);
    expect(queued()).toEqual([]);
  });

  it('goes out as a real turn, indistinguishable from a typed one', () => {
    send('first');
    send('second');
    finishTurn();
    // Its own user bubble and its own agent turn, exactly as if it were typed.
    const roles = useApp.getState().messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'agent', 'user', 'agent']);
    expect(useApp.getState().chatBusy).toBe(true);
  });
});

describe('what must not drain the queue', () => {
  it('an error — one bad turn must not become three', () => {
    send('first');
    send('second');
    act(() =>
      useApp.getState().receiveFrame({ type: 'chat-event', event: { type: 'error', message: 'nope' } } as never),
    );
    expect(useApp.getState().chatBusy).toBe(false);
    expect(sentText()).toEqual(['first']);
    expect(queued()).toEqual(['second']);
  });

  it('a dead socket — a send that fails would take the message with it', () => {
    send('first');
    send('second');
    useApp.setState({ wsStatus: 'disconnected' });
    act(() => useApp.getState().interruptChat());
    // Still held, not sent and not lost. The reconnect is what releases it.
    expect(sentText()).toEqual(['first']);
    expect(queued()).toEqual(['second']);

    useApp.setState({ wsStatus: 'connected' });
    act(() =>
      useApp
        .getState()
        .receiveFrame({ type: 'chat-opened', chat: { id: 'c1' }, records: [] } as never),
    );
    expect(sentText()).toEqual(['first', 'second']);
  });

  it('switching conversations — the queue belonged to the one being left', () => {
    send('first');
    send('second');
    act(() => useApp.getState().openChat('c2'));
    expect(queued()).toEqual([]);
  });

  it('starting a new conversation', () => {
    send('first');
    send('second');
    act(() => useApp.getState().newChat());
    expect(queued()).toEqual([]);
  });
});

describe('Stop', () => {
  it('sends the correction that was queued behind the turn being stopped', () => {
    // "Stop, do this instead" is the whole reason to queue mid-turn. The agent
    // stays bound, so the next message continues the same conversation.
    send('first');
    send('actually, do it the other way');
    act(() => useApp.getState().interruptChat());
    expect(sentText()).toEqual(['first', 'actually, do it the other way']);
  });
});

describe('taking it back', () => {
  it('drops one without disturbing the others', () => {
    send('first');
    send('second');
    send('third');
    const id = useApp.getState().queued[0].id;
    act(() => useApp.getState().unqueueChat(id));
    expect(queued()).toEqual(['third']);
  });
});

describe('what the transcript shows', () => {
  it('lists what is waiting, with a way out of each', () => {
    send('first');
    send('hold on, add a jump');
    render(<MessageList />);
    expect(screen.getByText('hold on, add a jump')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: "Don't send this" }));
    expect(queued()).toEqual([]);
    expect(document.querySelector('.queued')).toBeNull();
  });

  it('shows nothing at all when nothing is waiting', () => {
    send('first');
    render(<MessageList />);
    expect(document.querySelector('.queued')).toBeNull();
  });
});
