import { describe, expect, it } from 'vitest';
import {
  appendArrayItem,
  defaultForParamType,
  inferParamKind,
  removeParamKey,
  renameParamKey,
  setParamKey,
} from '../src/scriptParams';

describe('inferParamKind', () => {
  it('classifies scalars', () => {
    expect(inferParamKind(170)).toBe('number');
    expect(inferParamKind(true)).toBe('boolean');
    expect(inferParamKind('hello')).toBe('string');
  });

  it('treats hex strings as colors', () => {
    expect(inferParamKind('#ff8800')).toBe('color');
    expect(inferParamKind('#fff')).toBe('color');
    expect(inferParamKind('#ff8800aa')).toBe('color');
    expect(inferParamKind('#notacolor')).toBe('string');
  });

  it('classifies containers and null', () => {
    expect(inferParamKind([1, 2, 3])).toBe('array');
    expect(inferParamKind({ a: 1 })).toBe('object');
    expect(inferParamKind(null)).toBe('null');
    expect(inferParamKind(undefined)).toBe('null');
  });
});

describe('defaultForParamType', () => {
  it('returns the zero value for each primitive type', () => {
    expect(defaultForParamType('number')).toBe(0);
    expect(defaultForParamType('string')).toBe('');
    expect(defaultForParamType('boolean')).toBe(false);
  });
});

describe('setParamKey / removeParamKey', () => {
  it('adds or replaces a key without mutating the input', () => {
    const params = { speed: 170 };
    const added = setParamKey(params, 'maxHp', 100);
    expect(added).toEqual({ speed: 170, maxHp: 100 });
    expect(params).toEqual({ speed: 170 });
    expect(setParamKey(params, 'speed', 200)).toEqual({ speed: 200 });
  });

  it('removes a key without mutating the input', () => {
    const params = { speed: 170, maxHp: 100 };
    expect(removeParamKey(params, 'maxHp')).toEqual({ speed: 170 });
    expect(params).toEqual({ speed: 170, maxHp: 100 });
  });
});

describe('renameParamKey', () => {
  it('renames while preserving insertion order', () => {
    const params = { speed: 170, maxHp: 100, dmg: 8 };
    expect(Object.keys(renameParamKey(params, 'maxHp', 'health')!)).toEqual(['speed', 'health', 'dmg']);
  });

  it('rejects empty, unknown, or colliding names', () => {
    const params = { speed: 170, maxHp: 100 };
    expect(renameParamKey(params, 'speed', '')).toBeNull();
    expect(renameParamKey(params, 'nope', 'x')).toBeNull();
    expect(renameParamKey(params, 'speed', 'maxHp')).toBeNull();
  });

  it('is a no-op copy when renaming to the same key', () => {
    const params = { speed: 170 };
    expect(renameParamKey(params, 'speed', 'speed')).toEqual({ speed: 170 });
  });
});

describe('appendArrayItem', () => {
  it('appends a value matching the array element type', () => {
    expect(appendArrayItem([1, 2])).toEqual([1, 2, 0]);
    expect(appendArrayItem(['a'])).toEqual(['a', '']);
    expect(appendArrayItem([true])).toEqual([true, false]);
    expect(appendArrayItem([])).toEqual(['']);
  });
});
