/**
 * Pacing text that arrives in lumps.
 *
 * Providers hand over whatever accumulated since their last flush — five
 * words, then nothing for half a second, then eight more — and rendering each
 * lump the instant it lands drags the reader's eye to a new place several
 * times a second. What is on screen is allowed to lag; what it must never do
 * is jump, invent, drop or reorder a character.
 */
import { describe, expect, it } from 'vitest';
import { nextReveal } from '../src/components/chat/useSmoothStream';

/** Reveal `total` from `shown`, one frame at a time, and report each step. */
function frames(shown: number, total: number, dtMs = 16): number[] {
  const steps: number[] = [];
  let at = shown;
  for (let guard = 0; guard < 5000 && at < total; guard += 1) {
    const next = nextReveal(at, total, dtMs);
    steps.push(next - at);
    at = next;
  }
  return steps;
}

describe('the reveal rate', () => {
  it('lays a lump down over several frames rather than in one', () => {
    // The complaint, in numbers: five words is about thirty characters, and it
    // used to land in a single paint.
    const steps = frames(0, 30);
    expect(steps.length).toBeGreaterThan(4);
    expect(Math.max(...steps)).toBeLessThan(30);
  });

  it('always reaches exactly what arrived, never past it', () => {
    for (const total of [1, 7, 30, 240, 1500]) {
      const steps = frames(0, total);
      expect(steps.reduce((sum, step) => sum + step, 0)).toBe(total);
    }
  });

  it('never stalls, however small the backlog', () => {
    expect(nextReveal(99, 100, 16)).toBe(100);
    expect(frames(0, 3).length).toBeLessThanOrEqual(2);
  });

  it('spends longer on a bigger lump, but bounded', () => {
    // Proportional, so a big backlog is consumed faster per frame — with a
    // ceiling, because "smoothing" two kilobytes into one 40-word jump is the
    // thing this exists to prevent.
    const small = frames(0, 60).length;
    const large = frames(0, 2000).length;
    expect(large).toBeGreaterThan(small);
    expect(Math.max(...frames(0, 2000))).toBeLessThanOrEqual(90);
    // Measured: 52 frames, so about nine tenths of a second at 60fps for two
    // kilobytes arriving at once. Long enough to read as a crawl rather than a
    // jump, and the ceiling still absorbs 5,400 characters a second sustained,
    // which is far more than any chat stream produces — so the lag is bounded
    // and the tail can never run away.
    expect(large).toBeLessThan(70);
  });

  it('shows an arrival too big to be a stream outright', () => {
    // A replay, a reopened conversation, a provider that batches a whole turn:
    // none of those is a stream, and all of them should simply be there.
    expect(nextReveal(0, 20_000, 16)).toBe(20_000);
  });

  it('is a function of time, so a slow frame catches up rather than falling behind', () => {
    const oneLongFrame = nextReveal(0, 400, 64);
    const oneShortFrame = nextReveal(0, 400, 16);
    expect(oneLongFrame).toBeGreaterThan(oneShortFrame);
  });
});
