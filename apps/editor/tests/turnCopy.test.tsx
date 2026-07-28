// @vitest-environment jsdom
/**
 * Copying what the agent said.
 *
 * The control is deliberately narrow: it takes the prose and the plans, not
 * the build logs and diffs the turn happened to produce along the way. What is
 * pinned here is that narrowness, plus the two states where the control has no
 * business existing at all, a turn still being written and a turn that never
 * said anything.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MessageList, turnPlainText } from '../src/components/chat/MessageList';
import { useApp } from '../src/store';
import type { ChatMessage, ChatPart } from '../src/types';

function turn(parts: ChatPart[], streaming = false): ChatMessage {
  return { id: 'm1', role: 'agent', parts, streaming };
}

function show(messages: ChatMessage[]): void {
  useApp.setState({ messages, chatDriver: 'codex' });
  render(<MessageList />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('turnPlainText', () => {
  it('joins the prose with blank lines between paragraphs', () => {
    const text = turnPlainText(
      turn([
        { kind: 'text', text: 'First thought.' },
        { kind: 'text', text: 'Second thought.' },
      ]),
    );
    expect(text).toBe('First thought.\n\nSecond thought.');
  });

  it('leaves the machinery out', () => {
    const text = turnPlainText(
      turn([
        { kind: 'text', text: 'Here is what I did.' },
        { kind: 'command', id: 'c1', title: 'npm test', output: 'a very long build log', state: 'ok' },
      ]),
    );
    expect(text).toBe('Here is what I did.');
  });

  it('is empty for a turn that only ran things', () => {
    const text = turnPlainText(
      turn([{ kind: 'command', id: 'c1', title: 'ls', output: '', state: 'ok' }]),
    );
    expect(text).toBe('');
  });
});

describe('the copy control', () => {
  it('is offered on a finished agent turn', () => {
    show([turn([{ kind: 'text', text: 'Done.' }])]);
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
  });

  it('is withheld while the turn is still being written', () => {
    show([turn([{ kind: 'text', text: 'Half a sen' }], true)]);
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
  });

  it('is withheld from a turn with nothing to take away', () => {
    show([turn([{ kind: 'command', id: 'c1', title: 'ls', output: '', state: 'ok' }])]);
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
  });

  it('is not offered on your own message, which is already on screen as you typed it', () => {
    useApp.setState({
      messages: [{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'make it jump higher' }], streaming: false }],
      chatDriver: 'codex',
    });
    render(<MessageList />);
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
  });

  it('writes the prose to the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    show([turn([{ kind: 'text', text: 'The jump arc is fixed.' }])]);
    const button = screen.getByRole('button', { name: 'Copy message' });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(writeText).toHaveBeenCalledWith('The jump arc is fixed.');
    // The confirmation is the whole reason the control is not a bare icon:
    // without it people press twice to be sure it took.
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});
