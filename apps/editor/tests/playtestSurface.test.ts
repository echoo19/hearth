/**
 * The playtest loop's client-side rules, and the sidebar's. All pure — the
 * button's label, the progress fold, the stage's aspect, the rail's empty
 * copy, and how long ago a conversation was — so none of it needs a DOM.
 */
import { describe, expect, it } from 'vitest';
import { playtestBlockReason, playtestLabel } from '../src/components/game/CapabilityStrip';
import { FALLBACK_ASPECT, measureGameSize, stageAspect } from '../src/components/game/GamePane';
import { emptyRailCopy } from '../src/components/evidence/EvidenceRail';
import { relativeTime } from '../src/components/shell/Sidebar';
import { applySweepProgress, replayTranscript } from '../src/store';
import type { ChatRecord, EvidenceEvent } from '../src/types';

const idle = { running: false, done: 0, total: null, error: null };

describe('playtestLabel', () => {
  it('is a verb until it is running', () => {
    expect(playtestLabel(idle)).toBe('Playtest');
  });

  it('does not invent a denominator it has not been told', () => {
    expect(playtestLabel({ ...idle, running: true })).toBe('Playing…');
  });

  it('counts runs once the sweep has declared how many there are', () => {
    expect(playtestLabel({ running: true, done: 1, total: 4 })).toBe('Playing 1/4');
  });

  it('never claims more runs than the sweep will do', () => {
    expect(playtestLabel({ running: true, done: 9, total: 4 })).toBe('Playing 4/4');
  });
});

describe('playtestBlockReason', () => {
  it('names what is missing when there is nothing to play', () => {
    expect(playtestBlockReason({ gamePresent: false, running: false })).toMatch(/no game/i);
  });

  it('points at where the results are going while one runs', () => {
    expect(playtestBlockReason({ gamePresent: true, running: true })).toMatch(/Playtests/);
  });

  it('gives no reason when it can run — that is not a blocked state', () => {
    expect(playtestBlockReason({ gamePresent: true, running: false })).toBeNull();
  });
});

describe('applySweepProgress', () => {
  const event = (kind: string, fields: Record<string, unknown> = {}): EvidenceEvent =>
    ({ kind, seq: 1, ts: 't', ...fields }) as unknown as EvidenceEvent;

  it('takes the denominator from the sweep, not from the button press', () => {
    const next = applySweepProgress(idle, [
      event('sweep-started', { policies: ['mash', 'idle'], seeds: [1, 2] }),
    ]);
    expect(next).toEqual({ running: true, done: 0, total: 4, error: null });
  });

  it('advances once per finished run', () => {
    let sweep = applySweepProgress(idle, [event('sweep-started', { policies: ['mash'], seeds: [1, 2] })]);
    sweep = applySweepProgress(sweep, [event('run-finished'), event('run-finished')]);
    expect(sweep).toMatchObject({ running: true, done: 2, total: 2 });
  });

  it('ends on the sweep, not on the last run', () => {
    let sweep = applySweepProgress(idle, [event('sweep-started', { policies: ['mash'], seeds: [1] })]);
    sweep = applySweepProgress(sweep, [event('run-finished')]);
    expect(sweep.running).toBe(true);
    sweep = applySweepProgress(sweep, [event('sweep-finished')]);
    expect(sweep.running).toBe(false);
  });

  it('leaves a sweep it knows nothing about alone', () => {
    expect(applySweepProgress(idle, [event('note', { text: 'hi' })])).toBe(idle);
  });
});

describe('stageAspect', () => {
  it('frames the game at its own shape', () => {
    expect(stageAspect({ width: 800, height: 600 })).toBeCloseTo(4 / 3);
  });

  it('falls back when the document has no shape to report', () => {
    expect(stageAspect(null)).toBe(FALLBACK_ASPECT);
    expect(stageAspect({ width: 0, height: 0 })).toBe(FALLBACK_ASPECT);
  });

  it('rejects a ratio nothing could be, rather than making an unusable stage', () => {
    expect(stageAspect({ width: 1000, height: 1 })).toBe(FALLBACK_ASPECT);
    expect(stageAspect({ width: 1, height: 1000 })).toBe(FALLBACK_ASPECT);
  });

  it('reads nothing out of a frame that is not there', () => {
    expect(measureGameSize(null)).toBeNull();
  });
});

