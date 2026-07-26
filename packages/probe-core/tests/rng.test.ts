/**
 * The bot's determinism guarantee. Everything else in probe-core tolerates a
 * noisy game; this one stream must replay exactly, or a reported failing seed
 * is not a repro.
 */
import { describe, expect, it } from 'vitest';
import { createRng, pick, randomInt, randomRange } from '@hearth/probe-core';

describe('createRng', () => {
  it('replays the same sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const first = Array.from({ length: 200 }, () => a());
    const second = Array.from({ length: 200 }, () => b());
    expect(second).toEqual(first);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 50 }, createRng(1));
    const b = Array.from({ length: 50 }, createRng(2));
    expect(a).not.toEqual(b);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is spread out enough to drive a policy', () => {
    const rng = createRng(9);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) buckets[Math.floor(rng() * 10)]++;
    for (const count of buckets) expect(count).toBeGreaterThan(700);
  });
});

describe('helpers', () => {
  it('randomInt stays in range and never returns the bound', () => {
    const rng = createRng(3);
    for (let i = 0; i < 1000; i++) {
      const v = randomInt(rng, 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
    }
    expect(randomInt(createRng(1), 0)).toBe(0);
  });

  it('pick returns undefined for an empty list', () => {
    expect(pick(createRng(1), [])).toBeUndefined();
    expect(pick(createRng(1), ['only'])).toBe('only');
  });

  it('randomRange spans the requested interval', () => {
    const rng = createRng(11);
    for (let i = 0; i < 500; i++) {
      const v = randomRange(rng, -3, 3);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(3);
    }
  });
});
