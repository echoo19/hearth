/**
 * Conversation assembly: `applyChatEvent` folds a stream of driver events
 * into ordered message parts. Pure, so streaming is testable without a socket
 * or a React tree.
 */
import { describe, expect, it } from 'vitest';
import { applyChatEvent, makeAgentMessage, makeUserMessage } from '../src/store';
import type { ChatMessage, ChatToolPart } from '../src/types';

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
