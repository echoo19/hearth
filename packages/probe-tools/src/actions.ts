/**
 * The five operations, once.
 *
 * `cli.ts` and `mcp.ts` are both thin: they parse their own dialect of
 * arguments, call one of these, and render the returned envelope. That is
 * deliberate — the promise of this package is that a coding agent in a
 * terminal and a coding agent over MCP produce *the same evidence*, and the
 * cheapest way to keep that true is to give them one implementation instead
 * of two that drift.
 *
 * Every function here returns an Envelope and throws nothing: a failure an
 * agent can act on (no browser, no evidence yet, bad flags) is data, not an
 * exception.
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  NodeEvidenceStore,
  policyRegistry,
  runSweep,
  type ProbeCapabilities,
} from '@hearth/probe-core';
import { PROBE_SHIM_PATH, openWebGame, type WebGameUnderTest } from '@hearth/adapter-web';
import { ERROR_CODES, fail, failFrom, ok, type Envelope, type Issue } from './envelope.js';
import { sweepView, type SweepView } from './format.js';
import { pngSize } from './png.js';
import { findLatestSweep } from './store.js';
import { resolveTarget, type TargetInput } from './target.js';

/** Default policy set: mash needs no senses at all, so it runs against anything. */
export const DEFAULT_POLICIES = ['mash'];
export const DEFAULT_SEEDS = 6;
export const DEFAULT_SEED_START = 1;
/**
 * Lower than probe-core's DEFAULT_MAX_STEPS (1050) on purpose: this is the
 * agent-facing default, and a sweep an agent will actually wait for beats a
 * thorough one it cancels. Raise it with --max-steps for a deep pass.
 */
export const DEFAULT_MAX_STEPS = 600;
/** Steps to let the game run before a `screenshot` grabs the frame. */
export const DEFAULT_SCREENSHOT_STEPS = 30;
/**
 * One step is a wall-clock sample window, so a sweep's runtime is roughly
 * `stepMs x maxSteps x runs` plus the input probe. Left undefined here so
 * @hearth/adapter-web's own DEFAULT_STEP_MS (100ms) stands unless a caller
 * asks otherwise — a fast game can be sampled at 16ms and finish in a sixth
 * the time, but detector windows are counted in steps, so shortening a step
 * shortens the game-time a "stuck" window covers.
 */
/** Where `shim` writes, and what the integration snippet references. */
export const SHIM_FILENAME = 'probe-shim.js';

/** The two lines docs/probe-shim.md tells you to add, verbatim. */
export const SHIM_SNIPPET = [
  `<script src="${SHIM_FILENAME}"></script>`,
  '<script src="game.js"></script>',
].join('\n');

export const KNOWN_POLICIES = Object.keys(policyRegistry).sort();

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

export interface SweepInput extends TargetInput {
  policies?: string[] | undefined;
  seeds?: number | undefined;
  seedStart?: number | undefined;
  maxSteps?: number | undefined;
  /** Wall-clock length of one step. See DEFAULT_SCREENSHOT_STEPS's note. */
  stepMs?: number | undefined;
  /** Show the browser window. Useful for a human watching; slower. */
  headed?: boolean | undefined;
}

export async function sweepCommand(input: SweepInput): Promise<Envelope<SweepView>> {
  const command = 'sweep';
  const policies = input.policies?.length ? input.policies : [...DEFAULT_POLICIES];
  const count = input.seeds ?? DEFAULT_SEEDS;
  const seedStart = input.seedStart ?? DEFAULT_SEED_START;
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;

  const unknown = policies.filter((name) => !(name in policyRegistry));
  if (unknown.length > 0) {
    return fail(
      command,
      ERROR_CODES.INVALID_INPUT,
      `unknown policy: ${unknown.join(', ')} (known: ${KNOWN_POLICIES.join(', ')})`,
    );
  }
  const bad = badInteger([
    ['--seeds', count, 1],
    ['--seed-start', seedStart, 0],
    ['--max-steps', maxSteps, 1],
    ['--step-ms', input.stepMs, 1],
  ]);
  if (bad) return fail(command, ERROR_CODES.INVALID_INPUT, bad);

  const target = resolveTarget(input);
  const missing = await missingDirError(command, target.open.dir);
  if (missing) return missing;

  const seeds = Array.from({ length: count }, (_, i) => seedStart + i);
  let game: WebGameUnderTest | null = null;
  try {
    game = await openWebGame({ ...target.open, headless: !input.headed, stepMs: input.stepMs });
    // runSweep owns start()/stop() and stops the game in its own `finally`.
    const report = await runSweep(game, {
      policies,
      seeds,
      evidence: new NodeEvidenceStore(target.root),
      target: target.label,
      maxSteps,
    });
    const view = sweepView(report);
    const warnings: Issue[] = [];
    const notRun = policies.filter((name) => !report.policies.includes(name));
    if (notRun.length > 0) {
      warnings.push({
        code: 'POLICIES_SKIPPED',
        message:
          `${notRun.join(', ')} did not run against this game. See "not checked" for the missing ` +
          'capability. Install the probe shim (hearth-probe shim) to unlock the deeper senses.',
      });
    }
    return ok(command, view, warnings);
  } catch (err) {
    await game?.stop().catch(() => undefined);
    return failFrom(command, err);
  }
}

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

