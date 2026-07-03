/**
 * Silent audio unlock queueing policy (pure logic; the WebAudioPlayer
 * itself needs a real AudioContext and is exercised in the browser).
 */
import { describe, it, expect } from 'vitest';
import {
  PENDING_ONESHOT_MAX_AGE_MS,
  playsToStartOnResume,
  type PendingPlay,
} from '../src/pixi/audio.js';

function play(overrides: Partial<PendingPlay>): PendingPlay {
  return { handleId: 'snd_1', assetId: 'ast_a', volume: 1, loop: false, issuedAt: 0, ...overrides };
}

describe('playsToStartOnResume', () => {
  it('always starts queued loops, however old (music starts from 0)', () => {
    const pending = [play({ handleId: 'snd_1', loop: true, issuedAt: 0 })];
    expect(playsToStartOnResume(pending, 60_000).map((p) => p.handleId)).toEqual(['snd_1']);
  });

  it('starts one-shots still within the freshness window', () => {
    const pending = [play({ issuedAt: 1000 })];
    expect(playsToStartOnResume(pending, 1000 + PENDING_ONESHOT_MAX_AGE_MS)).toHaveLength(1);
  });

  it('drops one-shots older than the window instead of bursting', () => {
    const pending = [
      play({ handleId: 'snd_stale', issuedAt: 0 }),
      play({ handleId: 'snd_fresh', issuedAt: 900 }),
      play({ handleId: 'snd_music', loop: true, issuedAt: 0 }),
    ];
    const started = playsToStartOnResume(pending, 1200).map((p) => p.handleId);
    expect(started).toEqual(['snd_fresh', 'snd_music']);
  });

  it('preserves queue order among survivors', () => {
    const pending = [
      play({ handleId: 'a', loop: true }),
      play({ handleId: 'b', issuedAt: 100 }),
      play({ handleId: 'c', loop: true }),
    ];
    expect(playsToStartOnResume(pending, 200).map((p) => p.handleId)).toEqual(['a', 'b', 'c']);
  });
});
