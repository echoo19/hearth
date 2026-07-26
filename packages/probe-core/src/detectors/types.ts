/**
 * What a detector is, and the one rule every detector obeys.
 *
 * A detector declares the senses it needs (`requires`). If the game under test
 * does not declare them, the detector does not run and the sweep records a
 * SkippedDetector saying which sense was missing. It never quietly passes — a
 * probe that cannot see a thing must say so, otherwise "no findings" is a lie.
 *
 * Detectors are fed a uniform per-step sample and are allowed two outputs: an
 * optional verdict escalation (crash → error, novelty drought → stuck) and a
 * list of findings at the end of the run.
 */
import type {
  Finding,
  NavGrid,
  ProbeCapabilities,
  ProbeEntity,
  ProbeInstant,
  StepObservation,
  Verdict,
} from '../contract.js';
import type { Direction } from '../nav.js';
import type { RgbaImage } from '../png.js';

/** A key into ProbeCapabilities.senses. */
export type CapabilityKey = keyof ProbeCapabilities['senses'];

export interface DetectorConfig {
  /** World-unit size of a coverage cell. */
  cellSize: number;
  /** Steps without novelty before a run is called stuck. */
  stuckAfter: number;
  /** Minimum Hamming distance before a frame hash counts as a new bucket. */
  hashDistance: number;
  /** Steps between screenshot samples (0 disables sampling). */
  screenshotEvery: number;
  /** Mean luminance below which a frame is "dark". */
  blackScreenLuma: number;
  /** Luminance variance below which a dark frame is "flat" (a blank canvas). */
  blackScreenVariance: number;
  /** How long darkness must persist before it is a finding. */
  blackScreenSteps: number;
  /** Displacement along the steering intent, per step, that still counts as blocked. */
  wallBumpEpsilon: number;
  /** Consecutive blocked steps inside a stall before wall-bump fires. */
  wallBumpWindow: number;
  /** Sealed walkable fraction above which sealed-region fires. */
  sealedRatio: number;
  /** Displacement below which an input probe counts as "nothing moved". */
  moveEpsilon: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  cellSize: 32,
  stuckAfter: 180,
  hashDistance: 4,
  screenshotEvery: 30,
  blackScreenLuma: 0.04,
  blackScreenVariance: 0.0004,
  blackScreenSteps: 60,
  wallBumpEpsilon: 0.25,
  wallBumpWindow: 45,
  sealedRatio: 0.2,
  moveEpsilon: 2,
};

/** One step of the run, as every detector sees it. */
export interface ProbeSample {
  instant: ProbeInstant;
  obs: StepObservation;
  /** Live entity snapshot, or null when the sense is absent. */
  entities: readonly ProbeEntity[] | null;
  /** The resolved avatar this step, or null. */
  avatar: ProbeEntity | null;
  /** Decoded frame — present only on sampled steps. */
  image: RgbaImage | null;
  /** Evidence-relative path of the frame, when it was persisted. */
  shot?: string;
  /** Unit direction the policy is currently steering toward, or null. */
  intent: Direction | null;
  /** Did the coverage tracker see something new this step? */
  novel: boolean;
  /** Steps since the last novelty (0 on a novel step). */
  framesSinceNovelty: number;
}

export interface DetectorInit {
  capabilities: ProbeCapabilities;
  config: DetectorConfig;
  /** Name of the policy driving this run — some detectors do not apply to some policies. */
  policy: string;
  /** The nav grid, when the game has one. */
  navGrid: NavGrid | null;
  /** The avatar's position at run start, when known. */
  spawn: { x: number; y: number } | null;
}

export interface Detector {
  readonly kind: string;
  /** Senses this detector cannot work without. */
  readonly requires: readonly CapabilityKey[];
  /**
   * Extra availability rule beyond `requires` — return a reason to skip, or
   * null to run. Called before `start`.
   */
  unavailable?(capabilities: ProbeCapabilities, policy: string): string | null;
  start(init: DetectorInit): void;
  observe(sample: ProbeSample): void;
  /** Verdict escalation after the latest sample, or null. */
  verdict(): Verdict | null;
  /** Findings for the run. Called once, after the loop. */
  finish(): Finding[];
}

/** Shared no-op scaffolding so each detector file is only its own logic. */
export abstract class BaseDetector implements Detector {
  abstract readonly kind: string;
  readonly requires: readonly CapabilityKey[] = [];
  protected config: DetectorConfig = DEFAULT_DETECTOR_CONFIG;
  protected policy = '';

  start(init: DetectorInit): void {
    this.config = init.config;
    this.policy = init.policy;
    this.onStart(init);
  }

  protected onStart(_init: DetectorInit): void {}

  abstract observe(sample: ProbeSample): void;

  verdict(): Verdict | null {
    return null;
  }

  finish(): Finding[] {
    return [];
  }
}

/** Human-readable name for a missing sense, used in skip reasons. */
export const SENSE_LABEL: Record<CapabilityKey, string> = {
  errors: 'error stream',
  scenes: 'scene signal',
  events: 'event stream',
  entities: 'entity enumeration',
  screenshot: 'screenshots',
  nav: 'nav grid',
  reset: 'episode reset',
};
