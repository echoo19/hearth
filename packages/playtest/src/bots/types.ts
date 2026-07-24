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
import type { MovementBasis } from './probe.js';

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

/**
 * How much a finding should worry the reader. `blocker` breaks the game,
 * `issue` is a probable defect, `note` is an observation worth a glance. The
 * verdict enum is unchanged — findings are additive, richer detail alongside it.
 */
export type FindingSeverity = 'blocker' | 'issue' | 'note';

/**
 * One observation about a run or a sweep, beyond the coarse verdict. Findings
 * are what make the judge genre-aware: a detector that does not apply to a game
 * emits nothing rather than a false failure. Kept flat and one-line-summarizable
 * so the report stays token-frugal.
 */
export interface Finding {
  /** Stable slug: ambiguous-avatar | unresponsive-input | unread-action | sealed-region | fade-softlock | wall-bump | seek-unreachable | crash-on-input | … */
  kind: string;
  severity: FindingSeverity;
  /** One line, agent-readable. */
  summary: string;
  /** Optional longer explanation (still one or two sentences). */
  detail?: string;
  /** Frame the observation is anchored to, when it has one. */
  frame?: number;
  /** Structured evidence for the report file; never required for the summary. */
  evidence?: Record<string, unknown>;
}

/** A detector that did not run, and why — surfaced so "not checked" is never silent. */
export interface SkippedDetector {
  kind: string;
  reason: string;
}

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
  /** Observations beyond the verdict — genre-aware, additive; may be empty. */
  findings: Finding[];
  /** Input action/axis names any script read during the run — union feeds dead-control detection. */
  readInputs: string[];
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
  /**
   * Probed movement basis, present only for policies that steer (wander, seek).
   * runBotRun computes it once, lazily, before frame 0 via probeMovement and
   * hands it in here; other policies never see it. Additive and optional so the
   * shape stays backward-compatible for mash/idle.
   */
  basis?: MovementBasis;
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
