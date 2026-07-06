/**
 * Deterministic camera effects — shake, flash, fade, zoom punch.
 *
 * One CameraEffectsState per SceneRuntime, stepped once per fixed frame
 * right after camera follow. Headless-safe: no Date.now, no Math.random —
 * shake draws from its own seeded stream (mulberry32 via createRng), same
 * shape as the particle/tween machinery in stdlib.ts/particles.ts. Pure
 * data in, pure data out, so it's directly unit-testable without a runtime.
 */
import { EASINGS, createRng } from './stdlib.js';

const EPSILON = 1e-9;

export type CameraEffectKind = 'shake' | 'flash' | 'fade' | 'zoomPunch';

/** One shake/flash/fade/zoomPunch call, tagged with the frame it took effect on. */
export interface CameraEffectRecord {
  effect: CameraEffectKind;
  frame: number;
  params: Record<string, number | string>;
}

interface ShakeEntry {
  rng: () => number;
  intensity: number;
  duration: number;
  elapsed: number;
}

interface FlashEntry {
  color: string;
  duration: number;
  elapsed: number;
}

interface FadeEntry {
  from: number;
  to: number;
  duration: number;
  elapsed: number;
  onComplete?: () => void;
}

interface ZoomPunchEntry {
  scale: number;
  duration: number;
  elapsed: number;
}

/** A pending record: buffered at call time (no frame yet), flushed on the next step(). */
interface PendingRecord {
  effect: CameraEffectKind;
  params: Record<string, number | string>;
}

export class CameraEffectsState {
  /** Shake result, world units. {0, 0} when idle. */
  readonly offset = { x: 0, y: 0 };
  /** Flash pulse + persistent fade level (max of the two alphas; flash color wins while flashing). */
  readonly overlay: { color: string; alpha: number };

  /** Own seeded stream, used to derive a shake's rng when the call doesn't pass one explicitly. */
  private readonly sessionRng: () => number;
  private readonly onRecord?: (rec: CameraEffectRecord) => void;
  private pending: PendingRecord[] = [];

  private shakeEntry: ShakeEntry | null = null;
  private flashEntry: FlashEntry | null = null;
  private fadeEntry: FadeEntry | null = null;
  private zoomEntry: ZoomPunchEntry | null = null;

  /** Persistent fade level/color — survives past fade() completion, and across scene switches. */
  private fadeLevel: number;
  private fadeColor: string;
  private _zoomMul = 1;

  constructor(opts: {
    seed: number;
    initialOverlay?: { color: string; alpha: number };
    onRecord?: (rec: CameraEffectRecord) => void;
  }) {
    this.sessionRng = createRng(opts.seed);
    this.onRecord = opts.onRecord;
    this.fadeLevel = opts.initialOverlay?.alpha ?? 0;
    this.fadeColor = opts.initialOverlay?.color ?? '#000000';
    this.overlay = { color: this.fadeColor, alpha: this.fadeLevel };
  }

  /** Count of in-flight transient effects (shake/flash/fade-in-progress/zoomPunch). */
  get activeCount(): number {
    return (
      (this.shakeEntry ? 1 : 0) +
      (this.flashEntry ? 1 : 0) +
      (this.fadeEntry ? 1 : 0) +
      (this.zoomEntry ? 1 : 0)
    );
  }

  /** zoomPunch result; 1 when idle. */
  get zoomMul(): number {
    return this._zoomMul;
  }

  /**
   * The pure persistent fade state (level + color), with any transient flash
   * pulse excluded — unlike `overlay`, which is the combined rendered view.
   * This is what a GameSession carries across a scene switch: a flash
   * mid-flight at switch time must never leak into the next scene.
   */
  get persistentOverlay(): { color: string; alpha: number } {
    return { color: this.fadeColor, alpha: this.fadeLevel };
  }

  /**
   * Screen shake: offset decays linearly from `intensity` to 0 over
   * `seconds`. Last call wins — a new shake replaces any in-flight one
   * (one entry per effect kind).
   */
  shake(intensity: number, seconds: number, opts: { seed?: number } = {}): void {
    const seed = opts.seed ?? Math.floor(this.sessionRng() * 2 ** 31);
    this.shakeEntry = {
      rng: createRng(seed),
      intensity,
      duration: Math.max(0, seconds),
      elapsed: 0,
    };
    this.pending.push({ effect: 'shake', params: { intensity, seconds, seed } });
  }

