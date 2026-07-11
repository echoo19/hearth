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

/**
 * What `stepAnimator` writes into SpriteRenderer for the current frame: the
 * sprite asset id to draw, plus the sheet frame name when the current
 * entry is a `<assetId>#<frameName>` sheet ref (null for a plain sprite
 * asset ref).
 */
export interface AnimatorFrame {
  assetId: string;
  frame: string | null;
}

// Floating point tolerance for the elapsed >= frameDuration comparison:
// accumulating fixedDt (e.g. 1/60) across several frames can land a hair
// under the true threshold (6 * (1/60) = 0.09999999999999999 < 0.1), which
// would otherwise delay a frame advance by one extra step.
const EPSILON = 1e-9;

/** A frame-advance cursor: seconds toward the next frame + current frame index. */
export interface FramePlayback {
  elapsed: number;
  frame: number;
}

/**
 * Advance a frame-playback cursor one fixed step, mutating `pb` in place.
 * Shared by SpriteAnimator (stepAnimator) and the AnimationStateMachine
 * stepper so both use identical frame-advance math. `frameCount` must be > 0
 * and `frameDuration` > 0. Returns true when a NON-looping clip reached (and
 * stuck at) its final frame during this step — the caller decides what that
 * means (SpriteAnimator sets playing=false; the state machine marks the clip
 * done). Looping clips never return true and wrap to frame 0.
 */
export function advancePlayback(
  pb: FramePlayback,
  frameCount: number,
  frameDuration: number,
  loop: boolean,
  fixedDt: number,
): boolean {
  pb.elapsed += fixedDt;
  while (pb.elapsed >= frameDuration - EPSILON) {
    pb.elapsed -= frameDuration;
    pb.frame++;
    if (pb.frame >= frameCount) {
      if (loop) {
        pb.frame = 0;
      } else {
        pb.frame = frameCount - 1;
        pb.elapsed = 0;
        return true;
      }
    }
  }
  return false;
}

/**
 * Split a frames[] entry into the SpriteRenderer write: a plain sprite-asset
 * id (no '#') yields `frame: null`; a `<assetId>#<frameName>` sheet ref splits
 * on the first '#'.
 */
export function resolveFrameRef(ref: string): AnimatorFrame {
  const i = ref.indexOf('#');
  return i === -1 ? { assetId: ref, frame: null } : { assetId: ref.slice(0, i), frame: ref.slice(i + 1) };
}

/**
 * Advance one fixed step. Mutates `state` in place (and flips
 * `component.playing` to false when a non-looping animation finishes).
 * Returns the `{ assetId, frame }` that should be written into
 * SpriteRenderer.assetId/frame, or null when there's nothing to show (no
 * asset loaded yet, or the asset has no frames). A plain sprite-asset-id
 * entry (no '#') yields `frame: null`; a `<assetId>#<frameName>` sheet ref
 * splits on the first '#'.
 */
export function stepAnimator(
  state: AnimatorState,
  component: SpriteAnimatorComponent,
  asset: AnimationData | undefined,
  fixedDt: number,
): AnimatorFrame | null {
  if (component.assetId !== state.assetId) {
    state.assetId = component.assetId;
    state.elapsed = 0;
    state.frame = 0;
  }

  if (!asset || asset.frames.length === 0) return null;

  if (state.frame >= asset.frames.length) state.frame = asset.frames.length - 1;

  if (component.playing) {
    const frameDuration = component.fps > 0 ? 1 / component.fps : asset.frameDuration;
    if (advancePlayback(state, asset.frames.length, frameDuration, component.loop, fixedDt)) {
      component.playing = false;
    }
  }

  return resolveFrameRef(asset.frames[state.frame]);
}