export interface ScreenshotInput extends TargetInput {
  /** Output file. Relative paths resolve against the evidence root. */
  outFile?: string | undefined;
  afterSteps?: number | undefined;
  stepMs?: number | undefined;
  headed?: boolean | undefined;
}

export interface ScreenshotData {
  path: string;
  url: string;
  afterSteps: number;
  bytes: number;
  width: number | null;
  height: number | null;
  shimDetected: boolean;
}

export async function screenshotCommand(input: ScreenshotInput): Promise<Envelope<ScreenshotData>> {
  const command = 'screenshot';
  const afterSteps = input.afterSteps ?? DEFAULT_SCREENSHOT_STEPS;
  const bad = badInteger([
    ['--after-steps', afterSteps, 0],
    ['--step-ms', input.stepMs, 1],
  ]);
  if (bad) return fail(command, ERROR_CODES.INVALID_INPUT, bad);

  const target = resolveTarget(input);
  const missing = await missingDirError(command, target.open.dir);
  if (missing) return missing;
  const outPath = path.resolve(target.root, input.outFile ?? 'shot.png');

  let game: WebGameUnderTest | null = null;
  try {
    game = await openWebGame({ ...target.open, headless: !input.headed, stepMs: input.stepMs });
    await game.start();
    for (let i = 0; i < afterSteps; i++) await game.step();
    if (!game.screenshot) {
      return fail(command, ERROR_CODES.PROBE_FAILED, 'this game declares no screenshot sense');
    }
    const png = await game.screenshot();
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, png);
    const size = pngSize(png);
    return ok(command, {
      path: outPath,
      url: game.url,
      afterSteps,
      bytes: png.byteLength,
      width: size?.width ?? null,
      height: size?.height ?? null,
      shimDetected: game.shimDetected,
    });
  } catch (err) {
    return failFrom(command, err);
  } finally {
    await game?.stop().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export async function reportCommand(input: TargetInput): Promise<Envelope<SweepView>> {
  const command = 'report';
  const target = resolveTarget({ ...input, url: undefined });
  try {
    const latest = await findLatestSweep(target.root);
    if (!latest) {
      return fail(
        command,
        ERROR_CODES.NO_EVIDENCE,
        `no finished sweep under ${target.root}. Run: hearth-probe sweep ${target.root}`,
      );
    }
    return ok(command, sweepView(latest.report));
  } catch (err) {
    return fail(command, ERROR_CODES.INTERNAL_ERROR, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

export interface CapabilitiesData {
  url: string;
  shimDetected: boolean;
  capabilities: ProbeCapabilities;
  /** Senses declared false — the reason detectors get skipped. */
  missingSenses: string[];
  /** What to do about them, in one line. */
  advice: string;
}

/** Open the game just long enough to read what it declares, then close it. */
export async function capabilitiesCommand(
  input: TargetInput & { headed?: boolean | undefined; stepMs?: number | undefined },
): Promise<Envelope<CapabilitiesData>> {
  const command = 'capabilities';
  const target = resolveTarget(input);
  const missing = await missingDirError(command, target.open.dir);
  if (missing) return missing;

  let game: WebGameUnderTest | null = null;
  try {
    game = await openWebGame({ ...target.open, headless: !input.headed, stepMs: input.stepMs });
    await game.start();
    const capabilities = game.capabilities;
    const missingSenses = Object.entries(capabilities.senses)
      .filter(([, on]) => !on)
      .map(([name]) => name);
    return ok(command, {
      url: game.url,
      shimDetected: game.shimDetected,
      capabilities,
      missingSenses,
      advice: game.shimDetected
        ? missingSenses.length === 0
          ? 'every sense is declared, so no detector will be skipped'
          : `the shim is installed but declares no ${missingSenses.join('/')} hook; add it to deepen the sweep`
        : 'no probe shim detected: the sweep can only see errors and pixels. Run hearth-probe shim to install it, then declare entities()/scene()/reset().',
    });
  } catch (err) {
    return failFrom(command, err);
  } finally {
    await game?.stop().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// shim
// ---------------------------------------------------------------------------

export interface ShimData {
  /** Where the reference copy was read from. */
  source: string;
  /** Where it now lives, inside the game. */
  path: string;
  snippet: string;
  overwrote: boolean;
}

export async function shimCommand(input: { dir?: string | undefined; cwd?: string | undefined }): Promise<Envelope<ShimData>> {
  const command = 'shim';
  const dir = path.resolve(input.cwd ?? process.cwd(), input.dir ?? '.');
  const missing = await missingDirError(command, dir);
  if (missing) return missing;

  let source: string;
  try {
    source = await resolveShimSource();
  } catch (err) {
    return fail(command, ERROR_CODES.SHIM_UNRESOLVED, (err as Error).message);
  }

  const dest = path.join(dir, SHIM_FILENAME);
  const overwrote = await exists(dest);
  try {
    await copyFile(source, dest);
  } catch (err) {
    return fail(command, ERROR_CODES.INTERNAL_ERROR, `could not write ${dest}: ${(err as Error).message}`);
  }
  const warnings: Issue[] = overwrote
    ? [{ code: 'SHIM_OVERWRITTEN', message: `${dest} already existed and was replaced with the reference copy` }]
    : [];
  return ok(command, { source, path: dest, snippet: SHIM_SNIPPET, overwrote }, warnings);
}

/**
 * Find `shim/probe-shim.js` inside @hearth/adapter-web at runtime.
 *
 * The adapter's own `PROBE_SHIM_PATH` is the answer whenever this package was
 * loaded normally (it resolves relative to the adapter's module, from `src/`
 * or `dist/` alike). The `require.resolve` fallback covers a bundled or
 * relocated build where that relative walk lands somewhere that no longer
 * exists — the package publishes `./shim` as an export for exactly this.
 *
 * `PROBE_SHIM_PATH` is null in a build where the adapter could not work out
 * where its own file lives, which is what a CommonJS bundle does to it. That
 * is one fewer place to look rather than a failure: the two fallbacks below
 * are exactly the ones written for a bundle.
 */
export async function resolveShimSource(): Promise<string> {
  const candidates: string[] = PROBE_SHIM_PATH === null ? [] : [PROBE_SHIM_PATH];
  try {
    candidates.push(createRequire(import.meta.url).resolve('@hearth/adapter-web/shim'));
  } catch {
    // The export map is unreachable from here; PROBE_SHIM_PATH may still be good.
  }
  // The single-file bundles (hearth-probe.mjs in a packaged Hearth install)
  // have no @hearth/adapter-web on disk at all; there, build-electron ships
  // probe-shim.js next to the entry file, so look beside whatever is running.
  if (process.argv[1]) candidates.push(path.join(path.dirname(process.argv[1]), SHIM_FILENAME));
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(
    `could not locate ${SHIM_FILENAME} inside @hearth/adapter-web (looked at: ${candidates.join(', ')}). ` +
      'Reinstall @hearth/adapter-web, or copy its shim/probe-shim.js by hand.',
  );
}

// ---------------------------------------------------------------------------

/** First flag whose value is present but not an integer at or above `min`. */
function badInteger(checks: readonly (readonly [string, number | undefined, number])[]): string | null {
  for (const [flag, value, min] of checks) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < min) {
      return `${flag} must be an integer >= ${min} (got ${value})`;
    }
  }
  return null;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** A clear INVALID_INPUT rather than a browser-shaped error for a missing directory. */
async function missingDirError(command: string, dir: string | undefined): Promise<Envelope<never> | null> {
  if (!dir) return null;
  try {
    const info = await stat(dir);
    if (info.isDirectory()) return null;
    return fail(command, ERROR_CODES.INVALID_INPUT, `not a directory: ${dir}`);
  } catch {
    return fail(command, ERROR_CODES.INVALID_INPUT, `no such directory: ${dir}`);
  }
}
