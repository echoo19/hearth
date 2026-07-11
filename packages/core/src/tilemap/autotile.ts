/**
 * Autotile resolver for the 47-blob ("blob47") tiling standard.
 *
 * A tile's visual is picked from its 8 neighbours. Each neighbour holding the
 * SAME tile char contributes one bit to an 8-neighbour bitmask:
 *
 *   N = 1, NE = 2, E = 4, SE = 8, S = 16, SW = 32, W = 64, NW = 128
 *
 * This is the CANONICAL bit order — do not renumber it. Frame names, the
 * exported shape keys, and the golden test table all depend on these exact
 * values. Off-grid neighbours count as SAME, so a tile on the map edge renders
 * as though the terrain continues past the border (no spurious outline there).
 *
 * The raw mask has 256 values, but a diagonal (corner) neighbour only changes
 * a tile's silhouette when BOTH of its adjacent edge neighbours are present:
 * an "NE" tile with empty N and E still leaves a visible outer corner, so its
 * NE bit carries no shape information. Masking out every corner bit unless both
 * of its edges are set collapses the 256 raw masks onto exactly 47 canonical
 * shapes — the "blob47" set. `canonicalMask` performs that reduction and
 * `maskToShape` returns its result as a decimal string: the shape KEY used as
 * the lookup key everywhere (in AUTOTILE_SHAPES, BLOB47_TEMPLATE, and a rule's
 * `mapping`).
 *
 * Frame-naming convention: the standard blob47 template names each frame
 * `blob_<shapeKey>` — e.g. the fully-surrounded tile is `blob_255`, a lone
 * tile `blob_0`. A rule's optional `mapping` overrides individual shape keys
 * with custom frame names; any shape not in `mapping` falls back to the
 * template name.
 */

// --- Edge bits ---
export const N = 1;
export const E = 4;
export const S = 16;
export const W = 64;
// --- Corner (diagonal) bits ---
export const NE = 2;
export const SE = 8;
export const SW = 32;
export const NW = 128;

/** Each corner bit paired with the two edge bits that must BOTH be set for it to count. */
const CORNER_EDGES: ReadonlyArray<readonly [corner: number, edges: number]> = [
  [NE, N | E],
  [SE, S | E],
  [SW, S | W],
  [NW, N | W],
];

/**
 * The autotile rule stored under a Tilemap `tileAssets` char (object arm of
 * the union). Structurally identical to the Zod object arm in
 * `schema/components.ts`; kept as a plain interface here so this module has no
 * schema dependency.
 */
export interface AutotileRule {
  sheet: string;
  template: 'blob47';
  mapping?: Record<string, string>;
}

/**
 * 8-neighbour bitmask for the tile at (row, col) in a char grid. A neighbour
 * contributes its bit when it holds `char`; off-grid neighbours count as SAME.
 * Pure — reads `grid` only, never mutates it.
 */
export function computeMask(
  grid: readonly string[],
  row: number,
  col: number,
  char: string,
): number {
  const same = (r: number, c: number): boolean => {
    if (r < 0 || r >= grid.length) return true; // off-grid == same tile
    const line = grid[r];
    if (c < 0 || c >= line.length) return true;
    return line[c] === char;
  };
  let mask = 0;
  if (same(row - 1, col)) mask |= N;
  if (same(row - 1, col + 1)) mask |= NE;
  if (same(row, col + 1)) mask |= E;
  if (same(row + 1, col + 1)) mask |= SE;
  if (same(row + 1, col)) mask |= S;
  if (same(row + 1, col - 1)) mask |= SW;
  if (same(row, col - 1)) mask |= W;
  if (same(row - 1, col - 1)) mask |= NW;
  return mask;
}

/** Reduce a raw 0..255 mask to its canonical blob47 mask by dropping unsupported corners. */
export function canonicalMask(mask: number): number {
  let out = mask;
  for (const [corner, edges] of CORNER_EDGES) {
    if ((out & edges) !== edges) out &= ~corner;
  }
  return out;
}

/** Canonical shape key for a mask: the corner-reduced mask as a decimal string. */
export function maskToShape(mask: number): string {
  return String(canonicalMask(mask));
}

/** The 47 canonical shape keys, ascending by canonical mask value. */
export const AUTOTILE_SHAPES: string[] = (() => {
  const set = new Set<number>();
  for (let m = 0; m < 256; m++) set.add(canonicalMask(m));
  return [...set].sort((a, b) => a - b).map(String);
})();

/** Standard blob47 template: shape key -> frame name (`blob_<shapeKey>`). */
export const BLOB47_TEMPLATE: Record<string, string> = Object.freeze(
  Object.fromEntries(AUTOTILE_SHAPES.map((shape) => [shape, `blob_${shape}`])),
);

/** Full effective shape->frame map for a rule (template with `mapping` overrides applied). */
export function resolvedMapping(rule: AutotileRule): Record<string, string> {
  return { ...BLOB47_TEMPLATE, ...(rule.mapping ?? {}) };
}

/**
 * Resolve the sheet frame a tile should draw given its raw neighbour mask.
 * The mask is corner-reduced to a shape key, then looked up in the rule's
 * `mapping` (if present) or the standard template.
 */
export function resolveTileFrame(rule: AutotileRule, mask: number): { sheet: string; frame: string } {
  const shape = maskToShape(mask);
  const frame = rule.mapping?.[shape] ?? BLOB47_TEMPLATE[shape];
  return { sheet: rule.sheet, frame };
}
