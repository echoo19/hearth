/**
 * The probe contract: the capability surface Hearth needs from any game under
 * test. One contract, two ways to satisfy it: authored-in (a shim the building
 * agent writes into its own game) or adapted-on (an engine connector).
 *
 * Design rules, binding for every implementation and consumer:
 * - Capabilities are DECLARED, never assumed. A detector that needs a sense an
 *   implementation lacks must be skipped with an explicit SkippedDetector
 *   entry, never silently passed.
 * - Nothing here assumes determinism. The bot's own RNG is seeded and replays
 *   exactly; the game's response is treated as a distribution.
 * - Nothing here assumes an engine, a scene format, or 2D pixels. Positions
 *   are world units; coverage keys are opaque strings.
 */

/** What a game-under-test implementation can actually see and do. */
export interface ProbeCapabilities {
  /** Declared input vocabulary. Empty arrays are valid (pointer-only games). */
  input: {
    actions: string[];
    axes: string[];
    pointer: boolean;
  };
  senses: {
    /** T1: exception/error stream (console errors, push_error, window.onerror). */
    errors: boolean;
    /** T1: scene/level-change signal. */
    scenes: boolean;
    /** T1: named game-event stream. */
    events: boolean;
    /** T0/T1: entity enumeration with world positions + liveness. */
    entities: boolean;
    /** T1: screenshot (PNG). Unlocks pixel novelty, black-screen, evidence shots. */
    screenshot: boolean;
    /** T2: walkable-region / occupancy query. Unlocks wander frontier, sealed-region, coverage. */
    nav: boolean;
    /** T2: cheap episode reset to initial state. */
    reset: boolean;
    /** T2: the game can list the situations it can be put into, and enter one. */
    states: boolean;
  };
  /** Logical viewport in the game's own coordinate space. */
  viewport: { width: number; height: number };
}

export interface ProbeEntity {
  id: string;
  name?: string;
  tags?: string[];
  /** World position. */
  x: number;
  y: number;
  /** False once destroyed/disabled. */
  alive: boolean;
}

/**
 * One situation the game says it can be put into.
 *
 * Hearth never interprets `id` or `label`. It asks a game where it can put
 * itself and picks one of the answers, and what a state means stays the game's
 * business: a chapter, a lane, a scenario, a fiscal year, a save slot. The
 * moment this type decided what a state was, every game that disagreed would
 * stop fitting.
 */
export interface ProbeState {
  id: string;
  /** Human-readable, for the report and the UI. */
  label: string;
  /** Optional free-form detail the game wants a reader to have. */
  detail?: string;
}

/**
 * Read a state list out of whatever a game handed back.
 *
 * This parses something a game author wrote, so it never throws and never
 * invents: an entry without a usable id is dropped rather than given one, and
 * a game that declared nothing gets an empty list rather than an error.
 */
export function normalizeStates(raw: unknown): ProbeState[] {
  if (!Array.isArray(raw)) return [];
  const out: ProbeState[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { id?: unknown; label?: unknown; detail?: unknown };
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (id === '') continue;
    const label = typeof record.label === 'string' && record.label.trim() !== '' ? record.label.trim() : id;
    const state: ProbeState = { id, label };
    if (typeof record.detail === 'string' && record.detail.trim() !== '') state.detail = record.detail.trim();
    out.push(state);
  }
  return out;
}

export interface ProbeError {
  message: string;
  /** Best-effort source location, e.g. "player.js:31". */
  where?: string;
  at: ProbeInstant;
}

/** A moment in a run. `frame` is the probe's monotonic sample counter (always present); `ms` is game wall-clock when known. */
export interface ProbeInstant {
  frame: number;
  ms?: number;
}

/** What one step/sample of the game reported. Deltas since the previous step. */
export interface StepObservation {
  frame: number;
  ms?: number;
  newErrors: ProbeError[];
  /** Current scene/level identifier, null when the sense is absent. */
  sceneId: string | null;
  /** Names of game events emitted since last step (duplicates allowed). */
  newEvents: string[];
}

export interface NavGrid {
  originX: number;
  originY: number;
  cellSize: number;
  cols: number;
  rows: number;
  /** Row-major; true = solid/unwalkable. */
  solid: boolean[];
}

export type PointerKind = 'move' | 'down' | 'up' | 'click';

/**
 * The minimal interface the sweep loop drives. Optional methods MUST be
 * present exactly when the corresponding capability is declared true.
 */
