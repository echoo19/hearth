/**
 * Library entry point for @hearth/cli — exposes the commander program
 * builder so other packages/tests can drive the CLI programmatically.
 */
export { buildProgram } from './program.js';
export { findProjectRoot, resolveProjectRoot, openSession, CliError, type GlobalOpts } from './context.js';
export { emit, errorResult, makeResult } from './output.js';
