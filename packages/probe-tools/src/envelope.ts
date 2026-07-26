/**
 * The envelope every agent-facing surface in this package speaks.
 *
 * One shape, printed by `hearth-probe --json` and stringified into every MCP
 * tool result, so an agent that learns to read one has learned to read both.
 * It is deliberately the same discipline as @hearth/cli's CommandResult —
 * `success` first, machine-readable `errors` with codes, never a bare string —
 * minus the fields (changed/files/suggestions) that only mean something to a
 * project-mutating command. Nothing here probes anything; it is pure shape.
 */

export interface Issue {
  /** Stable machine-readable code. See ERROR_CODES. */
  code: string;
  message: string;
}

export interface Envelope<T> {
  /** Did the command run to completion? NOT "did the game pass". */
  success: boolean;
  /** The subcommand / tool name, e.g. "sweep". */
  command: string;
  data: T | null;
  errors: Issue[];
  warnings: Issue[];
}

/**
 * The full code vocabulary. An agent branches on these, so they are a closed
 * set and each one implies a different next move.
 */
export const ERROR_CODES = {
  /** Bad flags/arguments — fix the invocation. */
  INVALID_INPUT: 'INVALID_INPUT',
  /** No Chrome/Chromium available — install a browser, then retry. */
  CHROMIUM_MISSING: 'CHROMIUM_MISSING',
  /** Nothing has been swept yet under this root — run a sweep first. */
  NO_EVIDENCE: 'NO_EVIDENCE',
  /** The reference shim could not be located inside @hearth/adapter-web. */
  SHIM_UNRESOLVED: 'SHIM_UNRESOLVED',
  /** The game could not be opened or driven. */
  PROBE_FAILED: 'PROBE_FAILED',
  /** Anything unclassified. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export function ok<T>(command: string, data: T, warnings: Issue[] = []): Envelope<T> {
  return { success: true, command, data, errors: [], warnings };
}

export function fail(command: string, code: string, message: string, warnings: Issue[] = []): Envelope<never> {
  return { success: false, command, data: null, errors: [{ code, message }], warnings };
}

/**
 * A thrown error is not a code, so classify it once here rather than at every
 * catch site. The only structured signal the adapter gives us is the message
 * text of CHROMIUM_MISSING_ERROR, which is worth recognizing because it is the
 * one failure with an obvious, actionable fix.
 */
export function classifyError(err: unknown): ErrorCode {
  const message = errorMessage(err);
  if (/Chrome or Chromium|playwright install/i.test(message)) return ERROR_CODES.CHROMIUM_MISSING;
  if (/^(runSweep|openWebGame):/.test(message)) return ERROR_CODES.INVALID_INPUT;
  return ERROR_CODES.PROBE_FAILED;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

/** Failing envelope built from a thrown error, with the code inferred. */
export function failFrom(command: string, err: unknown, warnings: Issue[] = []): Envelope<never> {
  return fail(command, classifyError(err), errorMessage(err), warnings);
}

/** The exact bytes `--json` prints and every MCP tool result carries. */
export function stringifyEnvelope(envelope: Envelope<unknown>, pretty = false): string {
  return pretty ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope);
}
