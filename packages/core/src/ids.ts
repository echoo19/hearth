/**
 * ID generation for Hearth objects.
 *
 * IDs are short, prefixed, and URL/file safe, e.g. `ent_k3v9qz`, `scn_p2m4xr`.
 * Prefixes make IDs self-describing in CLI output, diffs, and agent logs.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export type IdPrefix = 'prj' | 'scn' | 'ent' | 'ast' | 'ptt' | 'anm';

function randomChars(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${randomChars(8)}`;
}

/** Convert an arbitrary display name into a safe slug for file names. */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'unnamed'
  );
}
