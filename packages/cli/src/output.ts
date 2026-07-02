/**
 * Output formatting: everything that turns a CommandResult (or a CLI-level
 * meta result) into stdout/stderr text. `--json` always prints exactly the
 * CommandResult envelope (or an equivalent envelope for meta commands) as
 * pretty-printed JSON on stdout; human mode prints a concise summary.
 */
import type { CommandResult, CommandIssue, ChangedRef } from '@hearth/core';

export interface GlobalOutputOpts {
  json?: boolean;
  quiet?: boolean;
}

/** Build a CommandResult-shaped envelope for CLI-only (non-session) operations. */
export function makeResult<T>(
  command: string,
  success: boolean,
  data: T | null,
  extra: {
    errors?: CommandIssue[];
    warnings?: CommandIssue[];
    changed?: ChangedRef[];
    files?: string[];
    suggestions?: string[];
  } = {},
): CommandResult<T> {
  return {
    success,
    command,
    data,
    errors: extra.errors ?? [],
    warnings: extra.warnings ?? [],
    changed: extra.changed ?? [],
    files: extra.files ?? [],
    suggestions: extra.suggestions ?? [],
  };
}

/** Build a failing envelope from a single error code/message. */
export function errorResult(command: string, code: string, message: string): CommandResult<null> {
  return makeResult(command, false, null, { errors: [{ code, message }] });
}

/**
 * Print a result and return the process exit code (0 success, 1 failure).
 * This is the single place stdout is written for command output.
 */
export function emit(result: CommandResult<unknown>, opts: GlobalOutputOpts): number {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    printHuman(result);
  }
  return result.success ? 0 : 1;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length <= 6 && value.every((v) => typeof v !== 'object' || v === null)) {
      return `[${value.join(', ')}]`;
    }
    return `[${value.length} items]`;
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > 160 ? json.slice(0, 157) + '...' : json;
  }
  return String(value);
}

function printHuman(result: CommandResult<unknown>): void {
  const prefix = result.success ? '✓' : '✗';
  console.log(`${prefix} ${result.command}`);

  if (result.data !== null && result.data !== undefined) {
    if (typeof result.data === 'object' && !Array.isArray(result.data)) {
      for (const [key, value] of Object.entries(result.data as Record<string, unknown>)) {
        console.log(`  ${key}: ${formatValue(value)}`);
      }
    } else {
      console.log(`  ${formatValue(result.data)}`);
    }
  }

  if (result.changed.length > 0) {
    const summary = result.changed
      .map((c) => `${c.action} ${c.kind}${c.name ? ` "${c.name}"` : c.id ? ` ${c.id}` : ''}`)
      .join(', ');
    console.log(`  changed: ${summary}`);
  }
  if (result.files.length > 0) {
    console.log(`  files: ${result.files.join(', ')}`);
  }
  for (const w of result.warnings) {
    console.log(`  warning [${w.code}]: ${w.message}`);
  }
  for (const e of result.errors) {
    console.log(`  error [${e.code}]: ${e.message}`);
  }
  if (result.suggestions.length > 0) {
    console.log(`  next: ${result.suggestions.join(' | ')}`);
  }
}

/** Log a message to stderr, honoring --quiet. Never touches stdout. */
export function logStderr(quiet: boolean | undefined, message: string): void {
  if (!quiet) console.error(message);
}
