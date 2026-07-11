/**
 * ID generation for Hearth objects.
 *
 * IDs are short, prefixed, and URL/file safe, e.g. `ent_k3v9qz`, `scn_p2m4xr`.
 * Prefixes make IDs self-describing in CLI output, diffs, and agent logs.
 *
 * The random source defaults to `Math.random` and is swappable via
 * `setIdRandomSource` for generators and tests that need byte-identical,
 * reproducible output (see packages/examples/generate.mjs). This is a
 * generator/test-only seam: it is entirely separate from the runtime's
 * seeded `ctx.random` stream. As documented at runtime.ts (see the
 * `spawnPrefab` invariant), spawned-entity ids come from `generateId`, a
 * Math.random-based id generator, never from the seeded ctx.random stream —
 * so entity spawning never consumes gameplay randomness. Swapping this seam
 * only affects id generation itself, never gameplay determinism.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export type IdPrefix = 'prj' | 'scn' | 'ent' | 'ast' | 'ptt' | 'anm';

let rng: () => number = Math.random;

/**
 * Swap the random source used by `generateId`. Pass `null` to restore
 * `Math.random`. Generator/test-only seam — all id prefixes share this one
 * stream, so distinct prefixes still draw from the same sequence.
 */
export function setIdRandomSource(source: (() => number) | null): void {
  rng = source ?? Math.random;
}

/**
 * Seeded deterministic RNG (mulberry32), matching the runtime's
 * `createRng` convention (packages/runtime/src/stdlib.ts). Same seed →
 * same sequence of floats in [0, 1).
 */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChars(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
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
