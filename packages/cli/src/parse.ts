/**
 * CLI-side value parsing helpers: turning raw string args/flags into the
 * typed shapes core command params expect.
 */

/** A small, local error type so callers can distinguish parse failures. */
export class ParseError extends Error {}

/**
 * Parse a raw CLI value: JSON if it parses cleanly, otherwise the raw
 * string. This lets agents pass `100` -> number, `true` -> boolean,
 * `"#ff0000"` -> string, and bare `#ff0000` -> string (JSON.parse throws,
 * so we fall back to the original text).
 */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Parse an "x,y" pair into { x, y }. */
export function parsePosition(raw: string): { x: number; y: number } {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 2) {
    throw new ParseError(`Invalid --position "${raw}": expected "x,y"`);
  }
  const [x, y] = parts.map(Number);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    throw new ParseError(`Invalid --position "${raw}": expected numeric "x,y"`);
  }
  return { x, y };
}

/** Parse a comma-separated list, dropping empty entries. */
export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse a required JSON object option (e.g. --properties '{"x":1}'). */
export function parseJsonObject(raw: string | undefined, flagName: string): Record<string, unknown> {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new ParseError(`Invalid JSON for ${flagName}: ${(err as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ParseError(`Invalid JSON for ${flagName}: expected an object`);
  }
  return value as Record<string, unknown>;
}

/** Parse a "WIDTHxHEIGHT" size, e.g. --size 800x600. */
export function parseSize(raw: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
  if (!match) {
    throw new ParseError(`Invalid --size "${raw}": expected "WIDTHxHEIGHT", e.g. "800x600"`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new ParseError(`Invalid --size "${raw}": width and height must be positive`);
  }
  return { width, height };
}

/** Parse a JSON array option (e.g. --steps-file contents). */
export function parseJsonArray(raw: string, sourceName: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new ParseError(`Invalid JSON in ${sourceName}: ${(err as Error).message}`);
  }
  if (!Array.isArray(value)) {
    throw new ParseError(`Invalid JSON in ${sourceName}: expected an array`);
  }
  return value;
}
