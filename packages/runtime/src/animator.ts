/**
 * Pure SpriteAnimator stepping logic.
 *
 * One AnimatorState per (SpriteAnimator + SpriteRenderer) entity, holding
 * the currently playing asset id plus how far into it playback has gotten.
 * `stepAnimator` is a pure function: the runtime owns state lifetime
 * (created lazily, frozen while the entity is disabled, reaped only on
 * entity destruction — mirroring particles.ts's EmitterState) and asset
 * preloading; this module only knows how to advance one frame.
 */
import type { AnimationData, SpriteAnimatorComponent } from '@hearth/core';

/** Per-entity playback position for one SpriteAnimator. */
export interface AnimatorState {
  /** Asset id this state was last advanced against (detects script switches). */
  assetId: string;
  /** Seconds accumulated toward the next frame. */
  elapsed: number;
  /** Current frame index into the asset's `frames` array. */
  frame: number;
}

export function createAnimatorState(assetId: string): AnimatorState {
  return { assetId, elapsed: 0, frame: 0 };
}

// Floating point tolerance for the elapsed >= frameDuration comparison:
// accumulating fixedDt (e.g. 1/60) across several frames can land a hair
// under the true threshold (6 * (1/60) = 0.09999999999999999 < 0.1), which
// would otherwise delay a frame advance by one extra step.
const EPSILON = 1e-9;

/**
 * Advance one fixed step. Mutates `state` in place (and flips
 * `component.playing` to false when a non-looping animation finishes).
 * Returns the sprite asset id that should be written into
 * SpriteRenderer.assetId, or null when there's nothing to show (no asset
 * loaded yet, or the asset has no frames).
 */
export function stepAnimator(
  state: AnimatorState,
  component: SpriteAnimatorComponent,
  asset: AnimationData | undefined,
  fixedDt: number,
): string | null {
  if (component.assetId !== state.assetId) {
    state.assetId = component.assetId;
    state.elapsed = 0;
    state.frame = 0;
  }

  if (!asset || asset.frames.length === 0) return null;

  if (state.frame >= asset.frames.length) state.frame = asset.frames.length - 1;

  if (component.playing) {
    const frameDuration = component.fps > 0 ? 1 / component.fps : asset.frameDuration;
    state.elapsed += fixedDt;
    while (state.elapsed >= frameDuration - EPSILON) {
      state.elapsed -= frameDuration;
      state.frame++;
      if (state.frame >= asset.frames.length) {
        if (component.loop) {
          state.frame = 0;
        } else {
          state.frame = asset.frames.length - 1;
          component.playing = false;
          state.elapsed = 0;
          break;
        }
      }
    }
  }

  return asset.frames[state.frame];
}
