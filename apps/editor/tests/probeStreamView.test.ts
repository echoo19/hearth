/**
 * The honesty rule for the stage while a playtest runs.
 *
 * The bot plays in a browser of its own, so the pane can be in one of two
 * genuinely different situations: it has the bot's picture, or it does not.
 * Only the first is allowed to say the stage is the bot's, and neither is
 * allowed to say nothing at all. A glowing ring around a game standing still
 * with no words on it is the bug this whole path exists to fix.
 *
 * Pure, so the rule is checkable without a browser, a socket or a sweep.
 */
import { describe, expect, it } from 'vitest';
import { probeNote, stageNoteStatus } from '../src/components/game/ProbeStage';
import { probeFrameSrc } from '../src/probeStream';

describe('probeNote', () => {
  it('says the stage belongs to the bot only when the picture is really arriving', () => {
    expect(probeNote('live')).toMatch(/bot/i);
    expect(probeNote('live')).toMatch(/view/i);
  });

  it('never goes quiet while a sweep is up', () => {
    expect(probeNote('starting')).toBeTruthy();
    expect(probeNote('hidden')).toBeTruthy();
  });

  it('says where the bot actually is when there is no picture of it', () => {
    expect(probeNote('hidden')).toMatch(/off screen/i);
  });

  it('says nothing at all when nothing is playing', () => {
    expect(probeNote('off')).toBeNull();
  });
});

describe('stageNoteStatus', () => {
  it('leaves nothing unsaid while the app believes a sweep is running', () => {
    expect(probeNote(stageNoteStatus('off', true))).toBeTruthy();
  });

  it('says nothing when no sweep is running', () => {
    expect(stageNoteStatus('off', false)).toBe('off');
  });

  it('never overrides what the stream itself is doing', () => {
    expect(stageNoteStatus('live', true)).toBe('live');
    expect(stageNoteStatus('starting', true)).toBe('starting');
    // A live stream outlasting the app's belief is still a live stream.
    expect(stageNoteStatus('live', false)).toBe('live');
  });
});

describe('probeFrameSrc', () => {
  it('carries a frame the way an <img> takes one', () => {
    expect(probeFrameSrc('abc')).toBe('data:image/jpeg;base64,abc');
  });
});
