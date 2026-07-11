import { describe, it, expect, afterEach } from 'vitest';
import { generateId, setIdRandomSource, createSeededRng } from '@hearth/core';

afterEach(() => {
  setIdRandomSource(null);
});

describe('generateId', () => {
  it('produces prefixed, 8-char ids by default', () => {
    const id = generateId('ent');
    expect(id).toMatch(/^ent_[a-z0-9]{8}$/);
  });

  it('same seed produces the same sequence of ids', () => {
    setIdRandomSource(createSeededRng(1));
    const first = [generateId('ent'), generateId('ent'), generateId('ent')];

    setIdRandomSource(createSeededRng(1));
    const second = [generateId('ent'), generateId('ent'), generateId('ent')];

    expect(second).toEqual(first);
  });

  it('different seeds produce different sequences', () => {
    setIdRandomSource(createSeededRng(1));
    const a = generateId('ent');

    setIdRandomSource(createSeededRng(2));
    const b = generateId('ent');

    expect(a).not.toBe(b);
  });

  it('passing null restores Math.random-based generation', () => {
    setIdRandomSource(createSeededRng(1));
    setIdRandomSource(null);

    // Two consecutive ids from a restored Math.random source should not
    // reliably collide, distinguishing it from a stuck/seeded stream.
    const ids = new Set(Array.from({ length: 20 }, () => generateId('ent')));
    expect(ids.size).toBe(20);
  });

  it('distinct prefixes share one underlying stream', () => {
    setIdRandomSource(createSeededRng(42));
    const entId = generateId('ent');

    setIdRandomSource(createSeededRng(42));
    const sceneId = generateId('scn');

    // Same seed, same draw count (8 chars) -> same random chars regardless
    // of prefix, because prefix and rng stream are independent.
    expect(entId.slice(4)).toBe(sceneId.slice(4));
  });
});

describe('createSeededRng', () => {
  it('is deterministic: same seed -> same sequence of floats in [0, 1)', () => {
    const rngA = createSeededRng(7);
    const rngB = createSeededRng(7);
    const seqA = Array.from({ length: 5 }, () => rngA());
    const seqB = Array.from({ length: 5 }, () => rngB());
    expect(seqB).toEqual(seqA);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
