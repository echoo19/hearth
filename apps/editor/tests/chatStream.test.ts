/**
 * Conversation assembly: `applyChatEvent` folds a stream of driver events
 * into ordered message parts. Pure, so streaming is testable without a socket
 * or a React tree.
 */
import { describe, expect, it } from 'vitest';
import { applyChatEvent, makeAgentMessage, makeUserMessage, replayTranscript, settleMessage } from '../src/store';
import type { ChatMessage, ChatToolPart } from '../src/types';
import { subagentOutcome } from '../src/components/chat/SubagentCard';
import { commandStatusNote } from '../src/components/chat/CommandRow';

function conversation(): ChatMessage[] {
  return [makeUserMessage('make a shooter'), makeAgentMessage()];
}

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
    .map((part) => part.text)
    .join('|');
}

describe('applyChatEvent', () => {
  it('coalesces a run of text deltas into one paragraph', () => {
    let messages = conversation();
    for (const text of ['Build', 'ing ', 'it.']) {
      messages = applyChatEvent(messages, { type: 'text-delta', text });
    }
    expect(textOf(messages[1])).toBe('Building it.');
    expect(messages[1].parts).toHaveLength(1);
  });

  it('lands a tool call between the paragraphs it happened between', () => {
    let messages = conversation();
    messages = applyChatEvent(messages, { type: 'text-delta', text: 'First.' });
    messages = applyChatEvent(messages, { type: 'tool-start', id: 't1', name: 'Write', detail: '/w/game.js' });
    messages = applyChatEvent(messages, { type: 'text-delta', text: 'Then.' });
    expect(messages[1].parts.map((part) => part.kind)).toEqual(['text', 'tool', 'text']);
    expect(textOf(messages[1])).toBe('First.|Then.');
  });

  it('settles a tool chip on its matching id only', () => {
    let messages = conversation();
    messages = applyChatEvent(messages, { type: 'tool-start', id: 't1', name: 'Write' });
    messages = applyChatEvent(messages, { type: 'tool-start', id: 't2', name: 'Bash' });
    messages = applyChatEvent(messages, { type: 'tool-end', id: 't2', ok: false });
    const tools = messages[1].parts.filter((part): part is ChatToolPart => part.kind === 'tool');
    expect(tools.map((tool) => tool.state)).toEqual(['running', 'error']);
  });

  it('marks the turn finished on done', () => {
    let messages = conversation();
    messages = applyChatEvent(messages, { type: 'text-delta', text: 'Done.' });
    messages = applyChatEvent(messages, { type: 'done' });
    expect(messages[1].streaming).toBe(false);
  });

  it('drops a turn that produced nothing at all', () => {
    const messages = applyChatEvent(conversation(), { type: 'done' });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('ends the turn with the reason, in the app’s voice rather than the agent’s', () => {
    let messages = conversation();
    messages = applyChatEvent(messages, { type: 'error', message: 'no credit' });
    const tail = messages[1].parts[messages[1].parts.length - 1];

    // Not a text part. Appended as one it rendered in the agent's own voice and
    // typography, so a rate limit or an expired login was indistinguishable
    // from something the model had decided to say.
    expect(tail).toEqual({
      kind: 'notice',
      text: 'no credit',
      tone: 'error',
      retryText: 'make a shooter',
    });
    expect(textOf(messages[1])).toBe('');
    expect(messages[1].streaming).toBe(false);
  });

  it('carries the lost prompt so the failure can offer to send it again', () => {
    const messages = applyChatEvent(conversation(), { type: 'error', message: 'overloaded' });
    const tail = messages[1].parts[messages[1].parts.length - 1];
    expect(tail.kind === 'notice' && tail.retryText).toBe('make a shooter');
  });

  it('ignores events when no turn is open, without changing identity', () => {
    const settled = applyChatEvent(conversation(), { type: 'done' });
    const again = applyChatEvent(settled, { type: 'text-delta', text: 'late' });
    expect(again).toBe(settled);
  });
});

/**
 * A turn can end with rows still open: it failed mid-command, someone pressed
 * Stop, or the driver died. Ending the turn used to settle the MESSAGE and
 * nothing inside it, so those rows kept `running` for the life of the
 * transcript, on disk, through a reload: a conversation that finished days ago
 * still spinning on a command that stopped with it, and a tool run pinned
 * permanently open by one stale member.
 *
 * They must not read as success either: nothing knows an unreported command
 * worked, and an interrupted one did not necessarily fail.
 */
describe('a turn that ends with work still open', () => {
  const open = (): ChatMessage[] => {
    let messages = conversation();
    messages = applyChatEvent(messages, {
      type: 'tool-begin',
      toolId: 'c1',
      kind: 'command',
      title: 'npm test',
    });
    messages = applyChatEvent(messages, { type: 'tool-begin', toolId: 't1', kind: 'other', title: 'Read' });
    return messages;
  };

  const states = (messages: ChatMessage[]): string[] =>
    messages[1].parts
      .filter((part): part is Extract<typeof part, { state: unknown }> => 'state' in part)
      .map((part) => part.state);

  it('leaves nothing claiming to run after turn-complete', () => {
    const messages = applyChatEvent(open(), { type: 'turn-complete' });
    expect(messages[1].streaming).toBe(false);
    expect(states(messages)).toEqual(['stopped', 'stopped']);
  });

  it('leaves nothing claiming to run after an error', () => {
    const messages = applyChatEvent(open(), { type: 'error', message: 'rate limit exceeded' });
    expect(messages[1].streaming).toBe(false);
    // The failure belongs to the turn, so the rows say they never finished
    // rather than borrowing an error nobody attributed to them.
    expect(states(messages)).toEqual(['stopped', 'stopped']);
  });

  it('does not touch a row that did report', () => {
    let messages = open();
    messages = applyChatEvent(messages, { type: 'tool-end', toolId: 'c1', status: 'ok' });
    messages = applyChatEvent(messages, { type: 'turn-complete' });
    expect(states(messages)).toEqual(['ok', 'stopped']);
  });

  it('keeps the same array when the turn ended cleanly', () => {
    let messages = conversation();
    messages = applyChatEvent(messages, { type: 'tool-begin', toolId: 't1', kind: 'other', title: 'Read' });
    messages = applyChatEvent(messages, { type: 'tool-end', toolId: 't1', status: 'ok' });
    const before = messages[1].parts;
    messages = applyChatEvent(messages, { type: 'turn-complete' });
    expect(messages[1].parts).toBe(before);
  });
});

/**
 * The same rule, for every OTHER way a turn ends: Stop, a torn-down
 * conversation, a dropped socket, and a transcript read back off disk that was
 * written while the agent was still talking. All four go through
 * `settleMessage`, so there is one answer rather than one per ending.
 */
describe('settleMessage', () => {
  it('closes an open row and stops the message streaming', () => {
    let messages = conversation();
    messages = applyChatEvent(messages, {
      type: 'tool-begin',
      toolId: 'c1',
      kind: 'command',
      title: 'npm run dev',
    });
    const settled = settleMessage(messages[1]);
    expect(settled.streaming).toBe(false);
    expect(settled.parts[0]).toMatchObject({ kind: 'command', state: 'stopped' });
  });

  it('gives back the same message when there was nothing to settle', () => {
    const done = applyChatEvent(conversation(), { type: 'text-delta', text: 'ok' });
    const settled = settleMessage(done[1]);
    expect(settleMessage(settled)).toBe(settled);
  });
});

const TS = '2026-07-01T10:00:00.000Z';

describe('replayTranscript', () => {
  it('does not resurrect a spinner from a transcript that ends mid-command', () => {
    // Exactly what is on disk after the app quit while a command was running.
    const messages = replayTranscript([
      { role: 'user', ts: TS, text: 'run the tests' },
      { role: 'agent', ts: TS, event: { type: 'tool-begin', toolId: 'c1', kind: 'command', title: 'npm test' } },
    ]);
    expect(messages[1].streaming).toBe(false);
    expect(messages[1].parts[0]).toMatchObject({ kind: 'command', state: 'stopped' });
  });

  it('leaves a turn the server is still running alone, question and all', () => {
    // The bug this pins cost a dev team run nineteen minutes and could not be
    // recovered from at all. The agent asked a question, the window reloaded,
    // the replay closed the transcript out as history — which withdraws an
    // unanswered ask — and the prompt that would have answered it never
    // rendered again. The run waited forever on an answer with no way to give
    // one, while the pane said Working.
    const records = [
      { role: 'user', ts: TS, text: 'make a tower defense game' },
      { role: 'agent', ts: TS, event: { type: 'text-delta', text: 'Four decisions first.' } },
      {
        role: 'agent',
        ts: TS,
        event: {
          type: 'input-request',
          inputId: 'i2',
          title: 'Claude needs your input',
          questions: [{ id: 'q0', label: 'Does that cast work?', type: 'text' }],
          allowCancel: false,
        },
      },
    ] as const;

    const live = replayTranscript(records as never, '', { live: true });
    expect(live[1].streaming).toBe(true);
    expect(live[1].parts[1]).toMatchObject({ kind: 'input', resolution: null });
    // ...and because it is still streaming, what the turn does next lands in it
    // rather than being dropped on the floor.
    expect(textOf(applyChatEvent(live, { type: 'text-delta', text: ' Locked.' })[1])).toContain('Locked.');

    // The same records read back as history close the ask, which is right:
    // nothing is coming, and a question that can never be answered should not
    // sit there looking answerable.
    const done = replayTranscript(records as never);
    expect(done[1].streaming).toBe(false);
    expect(done[1].parts[1]).toMatchObject({ kind: 'input', resolution: 'withdrawn' });
  });

  it('opens the bubble a running turn has not written into yet', () => {
    // Reopening between "sent" and the first token: there is nothing on disk
    // from the agent, so without this the events that follow have no streaming
    // message to land in and the reply never appears.
    const live = replayTranscript([{ role: 'user', ts: TS, text: 'hello' }] as never, '', { live: true });
    expect(live).toHaveLength(2);
    expect(live[1]).toMatchObject({ role: 'agent', streaming: true, parts: [] });
  });
});

describe('a row whose turn ended before it reported back', () => {
  // The settle is only half the fix. The other half is that every renderer
  // has a word for the new state: a `stopped` row that falls through to a
  // default takes the one case where nothing knows what happened and reports
  // it as success, which is the worst reading available.
  it('is never described as having succeeded', () => {
    expect(subagentOutcome('stopped')).toBe('Stopped');
    expect(subagentOutcome('stopped')).not.toBe('Done');
  });

  it('says it did not finish rather than borrowing an exit code', () => {
    expect(commandStatusNote({ state: 'stopped', exitCode: undefined })).toBe('did not finish');
    // And a real failure still reads as one.
    expect(commandStatusNote({ state: 'error', exitCode: 1 })).toBe('exit 1');
  });
});
