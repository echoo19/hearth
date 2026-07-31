// @vitest-environment jsdom
/**
 * Provider questions are first-class transcript events, not a prose detour.
 *
 * The renderer owns only the values while the form is live. Once answered,
 * the transcript keeps the fact that an answer happened but no values —
 * especially no password/token — survive in app state.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageList } from '../src/components/chat/MessageList';
import { applyChatEvent, pendingInputId, useApp } from '../src/store';
import type { ChatEvent, ChatMessage } from '../src/types';

const liveTurn = (): ChatMessage[] => [
  { id: 'a1', role: 'agent', parts: [], streaming: true, startedAt: Date.now() },
];

const request: ChatEvent = {
  type: 'input-request',
  inputId: 'input-1',
  title: 'Configure deployment',
  description: 'The agent needs a few choices before it can continue.',
  allowCancel: true,
  questions: [
    {
      id: 'region',
      label: 'Region',
      type: 'choice',
      required: true,
      options: [
        { value: 'iad', label: 'Virginia', description: 'Lowest latency for the east coast' },
        { value: 'sfo', label: 'California' },
      ],
    },
    { id: 'name', label: 'Service name', type: 'text', required: true, placeholder: 'my-game' },
    { id: 'replicas', label: 'Replicas', type: 'number', min: 1, max: 8 },
    { id: 'public', label: 'Publicly accessible', type: 'boolean' },
    { id: 'docs', label: 'Documentation URL', type: 'url' },
    { id: 'token', label: 'Access token', type: 'text', secret: true, required: true },
  ],
};

let sent: unknown[];

function showInput(over: Partial<Extract<ChatEvent, { type: 'input-request' }>>): void {
  const event: Extract<ChatEvent, { type: 'input-request' }> = {
    type: 'input-request',
    inputId: 'required-input',
    title: 'Required answers',
    questions: [],
    ...over,
  };
  useApp.setState({ messages: applyChatEvent(liveTurn(), event), chatBusy: true });
}

beforeEach(() => {
  sent = [];
  useApp.setState({
    messages: applyChatEvent(liveTurn(), request),
    chatBusy: true,
    wsStatus: 'connected',
    sendFrame: (frame: unknown) => {
      sent.push(frame);
      return true;
    },
  } as Partial<ReturnType<typeof useApp.getState>>);
});

afterEach(cleanup);

describe('input event folding', () => {
  it('adds and settles a blocking request without retaining answers', () => {
    const asked = applyChatEvent(liveTurn(), request);
    expect(pendingInputId(asked)).toBe('input-1');

    const settled = applyChatEvent(asked, {
      type: 'input-resolved',
      inputId: 'input-1',
      action: 'submit',
    });
    expect(pendingInputId(settled)).toBeNull();
    expect(settled[0].parts[0]).toMatchObject({ kind: 'input', id: 'input-1', resolution: 'submit' });
    expect(settled[0].parts[0]).not.toHaveProperty('answers');
  });
});

describe('inline input prompt', () => {
  it('offers provider URL elicitations in the external browser', () => {
    showInput({
      externalAction: {
        type: 'open-url',
        url: 'https://example.com/authorize',
        elicitationId: 'elicit-1',
      },
    });
    render(<MessageList />);

    const link = screen.getByRole('link', { name: 'Open in browser' });
    expect(link.getAttribute('href')).toBe('https://example.com/authorize');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('renders every supported field with native, labelled controls', () => {
    render(<MessageList />);

    expect(screen.getByRole('group', { name: 'Configure deployment' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Virginia/ })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Service name' }).getAttribute('placeholder')).toBe('my-game');
    expect(screen.getByRole('spinbutton', { name: 'Replicas' }).getAttribute('max')).toBe('8');
    expect(screen.getByRole('checkbox', { name: 'Publicly accessible' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Documentation URL' }).getAttribute('type')).toBe('url');
    expect(screen.getByLabelText(/Access token/).getAttribute('type')).toBe('password');
  });

  it('submits typed values in the response frame, then forgets them locally', () => {
    render(<MessageList />);

    fireEvent.click(screen.getByRole('radio', { name: /Virginia/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Service name' }), { target: { value: 'launchpad' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Replicas' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Publicly accessible' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Documentation URL' }), {
      target: { value: 'https://example.com/docs' },
    });
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: 'do-not-store-this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(sent).toEqual([
      {
        type: 'chat-input-response',
        inputId: 'input-1',
        action: 'submit',
        answers: {
          region: 'iad',
          name: 'launchpad',
          replicas: 3,
          public: true,
          docs: 'https://example.com/docs',
          token: 'do-not-store-this',
        },
      },
    ]);

    const serialized = JSON.stringify(useApp.getState().messages);
    expect(serialized).not.toContain('do-not-store-this');
    expect(screen.queryByLabelText(/Access token/)).toBeNull();
    expect(document.querySelector('.input-record')?.textContent).toBe('Answered Configure deployment');
  });

  it('supports cancelling without inventing answers', () => {
    render(<MessageList />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sent).toEqual([{ type: 'chat-input-response', inputId: 'input-1', action: 'cancel' }]);
    expect(document.querySelector('.input-record')?.textContent).toBe('Cancelled Configure deployment');
  });
});

describe('required fields', () => {
  it('requires an explicit yes or no for a required boolean', () => {
    showInput({
      questions: [{ id: 'confirmed', label: 'Deploy now?', type: 'boolean', required: true }],
    });
    render(<MessageList />);

    expect(screen.queryByRole('checkbox', { name: 'Deploy now?' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(sent).toEqual([]);

    fireEvent.click(screen.getByRole('radio', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(sent).toEqual([
      {
        type: 'chat-input-response',
        inputId: 'required-input',
        action: 'submit',
        answers: { confirmed: false },
      },
    ]);
  });

  it('requires at least one answer in a required multi-choice group', () => {
    showInput({
      questions: [
        {
          id: 'targets',
          label: 'Targets',
          type: 'choice',
          multiple: true,
          required: true,
          options: [
            { value: 'web', label: 'Web' },
            { value: 'desktop', label: 'Desktop' },
          ],
        },
      ],
    });
    render(<MessageList />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(sent).toEqual([]);
    expect(screen.getByText('Choose at least one option.')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Desktop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(sent).toEqual([
      {
        type: 'chat-input-response',
        inputId: 'required-input',
        action: 'submit',
        answers: { targets: ['desktop'] },
      },
    ]);
  });

  it('does not accept an empty single-choice Other answer', () => {
    showInput({
      questions: [
        {
          id: 'runtime',
          label: 'Runtime',
          type: 'choice',
          required: true,
          allowOther: true,
          options: [{ value: 'node', label: 'Node.js' }],
        },
      ],
    });
    render(<MessageList />);

    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(sent).toEqual([]);
    expect(screen.getByText('Enter an answer for Other.')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Runtime: Other' }), { target: { value: 'Bun' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(sent).toEqual([
      {
        type: 'chat-input-response',
        inputId: 'required-input',
        action: 'submit',
        answers: { runtime: 'Bun' },
      },
    ]);
  });

  it('supports a free-form Other value in a multi-choice group', () => {
    showInput({
      questions: [
        {
          id: 'targets',
          label: 'Targets',
          type: 'choice',
          multiple: true,
          allowOther: true,
          options: [{ value: 'web', label: 'Web' }],
        },
      ],
    });
    render(<MessageList />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Targets: Other' }), { target: { value: 'Console' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(sent).toEqual([
      {
        type: 'chat-input-response',
        inputId: 'required-input',
        action: 'submit',
        answers: { targets: ['Console'] },
      },
    ]);
  });
});
