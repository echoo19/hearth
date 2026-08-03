// @vitest-environment jsdom
/**
 * "Is it still going?" — the question the app has to answer without being
 * asked.
 *
 * It used to answer in the wrong place: a static line under the composer
 * reading "Working — press Stop to interrupt.", which is a caption on a button
 * rather than a report on a turn, and which vanished the moment the agent
 * emitted anything at all. Now the answer lives at the foot of the turn being
 * written, it says what the turn is actually doing, and past a few seconds it
 * counts.
 *
 * The other half is retrospective: once a thought is over, the fold that hides
 * it says how long it took, which on a long turn is the most useful number on
 * the screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MessageList } from '../src/components/chat/MessageList';
import { workingLabel } from '../src/components/chat/WorkingRow';
import { reasoningLabel } from '../src/components/chat/ReasoningRow';
import { formatElapsed, formatDuration, ELAPSED_FLOOR_S } from '../src/chat/duration';
import { applyChatEvent, makeAgentMessage, useApp } from '../src/store';
import type { ChatMessage, ChatPart } from '../src/types';

function turn(parts: ChatPart[], streaming = true, startedAt?: number): ChatMessage {
  return { id: 'm1', role: 'agent', parts, streaming, ...(startedAt === undefined ? {} : { startedAt }) };
}

function showTranscript(messages: ChatMessage[]): void {
  useApp.setState({ messages, chatDriver: 'codex' });
  render(<MessageList />);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('workingLabel — what the turn says it is doing', () => {
  it('says Working when there is nothing to go on yet', () => {
    expect(workingLabel({ parts: [] })).toBe('Working');
  });

  it('names an activity that is still happening', () => {
    expect(workingLabel({ parts: [{ kind: 'reasoning', text: 'hmm' }] })).toBe('Thinking');
    expect(
      workingLabel({ parts: [{ kind: 'command', id: 'c1', title: 'npm test', output: '', state: 'running' }] }),
    ).toBe('Running');
    expect(
      workingLabel({ parts: [{ kind: 'subagent', id: 's1', title: 'explore', text: '', state: 'running' }] }),
    ).toBe('Delegating');
  });

  it('stops claiming to run a command that has finished', () => {
    expect(
      workingLabel({ parts: [{ kind: 'command', id: 'c1', title: 'npm test', output: '', state: 'ok' }] }),
    ).toBe('Working');
  });

  it('does not flicker between prose and the tool calls it alternates with', () => {
    // Observed against the real agent: labelling prose "Writing" made the line
    // read Writing / Working / Writing / Working every couple of seconds while
    // nothing meaningful changed. A word that moves when nothing moved is
    // worse than no word, so a turn mid-prose is simply Working.
    const text: ChatPart = { kind: 'text', text: 'Here is' };
    const tool: ChatPart = { kind: 'tool', id: 't1', name: 'Read', state: 'running' };
    const plan: ChatPart = { kind: 'plan', id: 'p1', text: '- one' };
    for (const tail of [text, tool, plan]) {
      expect(workingLabel({ parts: [tail] })).toBe('Working');
    }
  });

  it('does not claim to be working while it is blocked on the user', () => {
    const ask: ChatPart = {
      kind: 'approval',
      id: 'a1',
      approvalKind: 'command',
      title: 'rm -rf build',
      detail: '',
      decision: null,
    };
    expect(workingLabel({ parts: [ask] })).toBe('Waiting for you');
    expect(workingLabel({ parts: [{ ...ask, decision: 'allow' }] })).toBe('Working');
    // A withdrawn ask is resolved — the session ended under it — so it must
    // not read "Waiting for you" about a question nothing will ever answer.
    expect(workingLabel({ parts: [{ ...ask, decision: 'withdrawn' }] })).toBe('Working');
  });
});

describe('the line in the transcript', () => {
  it('stays up for the whole turn, not just its empty opening', () => {
    // The regression this exists for: the indicator was conditioned on an
    // empty parts list, so the first tool call made the app look finished.
    showTranscript([turn([{ kind: 'command', id: 'c1', title: 'npm test', output: '', state: 'running' }])]);
    expect(document.querySelector('.msg-working')).not.toBeNull();
    expect(screen.getByText('Running')).toBeTruthy();
  });

  it('burns the flame, not the fallback square', () => {
    // Icon resolves its glyph by string and silently falls back to `entity` (a
    // rect) when the name misses, so a rename in ui.tsx would swap the brand
    // mark for a generic box with nothing failing anywhere. Pin the shape: the
    // wrapper the flicker pivots on is present, and what it holds is a path.
    showTranscript([turn([])]);
    const flame = document.querySelector('.msg-working .flame-mark');
    expect(flame).not.toBeNull();
    // Burning, not banked: output is being written right now.
    expect(flame?.getAttribute('data-flame')).toBe('burn');
    expect(flame?.querySelector('svg > path')).not.toBeNull();
    expect(flame?.querySelector('svg > rect')).toBeNull();
  });

  it('is gone the moment the turn is', () => {
    showTranscript([turn([{ kind: 'text', text: 'Done.' }], false)]);
    expect(document.querySelector('.msg-working')).toBeNull();
  });

  it('counts once the turn has been going a while', () => {
    vi.useFakeTimers();
    const started = Date.now();
    showTranscript([turn([{ kind: 'text', text: 'Working on it' }], true, started)]);
    expect(document.querySelector('.working-elapsed')).toBeNull();

    act(() => {
      // Past the boundary rather than exactly on it: each update is scheduled
      // for the turn's next whole second plus a few milliseconds of slack, so
      // that a timer landing a hair early cannot render the same second twice
      // (see useElapsed). Nobody sees those milliseconds; a fake clock does.
      vi.advanceTimersByTime(12_010);
    });
    expect(document.querySelector('.working-elapsed')?.textContent).toBe('12s');
  });

  it('does not say "Thinking" twice while the model is mid-thought', () => {
    // The reasoning fold is already a working line — it carries the pulse and
    // counts. A second line under it repeating the word is the app stuttering.
    showTranscript([turn([{ kind: 'reasoning', text: 'hmm', startedAt: 1, durationMs: 4200 }], true, Date.now())]);
    expect(screen.getAllByText('Thinking')).toHaveLength(1);
    expect(document.querySelector('.msg-working')).toBeNull();
    // ...and the fold, not a separate row, is what burns and counts. It
    // smoulders rather than burns: a thought in progress is producing nothing
    // yet, and the mark says which of the two is happening.
    expect(document.querySelector('.reasoning-line .flame-mark')?.getAttribute('data-flame')).toBe('smoulder');
    expect(document.querySelector('.reasoning-line .working-elapsed')?.textContent).toBe('4s');
  });

  it('goes back to the plain working line once the thought is over', () => {
    // Reasoning that is no longer the trailing part is finished, whatever the
    // turn as a whole is still doing.
    showTranscript([
      turn(
        [
          { kind: 'reasoning', text: 'hmm', startedAt: 1, durationMs: 4200 },
          { kind: 'text', text: 'So:' },
        ],
        true,
      ),
    ]);
    expect(screen.getByText('Thought for 4s')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
  });

  it('shows no counter for a turn replayed from disk', () => {
    // A replayed turn has no start, and a stopwatch on it would be timing the
    // file read rather than the model.
    showTranscript([turn([{ kind: 'text', text: 'hi' }], true)]);
    expect(document.querySelector('.msg-working')).not.toBeNull();
    expect(document.querySelector('.working-elapsed')).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('says nothing until a stopwatch is interesting', () => {
    expect(formatElapsed((ELAPSED_FLOOR_S - 1) * 1000)).toBeNull();
    expect(formatElapsed(ELAPSED_FLOOR_S * 1000)).toBe(`${ELAPSED_FLOOR_S}s`);
  });

  it('counts whole seconds, then minutes', () => {
    expect(formatElapsed(41_600)).toBe('41s');
    expect(formatElapsed(64_000)).toBe('1m 04s');
  });
});

describe('reasoningLabel — how long it thought', () => {
  it('is present tense while the tokens are still arriving', () => {
    expect(reasoningLabel({ durationMs: 4000 }, true)).toBe('Thinking');
  });

  it('reports the span once the thinking is over', () => {
    expect(reasoningLabel({ durationMs: 12_300 }, false)).toBe('Thought for 12s');
  });

  it('says only "Thought" when there is no span worth reporting', () => {
    // A replayed transcript folds in a millisecond; "Thought for 0.0s" would
    // be a measurement of the disk.
    expect(reasoningLabel({ durationMs: undefined }, false)).toBe('Thought');
    expect(reasoningLabel({ durationMs: 4 }, false)).toBe('Thought');
  });

  it('counts in whole units all the way up, so a long turn stays readable', () => {
    // No tenths anywhere: a figure that changes ten times a second is movement
    // carrying no information. Seconds pad only once a larger unit is present,
    // so a ticking line cannot jitter.
    expect(formatDuration(840)).toBe('840ms');
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(59_400)).toBe('59s');
    expect(formatDuration(124_000)).toBe('2m 04s');
    expect(formatDuration(11_110_000)).toBe('3h 5m 10s');
    expect(formatElapsed(2_900)).toBeNull();
    expect(formatElapsed(9_900)).toBe('9s');
    expect(formatElapsed(3_600_000)).toBe('1h 0m 00s');
  });
});

describe('where the span comes from', () => {
  it('is measured across the deltas, because no driver reports it', () => {
    let messages = [makeAgentMessage(1000)];
    messages = applyChatEvent(messages, { type: 'reasoning-delta', text: 'first' }, 1000);
    messages = applyChatEvent(messages, { type: 'reasoning-delta', text: ' second' }, 3500);

    const part = messages[0].parts[0];
    expect(part.kind).toBe('reasoning');
    expect(part.kind === 'reasoning' && part.text).toBe('first second');
    expect(part.kind === 'reasoning' && part.durationMs).toBe(2500);
    expect(formatDuration(part.kind === 'reasoning' ? part.durationMs : 0)).toBe('3s');
  });

  it('leaves a single-delta thought unmeasured rather than claiming zero', () => {
    let messages = [makeAgentMessage(1000)];
    messages = applyChatEvent(messages, { type: 'reasoning-delta', text: 'quick' }, 1000);
    const part = messages[0].parts[0];
    expect(part.kind === 'reasoning' && part.durationMs).toBeUndefined();
  });

  it('is shown on the fold, with the thought behind it', () => {
    showTranscript([
      turn([{ kind: 'reasoning', text: 'the working-out', startedAt: 1, durationMs: 8200 }], false),
    ]);
    expect(screen.getByText('Thought for 8s')).toBeTruthy();
    // Folded: the reasoning is not the answer and must not be read by default.
    expect(screen.queryByText('the working-out')).toBeNull();
  });
});
