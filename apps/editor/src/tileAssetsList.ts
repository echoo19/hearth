/**
 * Pure row helpers for the Inspector's TileAssetsField control — the typed
 * row editor for Tilemap.tileAssets (a Record<char, assetId>), replacing the
 * raw JSON textarea fallback. Kept separate from Inspector.tsx so the
 * validation/edit logic is unit-testable without a DOM, like stringList.ts
 * and vec2List.ts for the other row editors.
 *
 * tileAssets is stored as a plain object, but the field editor works on an
 * ordered row array — a char rename or asset reassignment operates on one
 * row by index, then rowsToMap rebuilds the object for the commit.
 */

export interface TileAssetRow {
  char: string;
  assetId: string;
}

/** '.' and ' ' always mean an empty cell (see TilemapSchema/paintTiles) — never assignable to an asset. */
export const RESERVED_CHARS = ['.', ' '] as const;

/**
 * Row order can't follow insertion order — tileAssets is stored as a plain
 * object, and JS reorders integer-like string keys (e.g. a digit char like
 * "0") to the front of `Object.entries` regardless of insertion order. Sort
 * by char code instead so the row order is deterministic and stable across a
 * rowsToMap -> toRows round-trip, no matter how the engine enumerates keys.
 */
export function toRows(map: Record<string, string>): TileAssetRow[] {
  return Object.entries(map)
    .map(([char, assetId]) => ({ char, assetId }))
    .sort((a, b) => a.char.charCodeAt(0) - b.char.charCodeAt(0));
}

export function rowsToMap(rows: readonly TileAssetRow[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) map[row.char] = row.assetId;
  return map;
}

/**
 * Validates a candidate char for the row at `index` against the other rows'
 * chars — the same rules the paintTiles/fillTilemapRect commands enforce
 * server-side (assertValidChar), surfaced here as an inline hint before the
 * edit is ever committed. Returns null when valid.
 */
export function validateChar(char: string, rows: readonly TileAssetRow[], index: number): string | null {
  if (char.length !== 1) return 'Must be exactly one character.';
  if ((RESERVED_CHARS as readonly string[]).includes(char)) {
    return `"${char === ' ' ? 'space' : char}" is reserved for empty cells.`;
  }
  const duplicate = rows.some((row, i) => i !== index && row.char === char);
  if (duplicate) return `"${char}" is already mapped in another row.`;
  return null;
}

/** New rows array with row `index` renamed to `char` (caller validates first). */
export function renameRowChar(rows: readonly TileAssetRow[], index: number, char: string): TileAssetRow[] {
  return rows.map((row, i) => (i === index ? { ...row, char } : row));
}

/** New rows array with row `index` pointed at a different asset. */
export function setRowAsset(rows: readonly TileAssetRow[], index: number, assetId: string): TileAssetRow[] {
  return rows.map((row, i) => (i === index ? { ...row, assetId } : row));
}

/** New rows array without row `index`. */
export function removeRow(rows: readonly TileAssetRow[], index: number): TileAssetRow[] {
  return rows.filter((_, i) => i !== index);
}

const CANDIDATE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#@%&*+=-_/\\|~^!?<>[]{}()';

/**
 * New rows array with a fresh row appended: the first printable ASCII char
 * not already used (and not reserved) as its key, `defaultAssetId` as the
 * value. Falls back to an empty char in the vanishingly unlikely case every
 * candidate is already mapped — the empty-char row's inline validation hint
 * then prompts the user to pick one themselves.
 */
export function addRow(rows: readonly TileAssetRow[], defaultAssetId = ''): TileAssetRow[] {
  const used = new Set(rows.map((row) => row.char));
  let char = '';
  for (const candidate of CANDIDATE_CHARS) {
    if (!used.has(candidate)) {
      char = candidate;
      break;
    }
  }
  return [...rows, { char, assetId: defaultAssetId }];
}
