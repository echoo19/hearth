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

/** Cap on list items rendered inline before "… N more" — keeps output token-frugal. */
const MAX_LIST_ITEMS = 8;

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

/** True for an array whose entries are all plain objects — a list worth expanding. */
function isObjectList(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'object' && v !== null);
}

/**
 * One readable line for a list item, preferring known shapes: a finding
 * (severity + summary), a sweep failure (policy/seed/verdict + detail + repro),
 * else the most salient string field, else compact JSON. This is what turns the
 * old opaque "[N items]" into something an agent or human can act on.
 */
function summarizeItem(obj: Record<string, unknown>): string {
  const s = (k: string): string | undefined => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined);
  const severity = s('severity');
  const summary = s('summary');
  if (summary) return severity ? `[${severity}] ${summary}` : summary;
  // Sweep failure shape.
  if (obj.verdict !== undefined && (obj.policy !== undefined || obj.seed !== undefined)) {
    const head = `${obj.policy ?? '?'}/${obj.seed ?? '?'} ${obj.verdict}`;
    const detail = s('detail');
    const repro = s('repro');
    return [head, detail ? `— ${detail}` : '', repro ? `\n      repro: ${repro}` : ''].join(' ').trim();
  }
  const salient = s('message') ?? s('detail') ?? s('name') ?? s('reason');
  if (salient) return salient;
  const json = JSON.stringify(obj);
  return json.length > 140 ? json.slice(0, 137) + '...' : json;
}

/** Render a CommandResult as human-readable lines (the single source of stdout text). */
export function renderHuman(result: CommandResult<unknown>): string[] {
  const lines: string[] = [];
  const prefix = result.success ? '✓' : '✗';
  lines.push(`${prefix} ${result.command}`);

  if (result.data !== null && result.data !== undefined) {
    if (typeof result.data === 'object' && !Array.isArray(result.data)) {
      for (const [key, value] of Object.entries(result.data as Record<string, unknown>)) {
        if (isObjectList(value)) {
          lines.push(`  ${key}:`);
          for (const item of value.slice(0, MAX_LIST_ITEMS)) {
            lines.push(`    - ${summarizeItem(item)}`);
          }
          if (value.length > MAX_LIST_ITEMS) lines.push(`    … ${value.length - MAX_LIST_ITEMS} more`);
        } else {
          lines.push(`  ${key}: ${formatValue(value)}`);
        }
      }
    } else {
      lines.push(`  ${formatValue(result.data)}`);
    }
  }

  if (result.changed.length > 0) {
    const summary = result.changed
      .map((c) => `${c.action} ${c.kind}${c.name ? ` "${c.name}"` : c.id ? ` ${c.id}` : ''}`)
      .join(', ');
    lines.push(`  changed: ${summary}`);
  }
  if (result.files.length > 0) {
    lines.push(`  files: ${result.files.join(', ')}`);
  }
  for (const w of result.warnings) {
    lines.push(`  warning [${w.code}]: ${w.message}`);
  }
  for (const e of result.errors) {
    lines.push(`  error [${e.code}]: ${e.message}`);
  }
  if (result.suggestions.length > 0) {
    lines.push(`  next: ${result.suggestions.join(' | ')}`);
  }
  return lines;
}

function printHuman(result: CommandResult<unknown>): void {
  for (const line of renderHuman(result)) console.log(line);
}

/** Log a message to stderr, honoring --quiet. Never touches stdout. */
export function logStderr(quiet: boolean | undefined, message: string): void {
  if (!quiet) console.error(message);
}
