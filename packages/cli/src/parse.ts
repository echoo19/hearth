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

/** Parse frame size "WIDTHxHEIGHT", e.g. --frame-size 32x32. Alias for parseSize. */
export function parseFrameSize(raw: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
  if (!match) {
    throw new ParseError(`Invalid --frame-size "${raw}": expected "WIDTHxHEIGHT", e.g. "32x32"`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new ParseError(`Invalid --frame-size "${raw}": width and height must be positive`);
  }
  return { width, height };
}

/** Parse a "w,h" pair, e.g. --size 40,20 (used by resizeTilemap; distinct from --size WIDTHxHEIGHT elsewhere). */
export function parseWidthHeight(raw: string, flagName = '--size'): { width: number; height: number } {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 2) {
    throw new ParseError(`Invalid ${flagName} "${raw}": expected "width,height"`);
  }
  const [width, height] = parts.map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new ParseError(`Invalid ${flagName} "${raw}": expected integer "width,height"`);
  }
  return { width, height };
}

/** Parse an "x,y,width,height" rectangle, e.g. --rect 0,0,4,2. */
export function parseRect(raw: string): { x: number; y: number; width: number; height: number } {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 4) {
    throw new ParseError(`Invalid --rect "${raw}": expected "x,y,width,height"`);
  }
  const [x, y, width, height] = parts.map(Number);
  if ([x, y, width, height].some((n) => !Number.isInteger(n))) {
    throw new ParseError(`Invalid --rect "${raw}": expected integer "x,y,width,height"`);
  }
  return { x, y, width, height };
}

/**
 * Parse "x,y,c;x,y,c" tile cells. Only the x/y fields are trimmed — the char
 * field is taken verbatim so a literal space (the eraser convention) survives,
 * e.g. --cells "0,0, " paints an empty cell at (0,0). A char containing a
 * comma can't be expressed in this format; use '.' as the empty/eraser char.
 */
export function parseCells(raw: string): Array<{ x: number; y: number; char: string }> {
  const cells: Array<{ x: number; y: number; char: string }> = [];
  for (const entry of raw.split(';')) {
    if (entry.length === 0) continue;
    const parts = entry.split(',');
    if (parts.length < 3) {
      throw new ParseError(`Invalid --cells entry "${entry}": expected "x,y,char"`);
    }
    const x = Number(parts[0].trim());
    const y = Number(parts[1].trim());
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new ParseError(`Invalid --cells entry "${entry}": expected integer x,y`);
    }
    const char = parts.slice(2).join(',');
    cells.push({ x, y, char });
  }
  if (cells.length === 0) {
    throw new ParseError(`Invalid --cells "${raw}": expected at least one "x,y,char" entry`);
  }
  return cells;
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