describe('emptyRailCopy', () => {
  it('teaches the action once there is something to play', () => {
    expect(emptyRailCopy({ gamePresent: true, running: false })).toMatch(/Press Playtest/);
  });

  it('does not point at a button that would do nothing', () => {
    expect(emptyRailCopy({ gamePresent: false, running: false })).not.toMatch(/Press Playtest/);
  });

  it('stops saying nothing has been played the moment something is', () => {
    expect(emptyRailCopy({ gamePresent: true, running: true })).toMatch(/Playing now/);
  });
});

describe('replayTranscript', () => {
  it('rebuilds a conversation through the same fold the live stream uses', () => {
    const records: ChatRecord[] = [
      { role: 'user', ts: 't1', text: 'make a shooter' },
      { role: 'agent', ts: 't2', event: { type: 'text-delta', text: 'Buil' } },
      { role: 'agent', ts: 't3', event: { type: 'text-delta', text: 'ding.' } },
      { role: 'agent', ts: 't4', event: { type: 'tool-start', id: 'x', name: 'Write' } },
      { role: 'agent', ts: 't5', event: { type: 'tool-end', id: 'x', ok: true } },
      { role: 'agent', ts: 't6', event: { type: 'done' } },
    ];
    const messages = replayTranscript(records);
    expect(messages.map((message) => message.role)).toEqual(['user', 'agent']);
    expect(messages[1].parts).toEqual([
      { kind: 'text', text: 'Building.' },
      { kind: 'tool', id: 'x', name: 'Write', detail: undefined, state: 'ok' },
    ]);
  });

  it('separates turns: a second user message opens a second agent turn', () => {
    const messages = replayTranscript([
      { role: 'user', ts: 't1', text: 'one' },
      { role: 'agent', ts: 't2', event: { type: 'text-delta', text: 'a' } },
      { role: 'agent', ts: 't3', event: { type: 'done' } },
      { role: 'user', ts: 't4', text: 'two' },
      { role: 'agent', ts: 't5', event: { type: 'text-delta', text: 'b' } },
      { role: 'agent', ts: 't6', event: { type: 'done' } },
    ]);
    expect(messages.map((message) => message.role)).toEqual(['user', 'agent', 'user', 'agent']);
  });

  it('settles a transcript that was cut off mid-turn — history never "works"', () => {
    const messages = replayTranscript([
      { role: 'user', ts: 't1', text: 'hi' },
      { role: 'agent', ts: 't2', event: { type: 'text-delta', text: 'partial' } },
    ]);
    expect(messages.every((message) => message.streaming === false)).toBe(true);
  });

  it('reads an empty transcript as an empty conversation', () => {
    expect(replayTranscript([])).toEqual([]);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z');

  it('reads recent activity as recent', () => {
    expect(relativeTime('2026-07-25T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-07-25T11:52:00.000Z', now)).toBe('8m ago');
    expect(relativeTime('2026-07-25T09:00:00.000Z', now)).toBe('3h ago');
    expect(relativeTime('2026-07-22T12:00:00.000Z', now)).toBe('3d ago');
    expect(relativeTime('2026-07-11T12:00:00.000Z', now)).toBe('2w ago');
  });

  it('gives a date once "ago" stops being useful', () => {
    expect(relativeTime('2026-01-04T12:00:00.000Z', now)).not.toMatch(/ago/);
  });

  it('says nothing rather than "NaN ago" for an unreadable timestamp', () => {
    expect(relativeTime('not a date', now)).toBe('');
  });
});
