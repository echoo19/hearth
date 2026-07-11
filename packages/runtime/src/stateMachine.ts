/**
 * Pure AnimationStateMachine stepping logic.
 *
 * One SmState per (AnimationStateMachine + SpriteRenderer) entity, holding the
 * current state, live param/trigger values, and a frame-playback cursor into
 * the current state's clip. `stepStateMachine` is a pure function: the runtime
 * owns state lifetime (created lazily, frozen while disabled or paused, reaped
 * on destruction — mirroring animator.ts/particles.ts) and asset preloading;
 * this module only advances one fixed step. Deterministic: no RNG, no clocks.
 *
 * Per-step order: (1) evaluate transitions from the current state, taking at
 * most one — explicit `from: current` transitions are considered before
 * `from: 'any'`, first eligible in declaration order wins; a taken transition
 * resets the clip to frame 0 and consumes ONLY the triggers named in its own
 * conditions (unconsumed triggers latch). (2) Advance the (possibly new)
 * current state's clip with its `speed` multiplier and return the frame to
 * write into SpriteRenderer.
 */
import type {
  AnimationData,
  AnimationStateMachineComponent,
  StateMachineCondition,
  StateMachineData,
  StateMachineState,
  StateMachineTransition,
} from '@hearth/core';
import { advancePlayback, resolveFrameRef, type AnimatorFrame } from './animator.js';

/** Per-entity state machine playback + param state. */
export interface SmState {
  /** Asset id this state was built for (detects component.assetId switches). */
  assetId: string;
  /** Current state name. */
  current: string;
  /** bool/number param values by name; triggers live in `triggers`. */
  params: Map<string, boolean | number>;
  /** Latched, not-yet-consumed trigger names. */
  triggers: Set<string>;
  /** Seconds accumulated toward the next frame of the current clip. */
  elapsed: number;
  /** Current frame index into the current state's clip. */
  frame: number;
  /** A non-looping clip has reached (and stuck at) its final frame. */
  clipDone: boolean;
}

/** Seed a fresh SmState from an asset: initial state, params at their defaults. */
export function createSmState(asset: StateMachineData, assetId = ''): SmState {
  const sm: SmState = {
    assetId,
    current: asset.initial,
    params: new Map(),
    triggers: new Set(),
    elapsed: 0,
    frame: 0,
    clipDone: false,
  };
  initParams(sm, asset);
  return sm;
}

function initParams(sm: SmState, asset: StateMachineData): void {
  sm.params.clear();
  for (const [name, p] of Object.entries(asset.params)) {
    if (p.type === 'bool') sm.params.set(name, typeof p.default === 'boolean' ? p.default : false);
    else if (p.type === 'number') sm.params.set(name, typeof p.default === 'number' ? p.default : 0);
    // trigger: no stored value; latch starts empty.
  }
}

function resetClip(sm: SmState): void {
  sm.frame = 0;
  sm.elapsed = 0;
  sm.clipDone = false;
}

function statesByName(asset: StateMachineData): Map<string, StateMachineState> {
  return new Map(asset.states.map((s) => [s.name, s]));
}

/**
 * Clip progress in [0, 1] for exitTime gating: 0 at frame 0, approaching 1 at
 * the end, and exactly 1 once a non-looping clip has finished. Looping clips
 * cycle 0 -> ~1 -> 0 each loop.
 */
function clipProgress(sm: SmState, state: StateMachineState, clips: Map<string, AnimationData>): number {
  if (sm.clipDone) return 1;
  const clip = clips.get(state.animation);
  if (!clip || clip.frames.length === 0) return 0;
  const frameDuration = clip.frameDuration / state.speed;
  const frac = frameDuration > 0 ? sm.elapsed / frameDuration : 0;
  return Math.min(1, (sm.frame + frac) / clip.frames.length);
}

function conditionMet(sm: SmState, cond: StateMachineCondition, asset: StateMachineData): boolean {
  const p = asset.params[cond.param];
  if (!p) return false; // author-time validated; be defensive
  if (p.type === 'trigger') return sm.triggers.has(cond.param);
  if (p.type === 'bool') {
    const b = sm.params.get(cond.param);
    const value = typeof b === 'boolean' ? b : false;
    return cond.op === 'neq' ? value !== cond.value : value === cond.value;
  }
  // number
  const n = sm.params.get(cond.param);
  const value = typeof n === 'number' ? n : 0;
  const target = cond.value as number;
  switch (cond.op) {
    case 'eq':
      return value === target;
    case 'neq':
      return value !== target;
    case 'gt':
      return value > target;
    case 'gte':
      return value >= target;
    case 'lt':
      return value < target;
    case 'lte':
      return value <= target;
    default:
      return false;
  }
}

