/**
 * The honesty rule for the stage while the tester plays.
 *
 * The tester plays in a browser of its own, so a stage can be in one of two
 * genuinely different situations: it has the tester's picture, or it does not.
 * Only the first is allowed to say the stage is the tester's, and neither is
 * allowed to say nothing at all. A lit frame around a game standing still with
 * no words on it is the bug this whole path exists to fix.
 *
 * Pure, so the rule is checkable without a browser, a socket or a session.
 */
import { describe, expect, it } from 'vitest';
import { probeNote, stageNoteStatus } from '../src/components/game/ProbeStage';
import { probeFrameSrc } from '../src/probeStream';

describe('probeNote', () => {
  it('says the stage belongs to the tester only when the picture is really arriving', () => {
    expect(probeNote('live')).toMatch(/tester/i);
    expect(probeNote('live')).toMatch(/playing/i);
  });

  it('never goes quiet while a session is up', () => {
    expect(probeNote('starting')).toBeTruthy();
    expect(probeNote('hidden')).toBeTruthy();
  });

  it('says where the tester actually is when there is no picture of it', () => {
    expect(probeNote('hidden')).toMatch(/off screen/i);
  });

  it('says nothing at all when nothing is playing', () => {
    expect(probeNote('off')).toBeNull();
  });
});

describe('stageNoteStatus', () => {
  it('leaves nothing unsaid while the app believes a session is running', () => {
    expect(probeNote(stageNoteStatus('off', true))).toBeTruthy();
  });

  it('says nothing when nothing is playing', () => {
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
