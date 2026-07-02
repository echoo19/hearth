/**
 * Hearth MCP server: exposes every Hearth engine operation as an MCP tool,
 * dispatched through the same `HearthSession.execute()` command layer used
 * by the CLI and the editor. One operation vocabulary, every surface.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type HearthSession,
  type PermissionMode,
  generateAgentsMd,
  joinPath,
} from '@hearth/core';
import { TOOL_SPECS } from './tools.js';

const SERVER_NAME = 'hearth-mcp';
const SERVER_VERSION = '0.1.0';

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
