/**
 * Hearth MCP server: exposes every Hearth engine operation as an MCP tool,
 * dispatched through the same `HearthSession.execute()` command layer used
 * by the CLI and the editor. One operation vocabulary, every surface.
 */
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
import { TOOL_SPECS } from './tools.js';

const SERVER_NAME = 'hearth-mcp';
// Hardcoded for the same reason as @hearth/cli's VERSION constant (see that
// file's comment) — keep in sync with package.json's "version" on every
// release; see the version-bump checklist in .superpowers/sdd/task-12-report.md.
const SERVER_VERSION = '0.8.0';

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
