/**
 * Project context: locating the Hearth project root from cwd (or an
 * explicit --project path) and opening a HearthSession against it.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  HearthSession,
  DEFAULT_MODES,
  parseModes,
  PROJECT_FILE,
  type PermissionMode,
} from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { createRuntimeHooks } from '@hearth/playtest';
import { logStderr } from './output.js';

export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface GlobalOpts {
  project?: string;
  json?: boolean;
  allow?: string;
  quiet?: boolean;
}

/** Walk up from `startDir` looking for a directory containing hearth.json. */
export function findProjectRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, PROJECT_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve the project root from global options, throwing a CliError if none is found. */
export function resolveProjectRoot(opts: GlobalOpts): string {
  if (opts.project) {
    const abs = path.resolve(opts.project);
    if (!existsSync(path.join(abs, PROJECT_FILE))) {
      throw new CliError(
        'PROJECT_NOT_FOUND',
        `No Hearth project found at ${abs} (missing ${PROJECT_FILE}).`,
      );
    }
    return abs;
  }
  const found = findProjectRoot(process.cwd());
  if (!found) {
    throw new CliError(
      'PROJECT_NOT_FOUND',
      `No Hearth project found (no ${PROJECT_FILE} in this or any parent directory). ` +
        `Use --project <path>, or run "hearth init <name>" to create one.`,
    );
  }
  return found;
}

function resolveGrantedModes(opts: GlobalOpts): PermissionMode[] {
  if (!opts.allow) return [...DEFAULT_MODES];
  try {
    return parseModes(opts.allow);
  } catch (err) {
    throw new CliError('INVALID_INPUT', (err as Error).message);
  }
}

/** Open a HearthSession for the current global options. Throws CliError on failure. */
export async function openSession(opts: GlobalOpts): Promise<HearthSession> {
  const root = resolveProjectRoot(opts);
  const granted = resolveGrantedModes(opts);
  return HearthSession.open(new NodeFileSystem(), root, {
    granted,
    runtime: createRuntimeHooks(),
    onLog: (level, message) => logStderr(opts.quiet, `[${level}] ${message}`),
  });
}
