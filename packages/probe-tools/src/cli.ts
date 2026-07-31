#!/usr/bin/env node
/**
 * `hearth-probe` — the probe, for an agent with a terminal.
 *
 * The loop this command line exists to close:
 *
 *     build → hearth-probe sweep → read the findings → fix → sweep again
 *
 * Human output is written for something with a context window: a verdict tally
 * line, every finding rendered (never "[3 items]"), every failure with a
 * copy-paste repro that re-runs exactly that one seeded episode, and a pointer
 * to report.json for the depth that would be wasteful to inline. `--json`
 * prints the same envelope every MCP tool returns.
 *
 * Exit code is 0/1 on whether the *command* worked; a sweep that found real
 * failures also exits 1, so `hearth-probe sweep && deploy` means what it looks
 * like it means.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, type OptionValues } from 'commander';
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_POLICIES,
  DEFAULT_SCREENSHOT_STEPS,
  DEFAULT_SEED_START,
  DEFAULT_SEEDS,
  KNOWN_POLICIES,
  capabilitiesCommand,
  reportCommand,
  screenshotCommand,
  shimCommand,
  sweepCommand,
  type CapabilitiesData,
  type ScreenshotData,
  type ShimData,
} from './actions.js';
import { stringifyEnvelope, type Envelope } from './envelope.js';
import { renderSweepHuman, type SweepView } from './format.js';

export const CLI_NAME = 'hearth-probe';
export const CLI_VERSION = '1.8.0';

/** Where output goes. Injectable so tests can drive the real commands without a child process. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export const consoleIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Split `--policies a,b` into names. */
export function parsePolicies(raw: string): string[] {
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Coerce a numeric flag. NaN is passed through so actions.ts reports it uniformly. */
function toInt(raw: string): number {
  return Number.parseInt(raw, 10);
}

/**
 * Print an envelope and return the process exit code. `semanticFailure` lets a
 * command that *ran* fine still exit non-zero because of what it found — the
 * same split @hearth/cli draws with its `okIf` hook.
 */
export function emit(
  io: CliIo,
  envelope: Envelope<unknown>,
  opts: { json?: boolean },
  human: (data: never) => string[],
  semanticFailure = false,
): number {
  if (opts.json) {
    io.out(stringifyEnvelope(envelope, true));
  } else if (envelope.success && envelope.data !== null) {
    for (const line of human(envelope.data as never)) io.out(line);
    for (const warning of envelope.warnings) io.out(`  warning [${warning.code}]: ${warning.message}`);
  } else {
    io.out(`✗ ${envelope.command}`);
    for (const issue of envelope.errors) io.out(`  error [${issue.code}]: ${issue.message}`);
    for (const warning of envelope.warnings) io.out(`  warning [${warning.code}]: ${warning.message}`);
  }
  return envelope.success && !semanticFailure ? 0 : 1;
}

function renderScreenshot(data: ScreenshotData): string[] {
  const size = data.width && data.height ? ` (${data.width}x${data.height})` : '';
  return [
    `✓ screenshot: ${data.url}`,
    `  after ${data.afterSteps} steps${size}, ${data.bytes} bytes`,
    `  saved: ${data.path}`,
  ];
}

function renderShim(data: ShimData): string[] {
  return [
    `✓ shim ${data.overwrote ? 'replaced' : 'installed'}: ${data.path}`,
    '  load it before your game code:',
    ...data.snippet.split('\n').map((line) => `    ${line}`),
    '  then call window.__hearthProbe.configure({ entities, scene, reset, actions })',
    '  spec: docs/probe-shim.md in @hearth/adapter-web',
  ];
}

function renderCapabilities(data: CapabilitiesData): string[] {
  const { input, senses, viewport } = data.capabilities;
  const declared = Object.entries(senses)
    .filter(([, on]) => on)
    .map(([name]) => name);
  return [
    `✓ capabilities: ${data.url}`,
    `  shim: ${data.shimDetected ? 'detected' : 'absent'}`,
    `  senses: ${declared.join(', ') || 'none'}`,
    `  missing: ${data.missingSenses.join(', ') || 'none'}`,
    `  input: actions [${input.actions.join(', ')}] axes [${input.axes.join(', ')}] pointer ${input.pointer}`,
    `  viewport: ${viewport.width}x${viewport.height}`,
    `  ${data.advice}`,
  ];
}

/**
 * Build the commander program. `io` and `onExit` are injected so tests can run
 * a real command end-to-end and read its output without spawning a process.
 */
export function buildProgram(
  io: CliIo = consoleIo,
  onExit: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description(
      'Play a web game with seeded bots and report what broke. ' +
        'Loop: build → sweep → read findings → fix → sweep again. ' +
        'Sweeps write .hearth/evidence, which the Hearth app renders live.',
    )
    .version(CLI_VERSION)
    .option('--json', 'print the JSON envelope instead of human lines');

  const globals = (cmd: Command): OptionValues => cmd.optsWithGlobals();

  program
    .command('sweep')
    .argument('[dir]', 'directory containing the game (served on a loopback port)', undefined)
    .description('run policies x seeds episodes against the game and fold them into one report')
    .option('--url <url>', 'sweep a URL that is already being served, instead of a directory')
    .option('--policies <names>', `comma-separated policies (${KNOWN_POLICIES.join(', ')})`, parsePolicies, [
      ...DEFAULT_POLICIES,
    ])
    .option('--seeds <n>', 'seeds to run each policy with', toInt, DEFAULT_SEEDS)
    .option('--seed-start <n>', 'first seed (repros pin this)', toInt, DEFAULT_SEED_START)
    .option('--max-steps <n>', 'steps per episode', toInt, DEFAULT_MAX_STEPS)
    .option('--step-ms <ms>', 'wall-clock length of one step (default 100; a sweep costs ~ step-ms x max-steps x runs)', toInt)
    .option('--headed', 'show the browser window')
    .option('--out <root>', 'evidence root (default: the swept directory)')
    .option('--json', 'print the JSON envelope instead of human lines')
    .action(async (dir: string | undefined, _opts: OptionValues, cmd: Command) => {
      const opts = globals(cmd);
      const envelope = await sweepCommand({
        dir,
        url: opts.url as string | undefined,
        out: opts.out as string | undefined,
        policies: opts.policies as string[],
        seeds: opts.seeds as number,
        seedStart: opts.seedStart as number,
        maxSteps: opts.maxSteps as number,
        stepMs: opts.stepMs as number | undefined,
        headed: Boolean(opts.headed),
      });
      onExit(emit(io, envelope, opts, renderSweepHuman, !(envelope.data as SweepView | null)?.passed));
    });

  program
    .command('screenshot')
    .argument('[dir]', 'directory containing the game', undefined)
    .description('open the game, let it run, and save one PNG')
    .option('--url <url>', 'screenshot a URL that is already being served')
    .option('--out <file>', 'output PNG path', 'shot.png')
    .option('--after-steps <n>', 'steps to run before capturing', toInt, DEFAULT_SCREENSHOT_STEPS)
    .option('--step-ms <ms>', 'wall-clock length of one step (default 100)', toInt)
    .option('--headed', 'show the browser window')
    .option('--json', 'print the JSON envelope instead of human lines')
    .action(async (dir: string | undefined, _opts: OptionValues, cmd: Command) => {
      const opts = globals(cmd);
      const envelope = await screenshotCommand({
        dir,
        url: opts.url as string | undefined,
        outFile: opts.out as string | undefined,
        afterSteps: opts.afterSteps as number,
        stepMs: opts.stepMs as number | undefined,
        headed: Boolean(opts.headed),
      });
      onExit(emit(io, envelope, opts, renderScreenshot));
    });

  program
    .command('report')
    .argument('[dir]', 'project directory holding .hearth/evidence', undefined)
    .description('print the latest sweep summary from .hearth/evidence (no browser)')
    .option('--out <root>', 'evidence root, if it is not the project directory')
    .option('--json', 'print the JSON envelope instead of human lines')
    .action(async (dir: string | undefined, _opts: OptionValues, cmd: Command) => {
      const opts = globals(cmd);
      const envelope = await reportCommand({ dir, out: opts.out as string | undefined });
      onExit(emit(io, envelope, opts, renderSweepHuman, !(envelope.data as SweepView | null)?.passed));
    });

  program
    .command('capabilities')
    .argument('[dir]', 'directory containing the game', undefined)
    .description('open the game briefly and report what it lets the probe see')
    .option('--url <url>', 'inspect a URL that is already being served')
    .option('--json', 'print the JSON envelope instead of human lines')
    .action(async (dir: string | undefined, _opts: OptionValues, cmd: Command) => {
      const opts = globals(cmd);
      const envelope = await capabilitiesCommand({ dir, url: opts.url as string | undefined });
      onExit(emit(io, envelope, opts, renderCapabilities));
    });

  program
    .command('shim')
    .argument('[dir]', 'directory to copy probe-shim.js into', undefined)
    .description('install the reference probe shim and print the two-line integration snippet')
    .option('--json', 'print the JSON envelope instead of human lines')
    .action(async (dir: string | undefined, _opts: OptionValues, cmd: Command) => {
      const opts = globals(cmd);
      const envelope = await shimCommand({ dir });
      onExit(emit(io, envelope, opts, renderShim));
    });

  return program;
}

/** True when this module is the process entry point (and not merely imported). */
function isEntryPoint(moduleUrl: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(path.resolve(arg)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  await buildProgram().parseAsync(process.argv);
}
