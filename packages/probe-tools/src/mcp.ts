#!/usr/bin/env node
/**
 * `hearth-probe-mcp` — the same probe, for an agent that speaks MCP.
 *
 * Five tools, one envelope, no second vocabulary: every result is the exact
 * JSON `hearth-probe --json` prints, stringified into a text block. An agent
 * that has read one has read the other, and — the point of the whole package —
 * the evidence it produces is byte-for-byte the evidence the Hearth app
 * renders, because both go through @hearth/probe-core's evidence store.
 *
 * The tool descriptions teach the loop rather than merely naming parameters:
 * an agent that has never seen Hearth should be able to read the tool list and
 * know what to do next.
 *
 * IMPORTANT: stdout is the JSON-RPC stream. Everything else goes to stderr.
 */
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_SCREENSHOT_STEPS,
  DEFAULT_SEED_START,
  DEFAULT_SEEDS,
  KNOWN_POLICIES,
  capabilitiesCommand,
  reportCommand,
  screenshotCommand,
  shimCommand,
  sweepCommand,
} from './actions.js';
import { stringifyEnvelope, type Envelope } from './envelope.js';

export const SERVER_NAME = 'hearth-probe-mcp';
export const SERVER_VERSION = '1.8.0';

/**
 * Prepended to every tool description. Repeating the loop once per tool is
 * cheap and means an agent that only ever reads one description still knows
 * where that tool sits in the cycle.
 */
const LOOP = 'Loop: build → probe_sweep → read findings → fix → sweep again.';

/** Every tool answers in the CLI's envelope, stringified. */
function envelopeResult(envelope: Envelope<unknown>, extra: CallToolResult['content'] = []): CallToolResult {
  return {
    content: [...extra, { type: 'text', text: stringifyEnvelope(envelope) }],
    isError: !envelope.success,
  };
}

export interface ProbeMcpOptions {
  /** Default directory for every tool that takes one. */
  root: string;
}

const dirArg = (root: string) => (dir: string | undefined) => (dir === undefined ? root : path.resolve(root, dir));

