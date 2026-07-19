/**
 * Hearth MCP server: exposes every Hearth engine operation as an MCP tool,
 * dispatched through the same `HearthSession.execute()` command layer used
 * by the CLI and the editor. One operation vocabulary, every surface.
 */
import * as path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type HearthSession,
  type PermissionMode,
  generateAgentsMd,
  hasPermission,
  joinPath,
  PermissionError,
} from '@hearth/core';
import { captureScreenshot } from '@hearth/playtest';
import { zipDirectory } from '@hearth/shipping';
import { TOOL_SPECS } from './tools.js';

const SERVER_NAME = 'hearth-mcp';
// Hardcoded for the same reason as @hearth/cli's VERSION constant (see that
// file's comment) — keep in sync with package.json's "version" on every
// release.
const SERVER_VERSION = '1.3.0';

/** Project-relative path to a project's own agent instructions, if present. */
const AGENTS_MD_PATH = 'AGENTS.md';

function jsonResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError,
  };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** CommandResult-shaped envelope for tools (like `screenshot`) that don't run through session.execute(). */
function envelope(
  command: string,
  data: unknown,
  errors: { code: string; message: string }[] = [],
  files: string[] = [],
) {
  return { success: errors.length === 0, command, data, errors, warnings: [], changed: [], files, suggestions: [] };
}

/**
 * Build an McpServer wired to `session`, registering all Hearth commands as
 * tools. `granted` is only used for the informational
 * `get_agent_instructions` header — permission enforcement itself happens
 * inside `session.execute()`, which returns a structured PERMISSION_DENIED
 * error for commands the session isn't allowed to run.
 */
export function createHearthMcpServer(session: HearthSession, granted: PermissionMode[]): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  for (const spec of TOOL_SPECS) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.inputShape },
      async (args) => {
        // export_web's `zip` flag is an MCP/CLI-level post-step, not part of
        // exportWeb's own paramsSchema — mirrors the CLI's `export web --zip`
        // handling in packages/cli/src/program.ts (zipExportedDir), but via
        // @hearth/shipping's zipDirectory since this package already depends
        // on it for exportDesktop.
        if (spec.name === 'export_web') {
          const { zip, ...rest } = (args ?? {}) as { zip?: boolean; [key: string]: unknown };
          const result = await session.execute<{ outDir: string; slug: string }>(spec.command, rest);
          if (result.success && zip && result.data) {
            // The export itself has already succeeded and been persisted by
            // the time we get here; a failure zipping it (disk full,
            // permissions) must not turn that into a failed result — same
            // reasoning as session.ts's HISTORY_RECORD_FAILED /
            // JOURNAL_RECORD_FAILED warnings for a post-mutation step that
            // fails after the real work is done. Report it as a warning on
            // the normal envelope instead of letting the exception escape to
            // the MCP SDK's generic (unstructured) error handler.
            try {
              const zipRel = await zipExportedWebBuild(session.root, result.data.outDir, result.data.slug);
              (result.data as Record<string, unknown>).zip = zipRel;
              result.files.push(zipRel);
            } catch (err) {
              result.warnings.push({
                code: 'ZIP_FAILED',
                message: `Export succeeded, but zipping the output failed: ${(err as Error).message}`,
              });
            }
          }
          return jsonResult(result, !result.success);
        }
        const result = await session.execute(spec.command, args ?? {});
        return jsonResult(result, !result.success);
      },
    );
  }

  // Not in TOOL_SPECS: unlike every other tool, screenshot does not dispatch
  // to a core command via session.execute. Capturing a screenshot launches
  // headless Chromium (Node/Playwright-only, not something @hearth/core can
  // depend on since core must stay usable in the browser — see
  // exportCommands.ts's "core cannot use node:Buffer" note), so
  // captureScreenshot lives in @hearth/playtest and is called directly here,
  // the same way get_agent_instructions below calls generateAgentsMd
  // directly. It still requires the "build" permission mode, same as
  // export_web, so that check is replicated by hand (session.execute would
  // normally do this for a registry command).
  server.registerTool(
    'screenshot',
    {
      description:
        'Capture a deterministic PNG screenshot of a scene via headless Chrome/Chromium. ' +
        'Scene defaults to the project\'s initial scene. Returns screenshot metadata (path, width, ' +
        'height, frame, scene) as JSON; read the PNG file yourself. (requires build)',
      inputSchema: {
        scene: z.string().min(1).optional(),
        frame: z.number().int().min(0).optional(),
        seed: z.number().int().min(0).optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        debug: z.boolean().optional(),
        out: z.string().optional(),
      },
    },
    async (args) => {
      if (!hasPermission(granted, 'build')) {
        const err = new PermissionError('build', granted, 'screenshot');
        return jsonResult(envelope('screenshot', null, [{ code: 'PERMISSION_DENIED', message: err.message }]), true);
      }
      try {
        const data = await captureScreenshot(session.store, args ?? {});
        return jsonResult(envelope('screenshot', data, [], [data.path]));
      } catch (err) {
        return jsonResult(
          envelope('screenshot', null, [{ code: 'INTERNAL_ERROR', message: (err as Error).message }]),
          true,
        );
      }
    },
  );

  server.registerTool(
    'get_agent_instructions',
    {
      description:
        "Get this project's agent instructions (its AGENTS.md, or Hearth's generated default) plus the permission modes active this session.",
      inputSchema: {},
    },
    async () => {
      const header =
        `Hearth MCP session permissions: ${granted.join(', ')}. ` +
        'Commands that require a mode not listed here will fail with PERMISSION_DENIED.\n\n';
      const agentsMdPath = joinPath(session.root, AGENTS_MD_PATH);
      let body: string;
      if (await session.fs.exists(agentsMdPath)) {
        body = await session.fs.readFile(agentsMdPath);
      } else {
        body = generateAgentsMd(session.store.project.name);
      }
      return textResult(header + body);
    },
  );

  return server;
}

/**
 * Zip an exported web build (STORE-only, via @hearth/shipping's
 * zipDirectory) next to the output folder as `<slug>-web.zip` — same
 * naming/path semantics as the CLI's `export web --zip` post-step
 * (zipExportedDir in packages/cli/src/program.ts). Returns the
 * project-relative zip path. Node-only: operates on real disk paths, same as
 * the CLI and the exportDesktop packager.
 */
async function zipExportedWebBuild(projectRoot: string, outDirRel: string, slug: string): Promise<string> {
  const outAbs = path.resolve(projectRoot, outDirRel);
  const zipAbs = path.join(path.dirname(outAbs), `${slug}-web.zip`);
  await zipDirectory(outAbs, zipAbs);
  return path.relative(projectRoot, zipAbs).split(path.sep).join('/');
}
