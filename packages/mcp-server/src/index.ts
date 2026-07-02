/**
 * @hearth/mcp-server — programmatic entry point (for embedding/testing).
 * The stdio CLI entry point is `main.ts` (bin: hearth-mcp).
 */
export { createHearthMcpServer } from './server.js';
export { TOOL_SPECS, type ToolSpec } from './tools.js';