function isEligible(
  sm: SmState,
  t: StateMachineTransition,
  state: StateMachineState | undefined,
  clips: Map<string, AnimationData>,
  asset: StateMachineData,
): boolean {
  for (const cond of t.conditions) {
    if (!conditionMet(sm, cond, asset)) return false;
  }
  if (t.exitTime !== undefined) {
    if (!state) return false;
    if (clipProgress(sm, state, clips) < t.exitTime) return false;
  }
  return true;
}

/**
 * Pick the transition to take this step, or null. Explicit `from: current`
 * transitions (excluding self-targets — self-transitions go through 'any')
 * are considered first in declaration order, then `from: 'any'` transitions
 * in declaration order. First eligible wins.
 */
function pickTransition(
  sm: SmState,
  asset: StateMachineData,
  states: Map<string, StateMachineState>,
  clips: Map<string, AnimationData>,
): StateMachineTransition | null {
  const state = states.get(sm.current);
  for (const t of asset.transitions) {
    if (t.from === sm.current && t.to !== sm.current && isEligible(sm, t, state, clips, asset)) {
      return t;
    }
  }
  for (const t of asset.transitions) {
    if (t.from === 'any' && isEligible(sm, t, state, clips, asset)) return t;
  }
  return null;
}

/**
 * Advance one fixed step. Mutates `sm` in place. Returns the `{ assetId, frame }`
 * to write into SpriteRenderer, or null when there's nothing to show (unknown
 * state, or its clip is missing/empty).
 */
export function stepStateMachine(
  sm: SmState,
  component: AnimationStateMachineComponent,
  asset: StateMachineData,
  clips: Map<string, AnimationData>,
  fixedDt: number,
): AnimatorFrame | null {
  // Rebuild on an asset switch (component.assetId changed under an existing state).
  if (sm.assetId !== component.assetId) {
    sm.assetId = component.assetId;
    sm.current = asset.initial;
    sm.triggers.clear();
    initParams(sm, asset);
    resetClip(sm);
  }

  const states = statesByName(asset);

  // Paused machines freeze entirely: no transitions, no clip advance.
  if (component.playing) {
    const taken = pickTransition(sm, asset, states, clips);
    if (taken) {
      for (const cond of taken.conditions) {
        if (asset.params[cond.param]?.type === 'trigger') sm.triggers.delete(cond.param);
      }
      sm.current = taken.to;
      resetClip(sm);
    }
  }

  const state = states.get(sm.current);
  if (!state) return null;
  const clip = clips.get(state.animation);
  if (!clip || clip.frames.length === 0) return null;
  if (sm.frame >= clip.frames.length) sm.frame = clip.frames.length - 1;

  if (component.playing && !sm.clipDone) {
    const frameDuration = clip.frameDuration / state.speed;
    if (advancePlayback(sm, clip.frames.length, frameDuration, clip.loop, fixedDt)) {
      sm.clipDone = true;
    }
  }

  return resolveFrameRef(clip.frames[sm.frame]);
}

// ---------------------------------------------------------------------------
// Param mutation helpers backing ctx.animator. These throw on misuse; the
// runtime lets those throws surface as script errors (Wave H error->line).
// ---------------------------------------------------------------------------

/** Set a bool/number param. Throws on unknown param, a trigger, or a type mismatch. */
export function setSmParam(
  sm: SmState,
  asset: StateMachineData,
  name: string,
  value: boolean | number,
): void {
  const p = asset.params[name];
  if (!p) throw new Error(`ctx.animator.setParam: unknown param "${name}"`);
  if (p.type === 'trigger') {
    throw new Error(`ctx.animator.setParam: "${name}" is a trigger param — use ctx.animator.fire`);
  }
  if (p.type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new Error(`ctx.animator.setParam: "${name}" is a bool param, got ${typeof value}`);
    }
  } else if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`ctx.animator.setParam: "${name}" is a number param, got ${typeof value}`);
  }
  sm.params.set(name, value);
}

/** Read a param: bool/number value, or the latched state of a trigger. Throws on unknown param. */
export function getSmParam(sm: SmState, asset: StateMachineData, name: string): boolean | number {
  const p = asset.params[name];
  if (!p) throw new Error(`ctx.animator.getParam: unknown param "${name}"`);
  if (p.type === 'trigger') return sm.triggers.has(name);
  return sm.params.get(name) ?? (p.type === 'bool' ? false : 0);
}

/** Latch a trigger. Throws on unknown param or a non-trigger param. */
export function fireSmTrigger(sm: SmState, asset: StateMachineData, name: string): void {
  const p = asset.params[name];
  if (!p) throw new Error(`ctx.animator.fire: unknown param "${name}"`);
  if (p.type !== 'trigger') throw new Error(`ctx.animator.fire: "${name}" is not a trigger param`);
  sm.triggers.add(name);
}
