/**
 * Playtesting, from the app.
 *
 * Pressing Playtest runs a real sweep: `@hearth/adapter-web` opens the game the
 * folder currently holds in headless Chromium, `@hearth/probe-core`'s
 * `runSweep` plays it under seeded policies, and every milestone lands in
 * `.hearth/evidence/journal.jsonl` — which the evidence watcher is already
 * tailing, so verdicts stream into the rail while the sweep is still running.
 * There is no second progress channel: the journal IS the progress.
 *
 * Two deliberate shapes here:
 *
 *  - **One sweep at a time per folder.** A sweep drives a browser and appends
 *    to a single journal; two at once would interleave two experiments into one
 *    record. A second request gets 409 rather than a queue, because the honest
 *    answer to "playtest again" while one is running is "one is running".
 *  - **Both probe packages are loaded lazily**, through injected deps. They pull
 *    in a browser automation stack that a plain editor session should never
 *    touch, and tests stand in a fake game instead of launching Chromium.
 *
 * When a sweep finishes, the adapter's DECLARED capabilities are written to
 * `.hearth/evidence/capabilities.json`. That file is what turns the capability
 * strip from a guess into a read-out: senses the game actually proved it has.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { EvidenceEvent, EvidenceStore, GameUnderTest, ProbeCapabilities, SweepReport } from '@hearth/probe-core';

/** Where the last sweep's declared capabilities are recorded. */
export const CAPABILITIES_FILE = path.join('.hearth', 'evidence', 'capabilities.json');

/**
 * Defaults sized for a button press, not a CI run: two policies that need no
 * cooperation from the game, two seeds each, and short runs — enough for a
 * verdict distribution and a handful of frames within about half a minute.
 * Callers that want a deeper sweep pass their own.
 */
export const DEFAULT_SWEEP_POLICIES = ['mash', 'idle'];
export const DEFAULT_SWEEP_SEEDS = [1, 2];
export const DEFAULT_SWEEP_MAX_STEPS = 60;
/** Upper bounds on what a client may ask for, so one POST can't run for hours. */
export const MAX_SWEEP_SEEDS = 8;
export const MAX_SWEEP_STEPS = 2000;

/** What the client may ask for. Everything is optional; everything is clamped. */
export interface SweepRequest {
  policies?: string[];
  seeds?: number[];
  maxSteps?: number;
}

export interface SweepPlan {
  policies: string[];
  seeds: number[];
  maxSteps: number;
}

/** A game the sweep can drive, plus what the adapter says it can sense. */
export interface OpenedGame extends GameUnderTest {
  readonly shimDetected?: boolean;
}

/**
 * The two probe entry points and the evidence store, injectable so tests never
 * launch a browser. Production callers omit this and get the real packages,
 * imported on first use.
 */
export interface SweepDeps {
  openGame(opts: { dir: string; headless: boolean }): Promise<OpenedGame>;
  runSweep(
    game: GameUnderTest,
    opts: { policies: string[]; seeds: number[]; evidence: EvidenceStore; target: string; maxSteps: number },
  ): Promise<SweepReport>;
  createStore(root: string): EvidenceStore | Promise<EvidenceStore>;
}

/**
 * Clamp a request into something runnable. Unknown policy names are left to
 * runSweep, which records them as skips with a reason — that is more honest
 * than silently dropping them here.
 */
export function planSweep(request: SweepRequest | undefined): SweepPlan {
  const asked = Array.isArray(request?.policies)
    ? request.policies.filter((name): name is string => typeof name === 'string' && name.trim() !== '')
    : [];
  const seeds = Array.isArray(request?.seeds)
    ? request.seeds.filter((seed): seed is number => Number.isFinite(seed)).map((seed) => Math.trunc(seed))
    : [];
  const maxSteps = Number.isFinite(request?.maxSteps) ? Math.trunc(request!.maxSteps!) : DEFAULT_SWEEP_MAX_STEPS;
  return {
    policies: asked.length > 0 ? [...new Set(asked)] : [...DEFAULT_SWEEP_POLICIES],
    seeds: seeds.length > 0 ? [...new Set(seeds)].slice(0, MAX_SWEEP_SEEDS) : [...DEFAULT_SWEEP_SEEDS],
    maxSteps: Math.min(Math.max(maxSteps, 1), MAX_SWEEP_STEPS),
  };
}

