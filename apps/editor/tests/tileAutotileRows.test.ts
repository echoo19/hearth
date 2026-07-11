import { describe, it, expect } from 'vitest';
import type { AutotileRule } from '@hearth/core';
import {
  isAutotileRule,
  nextAvailableChar,
  setMappingOverride,
  toTileRows,
  validateTileChar,
  type TileRow,
} from '../src/tileAutotileRows';

const RULE: AutotileRule = { sheet: 'ast_sheet', template: 'blob47' };

describe('isAutotileRule', () => {
  it('distinguishes the string arm from the object arm', () => {
    expect(isAutotileRule('ast_grass')).toBe(false);
    expect(isAutotileRule(RULE)).toBe(true);
  });
});

describe('toTileRows', () => {
  it('sorts by char code and keeps mixed sprite/autotile values intact', () => {
    const map = { W: RULE, G: 'ast_grass' };
    expect(toTileRows(map)).toEqual([
      { char: 'G', value: 'ast_grass' },
      { char: 'W', value: RULE },
    ]);
  });

  it('an empty map produces an empty array', () => {
    expect(toTileRows({})).toEqual([]);
  });

  it('sorts digit and letter keys by char code, not JS integer-key enumeration order', () => {
    const map = { W: 'a', '0': 'b', G: RULE };
    expect(toTileRows(map).map((r) => r.char)).toEqual(['0', 'G', 'W']);
  });
});

describe('validateTileChar', () => {
  const rows: TileRow[] = [
    { char: 'G', value: 'ast_grass' },
    { char: 'W', value: RULE },
  ];

  it('accepts a single non-reserved, unused char', () => {
    expect(validateTileChar('X', rows, 0)).toBeNull();
  });

  it('rejects empty/multi-char input', () => {
    expect(validateTileChar('', rows, 0)).toMatch(/exactly one character/);
    expect(validateTileChar('GG', rows, 0)).toMatch(/exactly one character/);
  });

  it('rejects reserved chars', () => {
    expect(validateTileChar('.', rows, 0)).toMatch(/reserved/);
    expect(validateTileChar(' ', rows, 0)).toMatch(/reserved/);
  });

  it('rejects a char already used by a different row, regardless of that row\'s mode', () => {
    expect(validateTileChar('W', rows, 0)).toMatch(/already mapped/); // row 1 (W) is autotile-mode
  });

  it('allows a row to keep its own current char', () => {
    expect(validateTileChar('G', rows, 0)).toBeNull();
    expect(validateTileChar('W', rows, 1)).toBeNull();
  });
});

describe('nextAvailableChar', () => {
  it('picks the first unused candidate char', () => {
    expect(nextAvailableChar([])).toBe('A');
  });

  it('skips chars used by existing rows, of either mode', () => {
    const rows: TileRow[] = [
      { char: 'A', value: 'a' },
      { char: 'B', value: RULE },
    ];
    expect(nextAvailableChar(rows)).toBe('C');
  });

  it('never picks a reserved char', () => {
    expect(nextAvailableChar([])).not.toBe('.');
    expect(nextAvailableChar([])).not.toBe(' ');
  });
});

describe('setMappingOverride', () => {
  it('adds an override to an empty/undefined mapping', () => {
    expect(setMappingOverride(undefined, '0', 'blob_0_alt')).toEqual({ '0': 'blob_0_alt' });
  });

  it('overwrites an existing key without touching the others', () => {
    const result = setMappingOverride({ '0': 'a', '255': 'b' }, '0', 'c');
    expect(result).toEqual({ '0': 'c', '255': 'b' });
  });

  it('removes a key (falls back to template default) when frameName is null', () => {
    const result = setMappingOverride({ '0': 'a', '255': 'b' }, '0', null);
    expect(result).toEqual({ '255': 'b' });
  });

  it('returns undefined (not {}) once the last override is removed', () => {
    expect(setMappingOverride({ '0': 'a' }, '0', null)).toBeUndefined();
  });

  it('does not mutate the input mapping', () => {
    const input = { '0': 'a' };
    setMappingOverride(input, '0', 'z');
    expect(input).toEqual({ '0': 'a' });
  });
});
