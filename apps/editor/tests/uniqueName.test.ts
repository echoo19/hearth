import { describe, it, expect } from 'vitest';
import { uniqueName } from '../src/uniqueName';

describe('uniqueName', () => {
  it('returns the base name untouched when nothing collides', () => {
    expect(uniqueName(['Level 1', 'Level 2'], 'Level 3')).toBe('Level 3');
  });

  it('appends " 2" when the base name is taken', () => {
    expect(uniqueName(['Boss Room'], 'Boss Room')).toBe('Boss Room 2');
  });

  it('keeps incrementing past existing numbered copies', () => {
    expect(uniqueName(['Boss Room', 'Boss Room 2', 'Boss Room 3'], 'Boss Room')).toBe('Boss Room 4');
  });

  it('accepts a Set directly without rebuilding it', () => {
    const set = new Set(['Entity']);
    expect(uniqueName(set, 'Entity')).toBe('Entity 2');
  });

  it('accepts any string iterable, not just arrays', () => {
    function* names() {
      yield 'Scene copy';
    }
    expect(uniqueName(names(), 'Scene copy')).toBe('Scene copy 2');
  });

  it('does not mutate or depend on iteration order beyond first-free', () => {
    expect(uniqueName(['x 2', 'x'], 'x')).toBe('x 3');
  });
});
