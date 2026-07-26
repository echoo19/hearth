/**
 * Novelty — "is anything still happening?", answered without trusting the game
 * to be deterministic or to tell the truth about itself.
 *
 * Coverage keys are opaque strings, and there are four sources, in the order the
 * probe prefers them:
 *   c:<cx>,<cy>  the avatar's (or, with no avatar, a few entities') world cell,
 *                at a configurable cell size — the strongest progress signal
 *   h:<hex>      an 8x8 average-hash bucket of a sampled frame, used only when
 *                there is no entity sense at all
 *   s:<id>       the current scene/level id
 *   e:<name>     the first time a named game event fires
 *
 * The pixel path is the noisy one, so it is de-noised: a new hash bucket counts
 * as novelty only when its Hamming distance from EVERY bucket seen so far
 * exceeds a threshold. A shimmering particle system, a blinking cursor, or a
 * frame-counter in the corner moves 1-2 bits and is correctly read as "nothing
 * happened"; walking into a new room moves far more.
 *
 * Event novelty is first-occurrence-per-name, so an event that fires every step
 * cannot mask a stall.
 */
import type { ProbeEntity } from './contract.js';
import { averageHash, hammingDistance } from './imageHash.js';
import type { RgbaImage } from './png.js';
import { DEFAULT_CELL_SIZE } from './reachability.js';

export interface CoverageConfig {
  /** World-unit size of a coverage cell. */
  cellSize: number;
  /** Minimum bit distance from every known bucket before a frame counts as new. */
  hashDistance: number;
  /** With no avatar, how many entities to track cells for. */
  entityCap: number;
}

export const DEFAULT_COVERAGE_CONFIG: CoverageConfig = {
  cellSize: DEFAULT_CELL_SIZE,
  hashDistance: 4,
  entityCap: 16,
};

export interface CoverageInput {
  entities: readonly ProbeEntity[] | null;
  avatar: ProbeEntity | null;
  /** A decoded frame, present only on sampled steps. */
  image: RgbaImage | null;
  sceneId: string | null;
  newEvents: readonly string[];
}

export class CoverageTracker {
  /** Every distinct coverage key seen, in insertion order. */
  readonly keys = new Set<string>();
  private readonly hashes: string[] = [];
  private readonly config: CoverageConfig;
  private started = false;

  constructor(config: Partial<CoverageConfig> = {}) {
    this.config = { ...DEFAULT_COVERAGE_CONFIG, ...config };
  }

  /**
   * Fold one step in. Returns true when something genuinely new appeared. The
   * first call only seeds — the opening state of a run is never "progress".
   */
  observe(input: CoverageInput): boolean {
    const found = this.collect(input);
    let novel = false;
    for (const key of found) {
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      novel = true;
    }
    if (!this.started) {
      this.started = true;
      return false;
    }
    return novel;
  }

  private collect(input: CoverageInput): string[] {
    const keys: string[] = [];
    if (input.entities) {
      if (input.avatar) {
        keys.push(this.cellKey(input.avatar.x, input.avatar.y));
      } else {
        let n = 0;
        for (const e of input.entities) {
          if (!e.alive) continue;
          keys.push(this.cellKey(e.x, e.y));
          if (++n >= this.config.entityCap) break;
        }
      }
    } else if (input.image) {
      const key = this.hashKey(input.image);
      if (key) keys.push(key);
    }
    if (input.sceneId !== null) keys.push(`s:${input.sceneId}`);
    for (const name of input.newEvents) keys.push(`e:${name}`);
    return keys;
  }

  private cellKey(x: number, y: number): string {
    const size = this.config.cellSize;
    return `c:${Math.floor(x / size)},${Math.floor(y / size)}`;
  }

  /**
   * The bucket for a frame: an existing bucket when the frame is within the
   * noise threshold of one, otherwise a genuinely new bucket. Returns null when
   * the frame is near-identical to a known bucket, so near-duplicates never even
   * reach the key set.
   */
  private hashKey(image: RgbaImage): string | null {
    const hash = averageHash(image);
    let nearest = Infinity;
    for (const known of this.hashes) {
      const d = hammingDistance(hash, known);
      if (d < nearest) nearest = d;
      if (nearest <= this.config.hashDistance) return `h:${known}`;
    }
    this.hashes.push(hash);
    return `h:${hash}`;
  }
}