export interface GameUnderTest {
  readonly capabilities: ProbeCapabilities;
  /** Bring the game to a playable state. Resolves when input will be accepted. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Advance/sample one unit of game time and return what changed.
   * Implementations choose the unit (a fixed tick when they control time, a
   * sample window when they don't) but MUST keep it roughly uniform in-run.
   */
  step(): Promise<StepObservation>;
  setActionDown(name: string): Promise<void>;
  setActionUp(name: string): Promise<void>;
  setAxis(name: string, value: number): Promise<void>;
  sendPointer(x: number, y: number, kind: PointerKind): Promise<void>;
  /** capabilities.senses.entities */
  listEntities?(): Promise<ProbeEntity[]>;
  /** capabilities.senses.entities — resolve by id, then exact name, then tag. */
  findEntity?(ref: string): Promise<ProbeEntity | null>;
  /** capabilities.senses.screenshot — PNG bytes. */
  screenshot?(): Promise<Uint8Array>;
  /** capabilities.senses.nav */
  navGrid?(): Promise<NavGrid | null>;
  /** capabilities.senses.reset */
  reset?(): Promise<void>;
  /** capabilities.senses.states — the situations this game can be put into. */
  listStates?(): Promise<ProbeState[]>;
  /** capabilities.senses.states — put the game into one of them, by its own id. */
  enterState?(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Verdicts, findings, evidence — the reporting contract (engine-agnostic).
// ---------------------------------------------------------------------------

export type Severity = 'blocker' | 'issue' | 'note';

export interface Finding {
  /** Short kebab-case slug, e.g. "sealed-region", "unresponsive-input". */
  kind: string;
  severity: Severity;
  summary: string;
  detail?: string;
  at?: ProbeInstant;
  /** Relative path (within the evidence dir) of a captured screenshot, when available. */
  shot?: string;
  evidence?: Record<string, unknown>;
}

export interface SkippedDetector {
  kind: string;
  /** Human-readable, names the missing capability. */
  reason: string;
}

/**
 * How much of a policy's machinery the game's declared senses could support.
 * `full` is the designed behavior. Anything else is a NAMED degradation, and it
 * travels with the result so nobody reads a degraded run as proof of more than
 * it is: `direct` means seek steered straight at its target with no nav grid to
 * path over, so it never routed around anything.
 */
export type PolicyMode = 'full' | 'direct';

/**
 * What became of one requested policy across a whole sweep: did it play, how
 * well-equipped was it, and if it never played, why not.
 *
 * One entry per policy the caller asked for, in the order they asked, so a UI
 * can render a panel per playtester without inferring anything.
 */
export interface PolicyStatus {
  policy: string;
  status: 'ran' | 'skipped';
  /** Runs completed under this policy. 0 when skipped. */
  runs: number;
  /** Only when skipped. Human-readable, names the missing capability. */
  reason?: string;
  /** Only when it ran. */
  mode?: PolicyMode;
  /** Only when it ran in a mode other than `full`: what that mode cannot do. */
  modeNote?: string;
}

/** Worst-to-best precedence: error > stuck > objective-failed > completed > ran-clean. */
export type Verdict = 'error' | 'stuck' | 'objective-failed' | 'completed' | 'ran-clean';

export interface Objective {
  type: 'reach' | 'survive' | 'event' | 'property';
  /** reach: entity ref or "x,y" point. property: entity ref. */
  target?: string;
  tolerance?: number;
  frames?: number;
  event?: string;
  count?: number;
  property?: string;
  greaterThan?: number;
  lessThan?: number;
  equals?: number | string | boolean;
}

export interface ObjectiveOutcome {
  objective: Objective;
  achieved: boolean;
  failed: boolean;
  achievedAt?: ProbeInstant;
}

export interface RunResult {
  policy: string;
  seed: number;
  /** Which mode the policy actually played in. Absent means `full`. */
  mode?: PolicyMode;
  verdict: Verdict;
  frames: number;
  wallMs: number;
  findings: Finding[];
  skipped: SkippedDetector[];
  objectives: ObjectiveOutcome[];
  firstError?: ProbeError;
  /** Opaque novelty/coverage keys visited (cell ids, scene ids, hash buckets). */
  coverageKeys: string[];
  /** Relative paths of captured screenshots within the evidence dir. */
  shots: string[];
}

export interface SweepFailure {
  policy: string;
  seed: number;
  verdict: Verdict;
  at?: ProbeInstant;
  detail: string;
  shot?: string;
}

export interface SweepReport {
  /** What was swept: a project dir, URL, or connector label. */
  target: string;
  /** The policies that actually ran. */
  policies: string[];
  /**
   * Every policy the caller asked for, ran or not, in the order asked. The
   * per-policy view: a skipped bot and its reason are as much a result as a
   * verdict tally, and this is where a UI reads both.
   *
   * `runSweep` always writes it. Optional only because reports written before
   * it existed are still on disk and still valid, so every reader has to cope
   * with its absence anyway.
   */
  policyStatus?: PolicyStatus[];
  seeds: number[];
  runs: number;
  verdicts: Record<Verdict, number>;
  /** Deduped, severity-sorted, capped (foldFindings discipline). */
  findings: Finding[];
  skipped: SkippedDetector[];
  /** Worst-first, capped at 5. */
  failures: SweepFailure[];
  framesSimulated: number;
  wallMs: number;
  /** Absolute path of this sweep's evidence directory. */
  evidenceDir: string;
}
