#!/usr/bin/env node
/**
 * hearth-mcp: stdio entry point. Opens a Hearth project and serves its
 * engine operations as MCP tools over stdio.
 *
 * Usage:
 *   hearth-mcp --project <path-to-hearth-project> [--mode <modes>]
 *
 * --mode is a comma-separated list of permission modes (read-only, safe-edit,
 * code-edit, asset-edit, build) or the literal "all". Defaults to core's
 * DEFAULT_MODES (read-only,safe-edit,code-edit,asset-edit) — build is opt-in.
 *
 * IMPORTANT: stdout is reserved for the MCP JSON-RPC stream. All logging
 * here goes to stderr.
 */
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HearthSession, DEFAULT_MODES, parseModes } from '@hearth/core';
import { NodeFileSystem, loadPlayerBundle } from '@hearth/core/node';
import { createRuntimeHooks } from '@hearth/playtest';
import { createHearthMcpServer } from './server.js';

function printUsageAndExit(message?: string): never {
  if (message) console.error(`hearth-mcp: ${message}\n`);
  console.error(
    'Usage: hearth-mcp --project <path-to-hearth-project> [--mode <modes>]\n' +
      '  --mode  Comma-separated permission modes (read-only,safe-edit,code-edit,asset-edit,build) or "all".\n' +
      '          Defaults to read-only,safe-edit,code-edit,asset-edit.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  let values: { project?: string; mode?: string };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        project: { type: 'string' },
        mode: { type: 'string' },
      },
      strict: true,
    }));
  } catch (err) {
    printUsageAndExit((err as Error).message);
  }

  if (!values.project) {
    printUsageAndExit('--project <path-to-hearth-project> is required');
  }

  const granted = values.mode ? parseModes(values.mode) : [...DEFAULT_MODES];

  let session: HearthSession;
  try {
    session = await HearthSession.open(new NodeFileSystem(), values.project, {
      granted,
      runtime: createRuntimeHooks(),
      resources: { getPlayerBundle: () => loadPlayerBundle() },
      onLog: (level, message) => console.error(`[hearth-mcp] [${level}] ${message}`),
      source: 'mcp',
    });
  } catch (err) {
    console.error(`hearth-mcp: failed to open project at "${values.project}": ${(err as Error).message}`);
    process.exit(1);
  }

  const server = createHearthMcpServer(session, granted);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `hearth-mcp: serving project "${session.store.project.name}" from ${values.project} (modes: ${granted.join(', ')})`,
  );
}

main().catch((err) => {
  console.error(`hearth-mcp: fatal error: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
