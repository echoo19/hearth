/**
 * @hearth/playtest bots — shared types.
 *
 * The bot executor plays a scene headlessly: a seeded policy reads live state
 * each frame and injects input through an InputRecorder, which both applies the
 * input to the live runtime and logs a `(frame, input-event)` timeline. That
 * timeline is the single source of truth a later bake step replays bit-for-bit.
 *
 * Everything here is deterministic: a policy only ever draws from the injected
 * mulberry32 rng (see runBotRun); no wall clock, no Math.random.
 */
import type { Objective } from '@hearth/core';
import type { GameSession, RuntimeEntity, SceneRuntime } from '@hearth/runtime';
import type { ProjectStore } from '@hearth/core';
import type { InputRecorder } from './recorder.js';

/**
 * One recorded bot input, tagged with the frame it was applied on (the frame
 * index before that frame's step). The discriminated union mirrors the three
 * input surfaces a policy can touch: named digital actions, virtual axes, and
 * the pointer.
 */
export type InputEvent = { frame: number } & (
  | { kind: 'action'; action: string; down: boolean }
  | { kind: 'axis'; axis: string; value: number }
  | { kind: 'pointer'; x: number; y: number; button?: 'down' | 'up' }
);

/** Which built-in policy to run, and against what. */
export interface BotRunConfig {
  scene: string;
  policy: 'mash' | 'idle' | 'wander' | 'seek';
  seed: number;
  maxFrames: number;
  stuckAfter: number;
  avatar?: string;
  target?: string | { x: number; y: number };
  objectives: Objective[];
}

/** One-per-run outcome, most severe first in the sweep report's ordering. */
export type BotVerdict = 'error' | 'stuck' | 'completed' | 'objective-failed' | 'ran-clean';

/** Per-objective result: when it was first achieved (sticky), and whether it definitively failed. */
export interface ObjectiveOutcome {
  index: number;
  summary: string;
  achievedAtFrame: number | null;
  failed: boolean;
}

/** Everything one bot run produces — a compact record plus the full input timeline. */
export interface BotRunResult {
  policy: string;
  seed: number;
  verdict: BotVerdict;
  endFrame: number;
  firstError?: { message: string; frame: number };
  stuckAtFrame?: number;
  objectives: ObjectiveOutcome[];
  /** Number of distinct 32px world-grid cells visited. */
  cellsVisited: number;
  /** Visited cell keys ("cx,cy"), sorted for deterministic output. */
  visitedCells: string[];
  timeline: InputEvent[];
}

/**
 * What a policy is handed once, at run start. Task 3's wander/seek extend this
 * with a probed movement basis (added as an optional field so the shape stays
 * backward-compatible).
 */
export interface BotInitCtx {
  session: GameSession;
  store: ProjectStore;
  /** The one deterministic stream every policy decision must draw from. */
  rng: () => number;
  config: BotRunConfig;
  /** Resolved avatar entity id, or null (mash/idle tolerate a null avatar). */
  avatar: string | null;
  /** Digital action names from inputMappings, sorted for deterministic iteration. */
  actions: string[];
  /** Virtual axis names from inputMappings, sorted for deterministic iteration. */
  axes: string[];
  /** Viewport size in screen coordinates (buildSettings width×height). */
  viewport: { width: number; height: number };
}

/** What a policy reads each frame. `input` is the ONLY input surface it may touch. */
export interface BotObservation {
  /** Frame index about to be stepped (0-based). */
  frame: number;
  session: GameSession;
  /** Live runtime for the current scene — resolved fresh each frame. */
  runtime: SceneRuntime;
  /** Live avatar entity this frame, re-resolved from the runtime; null when none/gone. */
  avatar: RuntimeEntity | null;
  /** Apply-and-record input surface; see InputRecorder. */
  input: InputRecorder;
}

/** A bot policy: configured once via init, consulted every frame via onFrame. */
export interface BotPolicy {
  init(ctx: BotInitCtx): void;
  onFrame(obs: BotObservation): void;
}
