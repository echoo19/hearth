import { describe, it, expect } from 'vitest';
import { setStringAt, removeString, addString } from '../src/stringList';

describe('setStringAt', () => {
  it('updates one string at the index, leaving the rest untouched', () => {
    const list = ['a', 'b'];
    expect(setStringAt(list, 1, 'c')).toEqual(['a', 'c']);
    // source array untouched
    expect(list).toEqual(['a', 'b']);
  });

  it('updates the first element', () => {
    const list = ['x'];
    expect(setStringAt(list, 0, 'y')).toEqual(['y']);
  });
});

describe('removeString', () => {
  it('removes the string at index', () => {
    const list = ['a', 'b', 'c'];
    expect(removeString(list, 1)).toEqual(['a', 'c']);
  });

  it('can empty the list when no minimum is given', () => {
    expect(removeString(['a'], 0)).toEqual([]);
  });

  it('returns null when removal would go below minimum', () => {
    // Can't remove from a list with exactly 1 item if min is 1
    expect(removeString(['a'], 0, 1)).toBeNull();
  });

  it('allows removal at exactly min when above min', () => {
    const list = ['a', 'b', 'c'];
    expect(removeString(list, 0, 2)).toEqual(['b', 'c']);
  });
});

describe('addString', () => {
  it('appends an empty string to an empty list', () => {
    expect(addString([])).toEqual(['']);
  });

  it('appends an empty string to a non-empty list', () => {
    expect(addString(['x'])).toEqual(['x', '']);
  });

  it('preserves existing elements', () => {
    const list = ['layer1', 'layer2'];
    expect(addString(list)).toEqual(['layer1', 'layer2', '']);
  });
});