export function createProbeMcpServer(opts: ProbeMcpOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  const resolveDir = dirArg(opts.root);

  server.registerTool(
    'probe_sweep',
    {
      title: 'Sweep a web game',
      description:
        `Play the game with seeded bots and report what broke. ${LOOP} ` +
        'Runs policies x seeds episodes in a real headless browser and folds them into one small report: ' +
        'a verdict tally, deduped findings (capped at 8), and the worst failures (capped at 5), each with a ' +
        '`repro` string that re-runs that exact seeded episode. The bot is deterministic, the game is not, ' +
        'so read the tally as a distribution — one clean run proves nothing. ' +
        'Writes .hearth/evidence under the project (report.json, per-run JSON, screenshots); the Hearth app ' +
        'renders that directory live while the sweep runs. Read report.json for depth beyond the folded lists. ' +
        `Defaults: policies=mash, seeds=${DEFAULT_SEEDS}, maxSteps=${DEFAULT_MAX_STEPS}. ` +
        'Detectors whose senses the game does not declare appear under `skipped` — "no findings" never means ' +
        '"nothing was checked". Install the shim (probe_install_shim) to unlock the deeper ones.',
      inputSchema: {
        dir: z.string().optional().describe('game directory, relative to the server root (default: the root)'),
        url: z.string().optional().describe('sweep an already-served URL instead of a directory'),
        policies: z
          .array(z.enum(KNOWN_POLICIES as [string, ...string[]]))
          .optional()
          .describe('policies to run (default: ["mash"], which needs no senses at all)'),
        seeds: z.number().int().min(1).optional().describe(`episodes per policy (default ${DEFAULT_SEEDS})`),
        seedStart: z.number().int().min(0).optional().describe(`first seed (default ${DEFAULT_SEED_START})`),
        maxSteps: z.number().int().min(1).optional().describe(`steps per episode (default ${DEFAULT_MAX_STEPS})`),
        stepMs: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('wall-clock ms per step (default 100). A sweep costs roughly stepMs x maxSteps x runs.'),
        out: z.string().optional().describe('evidence root (default: the swept directory)'),
      },
    },
    async (args) => envelopeResult(await sweepCommand({ ...args, dir: resolveDir(args.dir) })),
  );

  server.registerTool(
    'probe_screenshot',
    {
      title: 'Screenshot a web game',
      description:
        `See the game with your own eyes. ${LOOP} ` +
        'Opens the game, lets it run for a few steps, and returns the frame as an image plus the PNG path on disk. ' +
        'Use it to confirm a fix looks right, or to look at what a sweep finding is describing. ' +
        'This is one frame, not evidence — findings come from probe_sweep.',
      inputSchema: {
        dir: z.string().optional().describe('game directory, relative to the server root (default: the root)'),
        url: z.string().optional().describe('screenshot an already-served URL instead of a directory'),
        out: z.string().optional().describe('output PNG path (default: shot.png in the project root)'),
        afterSteps: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(`steps to let the game run first (default ${DEFAULT_SCREENSHOT_STEPS})`),
        stepMs: z.number().int().min(1).optional().describe('wall-clock ms per step (default 100)'),
      },
    },
    async (args) => {
      const envelope = await screenshotCommand({
        dir: resolveDir(args.dir),
        url: args.url,
        outFile: args.out,
        afterSteps: args.afterSteps,
        stepMs: args.stepMs,
      });
      if (!envelope.success || !envelope.data) return envelopeResult(envelope);
      try {
        const png = await readFile(envelope.data.path);
        return envelopeResult(envelope, [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        ]);
      } catch {
        // The PNG is on disk either way; failing to inline it is not a failure.
        return envelopeResult({
          ...envelope,
          warnings: [
            ...envelope.warnings,
            { code: 'IMAGE_INLINE_FAILED', message: `saved to ${envelope.data.path}, but it could not be read back` },
          ],
        });
      }
    },
  );

  server.registerTool(
    'probe_report',
    {
      title: 'Read the latest sweep',
      description:
        `Re-read the most recent sweep's folded summary from .hearth/evidence. ${LOOP} ` +
        'Launches no browser and costs nothing — use it to re-check findings mid-fix instead of sweeping again, ' +
        'or after a sweep run by someone else (the app, a teammate, the hearth-probe CLI). ' +
        'Returns the same payload probe_sweep returns.',
      inputSchema: {
        dir: z.string().optional().describe('project directory holding .hearth/evidence (default: the server root)'),
        out: z.string().optional().describe('evidence root, if it is not the project directory'),
      },
    },
    async (args) => envelopeResult(await reportCommand({ dir: resolveDir(args.dir), out: args.out })),
  );

  server.registerTool(
    'probe_capabilities',
    {
      title: 'Ask what the game lets the probe see',
      description:
        'Open the game briefly and report the capability set it declares, plus whether the probe shim was detected. ' +
        `${LOOP} Run this first when a sweep comes back with a long "skipped" list: a game with no shim can only be ` +
        'checked for crashes and black screens, because the probe cannot tell where the player is or what level ' +
        'this is. Capabilities are declared, never assumed — a missing sense skips its detectors rather than ' +
        'silently passing them. The fix is probe_install_shim.',
      inputSchema: {
        dir: z.string().optional().describe('game directory, relative to the server root (default: the root)'),
        url: z.string().optional().describe('inspect an already-served URL instead of a directory'),
      },
    },
    async (args) => envelopeResult(await capabilitiesCommand({ dir: resolveDir(args.dir), url: args.url })),
  );

  server.registerTool(
    'probe_install_shim',
    {
      title: 'Install the probe shim into a game',
      description:
        'Copy the reference probe shim (probe-shim.js) into the game and return the two-line integration snippet. ' +
        `${LOOP} The shim is how a game hands over what only it knows — where entities are, which scene is loaded, ` +
        'which regions are walkable, how to restart an episode — turning a crash-only sweep into a real playtest. ' +
        'It is a plain script with no build step and no dependency: load it before your game code, then call ' +
        'window.__hearthProbe.configure({ actions, entities, scene, navGrid, reset }) by your first frame. ' +
        'After installing, wire the hooks, then re-run probe_capabilities to confirm the senses turned on.',
      inputSchema: {
        dir: z.string().optional().describe('directory to copy probe-shim.js into (default: the server root)'),
      },
    },
    async (args) => envelopeResult(await shimCommand({ dir: resolveDir(args.dir) })),
  );

  return server;
}

// ---------------------------------------------------------------------------
// stdio entry point
// ---------------------------------------------------------------------------

function usage(message?: string): never {
  if (message) console.error(`${SERVER_NAME}: ${message}\n`);
  console.error(
    `Usage: ${SERVER_NAME} --project <dir>\n` +
      '  --project  Root directory every tool defaults to (the game / project under test).',
  );
  process.exit(1);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let values: { project?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { project: { type: 'string' } }, strict: true }));
  } catch (err) {
    usage((err as Error).message);
  }
  const root = path.resolve(values.project ?? process.cwd());

  const server = createProbeMcpServer({ root });
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME}: serving the probe for ${root}`);
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
  await main().catch((err: unknown) => {
    console.error(`${SERVER_NAME}: fatal: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  });
}
