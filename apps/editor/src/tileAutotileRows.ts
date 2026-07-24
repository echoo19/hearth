/**
 * Pure row/mapping helpers for the Inspector's Tilemap.tileAssets char-row
 * editor. A row's value is a plain asset id, a fixed frame, or an autotile
 * rule. Kept separate from Inspector.tsx and
 * from ../tileAssetsList.ts (the older sprite-only row helpers, whose
 * `TileAssetRow.assetId: string` shape and existing tests assume every row
 * is a plain asset id — untouched here) so this stays unit-testable without
 * a DOM, matching the rest of the row-editor family.
 *
 * Deliberately data-only: char validation, row ordering, and mapping-object
 * edits. Writing an autotile row is NOT a plain object-merge like the other
 * row editors' rowsToMap — the core command layer rejects writing the object
 * arm through setComponentProperty (see componentCommands.ts's
 * assertNotAutotileWrite), so Inspector.tsx composes per-char
 * setComponentProperty/setTileAutotile command calls instead of using a
 * rowsToMap-style whole-map commit. That command composition is exec-based
 * (not pure), so it stays in Inspector.tsx; this module only supplies the
 * data it needs.
 */
import type { TileAsset } from '@hearth/core';
export type { TileAsset } from '@hearth/core';

export interface TileRow {
  char: string;
  value: TileAsset;
}

/** '.' and ' ' always mean an empty cell (see TilemapSchema/paintTiles) — never assignable to a row. */
export const RESERVED_CHARS = ['.', ' '] as const;

/** Same char-code sort as ../tileAssetsList.ts's toRows, for the same reason (stable order despite JS's integer-key hoisting). */
export function toTileRows(map: Record<string, TileAsset>): TileRow[] {
  return Object.entries(map)
    .map(([char, value]) => ({ char, value }))
    .sort((a, b) => a.char.charCodeAt(0) - b.char.charCodeAt(0));
}

/** Same validation rules as ../tileAssetsList.ts's validateChar, adapted to TileRow. */
export function validateTileChar(char: string, rows: readonly TileRow[], index: number): string | null {
  if (char.length !== 1) return 'Must be exactly one character.';
  if ((RESERVED_CHARS as readonly string[]).includes(char)) {
    return `"${char === ' ' ? 'space' : char}" is reserved for empty cells.`;
  }
  const duplicate = rows.some((row, i) => i !== index && row.char === char);
  if (duplicate) return `"${char}" is already mapped in another row.`;
  return null;
}

const CANDIDATE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#@%&*+=-_/\\|~^!?<>[]{}()';

/** The first printable ASCII char not already used (and not reserved) by an existing row — for a new "Add tile char" row. */
export function nextAvailableChar(rows: readonly TileRow[]): string {
  const used = new Set(rows.map((row) => row.char));
  for (const candidate of CANDIDATE_CHARS) {
    if (!used.has(candidate)) return candidate;
  }
  return '';
}

/**
 * New mapping object with `shapeKey` set to `frameName`, or removed
 * (falling back to the template default) when `frameName` is null —
 * for the Advanced mapping section's per-shape frame override. Returns
 * undefined instead of `{}` when the result would be empty, matching
 * AutotileRuleSchema's optional `mapping` field.
 */
export function setMappingOverride(
  mapping: Record<string, string> | undefined,
  shapeKey: string,
  frameName: string | null,
): Record<string, string> | undefined {
  const next = { ...(mapping ?? {}) };
  if (frameName === null) delete next[shapeKey];
  else next[shapeKey] = frameName;
  return Object.keys(next).length > 0 ? next : undefined;
}
