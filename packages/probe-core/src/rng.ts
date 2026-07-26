/**
 * The probe's only source of randomness.
 *
 * Nothing about a game under test is assumed deterministic — the game may be a
 * live browser, a physics sim, a networked build. The BOT is deterministic: one
 * seed produces one exact sequence of decisions, so a failing run replays its
 * own inputs even when the game answers differently the second time.
 *
 * mulberry32: 32 bits of state, uniform enough for policy decisions, identical
 * across platforms because every operation is integer-exact.
 */

/** A seeded stream of floats in [0, 1). */
export type Rng = () => number;

/** Deterministic mulberry32 stream. The same seed always yields the same sequence. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [0, bound). Returns 0 for a non-positive bound. */
export function randomInt(rng: Rng, bound: number): number {
  if (bound <= 0) return 0;
  return Math.min(bound - 1, Math.floor(rng() * bound));
}

/** Uniform pick from a list, or undefined when it is empty. */
export function pick<T>(rng: Rng, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[randomInt(rng, items.length)];
}

/** Uniform float in [min, max). */
export function randomRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}
