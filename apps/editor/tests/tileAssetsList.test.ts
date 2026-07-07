import { describe, it, expect } from 'vitest';
import {
  toRows,
  rowsToMap,
  validateChar,
  renameRowChar,
  setRowAsset,
  removeRow,
  addRow,
  type TileAssetRow,
} from '../src/tileAssetsList';

describe('toRows / rowsToMap', () => {
  it('round-trips a map through rows and back', () => {
    const map = { G: 'asset-grass', W: 'asset-wall' };
    const rows = toRows(map);
    expect(rows).toEqual([
      { char: 'G', assetId: 'asset-grass' },
      { char: 'W', assetId: 'asset-wall' },
    ]);
    expect(rowsToMap(rows)).toEqual(map);
  });

  it('an empty map round-trips to an empty array and back', () => {
    expect(toRows({})).toEqual([]);
    expect(rowsToMap([])).toEqual({});
  });

  it('rowsToMap lets a later duplicate char win, matching plain-object assignment semantics', () => {
    const rows: TileAssetRow[] = [
      { char: 'G', assetId: 'a' },
      { char: 'G', assetId: 'b' },
    ];
    expect(rowsToMap(rows)).toEqual({ G: 'b' });
  });
});

describe('validateChar', () => {
  const rows: TileAssetRow[] = [
    { char: 'G', assetId: 'a' },
    { char: 'W', assetId: 'b' },
  ];

  it('accepts a single non-reserved, unused char', () => {
    expect(validateChar('X', rows, 0)).toBeNull();
  });

  it('rejects empty input', () => {
    expect(validateChar('', rows, 0)).toMatch(/exactly one character/);
  });

  it('rejects multi-char input', () => {
    expect(validateChar('GG', rows, 0)).toMatch(/exactly one character/);
  });

  it('rejects the reserved "." char', () => {
    expect(validateChar('.', rows, 0)).toMatch(/reserved/);
  });

  it('rejects the reserved " " char', () => {
    expect(validateChar(' ', rows, 0)).toMatch(/reserved/);
  });

  it('rejects a char already used by a different row', () => {
    expect(validateChar('W', rows, 0)).toMatch(/already mapped/);
  });

  it('allows a row to keep its own current char (not a self-collision)', () => {
    expect(validateChar('G', rows, 0)).toBeNull();
  });
});

describe('renameRowChar / setRowAsset / removeRow', () => {
  const rows: TileAssetRow[] = [
    { char: 'G', assetId: 'a' },
    { char: 'W', assetId: 'b' },
  ];

  it('renames only the targeted row', () => {
    expect(renameRowChar(rows, 1, 'X')).toEqual([
      { char: 'G', assetId: 'a' },
      { char: 'X', assetId: 'b' },
    ]);
  });

  it('reassigns only the targeted row\'s asset', () => {
    expect(setRowAsset(rows, 0, 'c')).toEqual([
      { char: 'G', assetId: 'c' },
      { char: 'W', assetId: 'b' },
    ]);
  });

  it('removes only the targeted row', () => {
    expect(removeRow(rows, 0)).toEqual([{ char: 'W', assetId: 'b' }]);
  });

  it('does not mutate the input array', () => {
    renameRowChar(rows, 0, 'Z');
    setRowAsset(rows, 0, 'z');
    removeRow(rows, 0);
    expect(rows).toEqual([
      { char: 'G', assetId: 'a' },
      { char: 'W', assetId: 'b' },
    ]);
  });
});

describe('addRow', () => {
  it('appends a row with the first unused candidate char', () => {
    const result = addRow([]);
    expect(result).toHaveLength(1);
    expect(result[0].char).toBe('A');
    expect(result[0].assetId).toBe('');
  });

  it('uses the given default asset id', () => {
    const result = addRow([], 'sprite-1');
    expect(result[0].assetId).toBe('sprite-1');
  });

  it('skips chars already used by existing rows', () => {
    const rows: TileAssetRow[] = [{ char: 'A', assetId: 'a' }, { char: 'B', assetId: 'b' }];
    const result = addRow(rows);
    expect(result).toHaveLength(3);
    expect(result[2].char).toBe('C');
  });

  it('never picks a reserved char', () => {
    // Exhaust candidates up to (but not including) a point where only
    // reserved/used chars remain is impractical to construct exactly, but we
    // can at least assert '.' and ' ' are never produced for a fresh map.
    const result = addRow([]);
    expect(result[0].char).not.toBe('.');
    expect(result[0].char).not.toBe(' ');
  });
});
