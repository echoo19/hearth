/**
 * `@hearth/probe-tools` — the probe's agent-facing surfaces.
 *
 * @hearth/probe-core knows how to play a game and judge it; @hearth/adapter-web
 * knows how to drive a browser. This package is what makes either of them
 * reachable by something that isn't the Hearth app: a CLI (`hearth-probe`) for
 * an agent with a terminal, and a stdio MCP server (`hearth-probe-mcp`) for one
 * with a tool call. Both run the same five operations from `actions.ts` and
 * answer in the same envelope, so the evidence an outside agent produces is the
 * evidence the app renders — same files, same folding, same repro strings.
 */
export * from './envelope.js';
export * from './target.js';
export * from './format.js';
export * from './png.js';
export * from './store.js';
export * from './actions.js';
export { buildProgram, consoleIo, emit, parsePolicies, CLI_NAME, CLI_VERSION, type CliIo } from './cli.js';
export { createProbeMcpServer, SERVER_NAME, SERVER_VERSION, type ProbeMcpOptions } from './mcp.js';