  /**
   * A color pulse that fades from full alpha to 0 over `seconds`. Last call
   * wins — a new flash replaces any in-flight one (one entry per effect kind).
   */
  flash(color: string, seconds: number): void {
    this.flashEntry = { color, duration: Math.max(0, seconds), elapsed: 0 };
    this.pending.push({ effect: 'flash', params: { color, seconds } });
  }

  /**
   * Ease the persistent overlay level toward `alpha` over `seconds`, then
   * hold. Last call wins: calling fade() while a previous fade is still in
   * flight replaces it, starting from the current level — and the superseded
   * fade's `onComplete` is dropped, never fired (firing a stale completion
   * could double-trigger scene transitions). Only the winning fade's
   * `onComplete` runs, exactly once, when it finishes.
   */
  fade(
    alpha: number,
    seconds: number,
    opts: { color?: string; onComplete?: () => void } = {},
  ): void {
    this.fadeEntry = {
      from: this.fadeLevel,
      to: alpha,
      duration: Math.max(0, seconds),
      elapsed: 0,
      onComplete: opts.onComplete,
    };
    if (opts.color !== undefined) this.fadeColor = opts.color;
    this.pending.push({
      effect: 'fade',
      params: { alpha, seconds, ...(opts.color !== undefined ? { color: opts.color } : {}) },
    });
  }

  /**
   * A zoom kick that eases back to 1x over `seconds`. Last call wins — a new
   * punch replaces any in-flight one (one entry per effect kind).
   */
  zoomPunch(scale: number, seconds: number): void {
    this.zoomEntry = { scale, duration: Math.max(0, seconds), elapsed: 0 };
    this.pending.push({ effect: 'zoomPunch', params: { scale, seconds } });
  }

  /** Advance one fixed step. `frame` tags any records queued since the last step. */
  step(dt: number, frame: number, onError: (err: unknown) => void): void {
    if (this.pending.length > 0) {
      const flushed = this.pending;
      this.pending = [];
      for (const rec of flushed) {
        try {
          this.onRecord?.({ ...rec, frame });
        } catch (err) {
          onError(err);
        }
      }
    }

    // Shake.
    if (this.shakeEntry) {
      const s = this.shakeEntry;
      s.elapsed += dt;
      const t = s.duration <= EPSILON ? 1 : Math.min(1, s.elapsed / s.duration);
      const decay = 1 - t;
      this.offset.x = (s.rng() * 2 - 1) * s.intensity * decay;
      this.offset.y = (s.rng() * 2 - 1) * s.intensity * decay;
      if (t >= 1) this.shakeEntry = null;
    } else {
      this.offset.x = 0;
      this.offset.y = 0;
    }

    // Flash.
    let flashAlpha = 0;
    let flashColor = this.flashEntry?.color ?? this.fadeColor;
    if (this.flashEntry) {
      const f = this.flashEntry;
      f.elapsed += dt;
      const t = f.duration <= EPSILON ? 1 : Math.min(1, f.elapsed / f.duration);
      flashAlpha = 1 - t;
      if (t >= 1) this.flashEntry = null;
    }

    // Fade (persistent level).
    if (this.fadeEntry) {
      const fe = this.fadeEntry;
      fe.elapsed += dt;
      const t = fe.duration <= EPSILON ? 1 : Math.min(1, fe.elapsed / fe.duration);
      this.fadeLevel = t >= 1 ? fe.to : fe.from + (fe.to - fe.from) * EASINGS.easeInOut(t);
      if (t >= 1) {
        this.fadeEntry = null;
        try {
          fe.onComplete?.();
        } catch (err) {
          onError(err);
        }
      }
    }

    // Combine: flash pulse over persistent fade; flash color wins while flashing.
    const flashing = flashAlpha > 0;
    this.overlay.alpha = Math.max(flashAlpha, this.fadeLevel);
    this.overlay.color = flashing ? flashColor : this.fadeColor;

    // Zoom punch.
    if (this.zoomEntry) {
      const z = this.zoomEntry;
      z.elapsed += dt;
      const t = z.duration <= EPSILON ? 1 : Math.min(1, z.elapsed / z.duration);
      this._zoomMul = 1 + (z.scale - 1) * (1 - t);
      if (t >= 1) this.zoomEntry = null;
    } else {
      this._zoomMul = 1;
    }
  }
}