/** The real deps, resolved on first use so nothing loads a browser stack eagerly. */
export function defaultSweepDeps(): SweepDeps {
  return {
    async openGame(opts) {
      const { openWebGame } = await import('@hearth/adapter-web');
      return openWebGame({ dir: opts.dir, headless: opts.headless });
    },
    async runSweep(game, opts) {
      const { runSweep } = await import('@hearth/probe-core');
      return runSweep(game, opts);
    },
    createStore: createNodeEvidenceStore,
  };
}

/** The default evidence store — `.hearth/evidence` under the project root. */
export async function createNodeEvidenceStore(root: string): Promise<EvidenceStore> {
  const { NodeEvidenceStore } = await import('@hearth/probe-core');
  return new NodeEvidenceStore(root);
}

/** What the last sweep proved this game can be sensed through. */
export interface CapabilityRecord {
  ts: string;
  target: string;
  shimDetected: boolean;
  capabilities: ProbeCapabilities;
}

export async function writeCapabilities(root: string, record: CapabilityRecord): Promise<void> {
  const file = path.join(root, CAPABILITIES_FILE);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export async function readCapabilities(root: string): Promise<CapabilityRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(path.join(root, CAPABILITIES_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Partial<CapabilityRecord>;
    return record.capabilities && typeof record.capabilities === 'object'
      ? {
          ts: typeof record.ts === 'string' ? record.ts : new Date(0).toISOString(),
          target: typeof record.target === 'string' ? record.target : '',
          shimDetected: record.shimDetected === true,
          capabilities: record.capabilities as ProbeCapabilities,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * What the capability strip lights, given a recorded capability set. Preview,
 * errors and shots come free with any web game the adapter can open; the rest
 * are only claimed when the game declared them (i.e. the shim was detected).
 * Pure, so the honesty rule is unit-tested without a browser.
 */
export function sensesFromCapabilities(record: CapabilityRecord | null, gamePresent: boolean): string[] {
  if (!gamePresent) return [];
  const senses = ['preview', 'errors', 'screenshots'];
  const declared = record?.capabilities.senses;
  if (declared?.entities) senses.push('entities');
  if (declared?.events) senses.push('events');
  if (declared?.scenes) senses.push('scenes');
  return senses;
}

/**
 * A sweep in flight, per project root. `promise` settles when the job is done
 * (successfully or not) — the route hands it back so callers and tests can wait
 * without polling the filesystem.
 */
export interface SweepJob {
  root: string;
  dir: string;
  plan: SweepPlan;
  startedAt: number;
  promise: Promise<SweepReport | null>;
}

export class SweepRunner {
  private readonly active = new Map<string, SweepJob>();

  constructor(private readonly deps: Partial<SweepDeps> = {}) {}

  /** The job currently running for `root`, if any. */
  jobFor(root: string): SweepJob | undefined {
    return this.active.get(root);
  }

  isBusy(root: string): boolean {
    return this.active.has(root);
  }

  /**
   * Start a sweep of the game in `dir`. Returns the job; throws only when one
   * is already running for this root (the caller turns that into a 409).
   *
   * The job runs OFF the request: a sweep takes tens of seconds and its
   * progress is already streaming through the evidence journal, so holding the
   * HTTP response open for it would only add a timeout to fail on.
   */
  start(opts: { root: string; dir: string; target: string; plan: SweepPlan }): SweepJob {
    const existing = this.active.get(opts.root);
    if (existing) throw new SweepBusyError(opts.root);
    const job: SweepJob = {
      root: opts.root,
      dir: opts.dir,
      plan: opts.plan,
      startedAt: Date.now(),
      promise: Promise.resolve(null),
    };
    this.active.set(opts.root, job);
    job.promise = this.run(opts).finally(() => {
      if (this.active.get(opts.root) === job) this.active.delete(opts.root);
    });
    // The caller may not await; a rejection must not become an unhandled one.
    void job.promise.catch(() => undefined);
    return job;
  }

  private async run(opts: { root: string; dir: string; target: string; plan: SweepPlan }): Promise<SweepReport | null> {
    const fallback = defaultSweepDeps();
    const openGame = this.deps.openGame ?? fallback.openGame;
    const runSweep = this.deps.runSweep ?? fallback.runSweep;
    const evidence = await (this.deps.createStore ?? fallback.createStore)(opts.root);

    let game: OpenedGame;
    try {
      game = await openGame({ dir: opts.dir, headless: true });
    } catch (err) {
      // A missing browser is the common failure and it is not a crash — say so
      // in the same feed the results would have appeared in.
      await note(evidence, `Playtest could not start: ${(err as Error).message}`);
      throw err;
    }

    try {
      const report = await runSweep(game, {
        policies: opts.plan.policies,
        seeds: opts.plan.seeds,
        evidence,
        target: opts.target,
        maxSteps: opts.plan.maxSteps,
      });
      await writeCapabilities(opts.root, {
        ts: new Date().toISOString(),
        target: opts.target,
        shimDetected: game.shimDetected === true,
        capabilities: game.capabilities,
      });
      if (report?.evidenceDir) await indexSweepShots(evidence, report.evidenceDir);
      return report;
    } catch (err) {
      await note(evidence, `Playtest failed: ${(err as Error).message}`);
      throw err;
    }
  }
}

/** How many frames from a finished sweep get a line in the feed. */
export const INDEXED_SHOTS_PER_SWEEP = 6;

/**
 * Pick the frames worth showing from a sweep's runs: the LAST shot of each run
 * — the most progressed moment the probe reached — newest run first, capped.
 * Pure, so the selection rule is testable without a filesystem.
 */
export function pickSweepShots(
  runs: readonly { policy?: string; seed?: number; shots?: string[] }[],
  limit = INDEXED_SHOTS_PER_SWEEP,
): { path: string; caption: string }[] {
  const picked: { path: string; caption: string }[] = [];
  for (const run of runs) {
    const shots = run.shots ?? [];
    const last = shots[shots.length - 1];
    if (!last) continue;
    picked.push({ path: last, caption: `${run.policy ?? 'run'} · seed ${run.seed ?? '?'}` });
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * Put a finished sweep's frames in the feed.
 *
 * `runSweep` writes screenshots and references them from each RunResult, but
 * the journal only carries milestones — so without this, evidence the probe
 * actually captured never reaches the rail. Indexing them here (rather than
 * teaching the rail to walk sweep directories) keeps ONE source for the feed:
 * if it is in the journal, the UI shows it.
 *
 * Best-effort: a sweep with unreadable run files is still a finished sweep.
 */
export async function indexSweepShots(evidence: EvidenceStore, evidenceDir: string): Promise<number> {
  const sweepId = path.basename(evidenceDir);
  let runs: { policy?: string; seed?: number; shots?: string[] }[];
  try {
    const dir = path.join(evidenceDir, 'runs');
    const files = (await fsp.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    runs = await Promise.all(
      files.map(async (name) => JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'))),
    );
  } catch {
    return 0;
  }
  const shots = pickSweepShots(runs);
  for (const shot of shots) {
    const event: Omit<Extract<EvidenceEvent, { kind: 'shot' }>, 'seq' | 'ts'> = {
      kind: 'shot',
      sweepId,
      path: shot.path,
      caption: shot.caption,
    };
    try {
      await evidence.append(event);
    } catch {
      return shots.indexOf(shot);
    }
  }
  return shots.length;
}

/** Thrown when a second sweep is asked for while one is running. */
export class SweepBusyError extends Error {
  constructor(readonly root: string) {
    super('A playtest is already running for this folder.');
    this.name = 'SweepBusyError';
  }
}

/** Best-effort journal note; a failure to record a failure must not throw again. */
async function note(evidence: EvidenceStore, text: string): Promise<void> {
  // Built as a typed variable rather than inline: the committed
  // `EvidenceStore.append` signature uses a non-distributive Omit, which
  // collapses the event union to its common `kind` field.
  const event: Omit<Extract<EvidenceEvent, { kind: 'note' }>, 'seq' | 'ts'> = {
    kind: 'note',
    text,
    source: 'app',
  };
  try {
    await evidence.append(event);
  } catch {
    /* the journal is unwritable; the thrown error still reaches the caller */
  }
}
