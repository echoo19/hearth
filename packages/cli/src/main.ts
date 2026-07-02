#!/usr/bin/env node
/**
 * hearth — CLI entry point. Builds the program and parses argv.
 * Commands set `process.exitCode` themselves (0 success / 1 failure); we
 * never call `process.exit()` directly so pending stdout writes can flush.
 */
import { buildProgram } from './program.js';

const program = buildProgram();
await program.parseAsync(process.argv);
