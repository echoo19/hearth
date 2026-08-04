/**
 * Markdown, only as far as the transcript actually needs it.
 *
 * The agent is never told to write markdown. Hearth injects nothing into a
 * custom agent's prompt and this file does not change that — it is a reader,
 * not a contract. Agents write markdown because that is what they do, and the
 * transcript was showing them their own brackets and backticks.
 *
 * Two rules shape everything below.
 *
 * The first is that PLAIN PROSE MUST COME OUT UNCHANGED. Text with no markdown
 * in it parses to exactly one paragraph carrying exactly the characters that
 * went in, newlines included, and the renderer puts that in the same
 * `.msg-text` element with the same `white-space: pre-wrap` it has always used.
 * So the parser preserves newlines inside a paragraph rather than folding them
 * into spaces the way a document renderer would. A chat line break is a line
 * break; the agent meant it.
 *
 * The second is that A HALF-WRITTEN MARKER IS NOT A MARKER. This text arrives a
 * few characters at a time, so every construct here is recognised only once its
 * CLOSER has arrived: an opening backtick with nothing to match it is a
 * backtick, an unmatched `**` is two asterisks, and a fence whose info line has
 * not been terminated by a newline yet is an ordinary line of prose. Without
 * that rule the tail of a message flickers through bold, code and back as the
 * delimiters land. It also means the parse is stable rather than merely
 * eventually correct: a construct never appears and then withdraws.
 *
 * Unterminated fences are the one deliberate exception. Once `\n` follows
 * ```` ```lang ```` the block is real and the lines under it are code, closer or
 * no closer, because the alternative is prose that abruptly reflows into a code
 * block when the closing fence lands, which is the very flash this is avoiding.
 * It is marked `closed: false` so the renderer can withhold the copy button
 * while it is still filling.
 */

export interface MdTextSpan {
  kind: 'text';
  text: string;
}

/** Backticked. Rendered verbatim, so nothing inside is parsed further. */
export interface MdCodeSpan {
  kind: 'code';
  text: string;
}

export interface MdStrongSpan {
  kind: 'strong';
  spans: MdSpan[];
}

export interface MdEmSpan {
  kind: 'em';
  spans: MdSpan[];
}

/** An http, https or mailto destination. Nothing else is ever a link. */
export interface MdLinkSpan {
  kind: 'link';
  href: string;
  spans: MdSpan[];
}

/**
 * An absolute path on this machine. `text` is what the agent wrote, down to a
 * trailing `:12:3`; `target` is the same path with that suffix removed, which
 * is what the app's own open and reveal handlers take.
 */
export interface MdPathSpan {
  kind: 'path';
  target: string;
  text: string;
}

export type MdSpan = MdTextSpan | MdCodeSpan | MdStrongSpan | MdEmSpan | MdLinkSpan | MdPathSpan;

export interface MdParagraph {
  kind: 'paragraph';
  spans: MdSpan[];
}

export interface MdHeading {
  kind: 'heading';
  level: number;
  spans: MdSpan[];
}

export interface MdListItem {
  spans: MdSpan[];
  children: MdList | null;
}

export interface MdList {
  kind: 'list';
  ordered: boolean;
  start: number;
  items: MdListItem[];
}

export interface MdFence {
  kind: 'fence';
  lang: string;
  text: string;
  /** False while the closing fence has not arrived. */
  closed: boolean;
}

/**
 * A pipe table, as agents actually write them.
 *
 * Only the GitHub form: a header row, a delimiter row that says how many
 * columns there are and how each is aligned, and body rows. Every cell's
 * content is inline markdown, so bold and code inside a cell work the way they
 * do everywhere else.
 *
 * Rows are ragged in the wild — a row with too few cells is padded and a row
 * with too many is cut, because the alternative is a table that refuses to
 * draw at all over one missing pipe. The delimiter row is the authority on
 * column count, exactly as it is in the spec.
 */
export interface MdTable {
  kind: 'table';
  head: MdSpan[][];
  rows: MdSpan[][][];
  align: ('left' | 'center' | 'right' | null)[];
}

export type MdBlock = MdParagraph | MdHeading | MdList | MdFence | MdTable;

/**
 * True when the parse changed nothing at all: the common case, and the one
 * that has to be identical to what the transcript did before. The renderer
 * uses it to take the old code path outright rather than to reassemble
 * something equivalent.
 *
 * Comparing against the source is the whole test, and checking the shape alone
 * is not enough. A message can parse to one paragraph of nothing but text
 * spans and still have had something taken out of it: a link with a script
 * destination is dropped and its label survives as plain text, so by shape it
 * looks untouched, and reprinting the original characters would put the
 * brackets and the dead destination back on screen.
 */
export function isPlainProse(blocks: MdBlock[], source: string): boolean {
  if (blocks.length !== 1) return false;
  const only = blocks[0];
  if (only.kind !== 'paragraph') return false;
  let seen = '';
  for (const span of only.spans) {
    if (span.kind !== 'text') return false;
    seen += span.text;
  }
  return seen === source;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})([.)])[ \t]+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

/** Tabs count as four, the width they are shown at. Used only to compare depth. */
function indentWidth(raw: string): number {
  let width = 0;
  for (const ch of raw) width += ch === '\t' ? 4 : 1;
  return width;
}

interface FenceOpen {
  marker: string;
  lang: string;
}

function fenceOpen(line: string): FenceOpen | null {
  const match = FENCE.exec(line);
  if (!match) return null;
  const [, marker, info] = match;
  // A backtick fence's info string may not contain a backtick, or every
  // sentence that quotes ``` alongside other code would open a block.
  if (marker.startsWith('`') && info.includes('`')) return null;
  const lang = /^[\w+#.-]*/.exec(info.trim())?.[0] ?? '';
  return { marker, lang: lang.toLowerCase() };
}

function fenceCloses(line: string, marker: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < marker.length) return false;
  const ch = marker[0];
  for (const c of trimmed) if (c !== ch) return false;
  return true;
}

function listMarker(line: string): { indent: number; ordered: boolean; start: number; body: string } | null {
  const bullet = BULLET.exec(line);
  if (bullet) return { indent: indentWidth(bullet[1]), ordered: false, start: 1, body: bullet[3] };
  const ordered = ORDERED.exec(line);
  if (ordered) {
    return { indent: indentWidth(ordered[1]), ordered: true, start: Number(ordered[2]), body: ordered[4] };
  }
  return null;
}

/**
 * Blocks, in order.
 *
 * `live` says the last line may be half-typed, which is the only place a
 * partial marker can be sitting. Pass it false for a finished message so a
 * message that genuinely ends on ```` ``` ```` still opens its block.
 */
/**
 * Split one table row into raw cells.
 *
 * The outer pipes are optional in the spec and universal in practice, so a
 * leading or trailing empty cell created by one is dropped. `\|` is an escaped
 * pipe and belongs to the cell.
 */
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '\\' && line[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  if (cells.length > 1 && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

/** True when `line` has a pipe in it that is not spoken for by a backslash. */
function hasUnescapedPipe(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '\\') {
      index += 1;
      continue;
    }
    if (line[index] === '|') return true;
  }
  return false;
}

/**
 * The `|---|:--:|` line, and what it says about each column's alignment.
 *
 * The delimiter row is what makes a table a table, and it has to carry a pipe
 * of its own — the GFM rule, and here a load-bearing one. Without it a bare
 * `---` reads as a valid one-column alignment row, so any sentence above it
 * that happens to mention a `|` turns into a one-column table with the
 * sentence as its heading, and the rule underneath is eaten.
 */
function tableAlignment(line: string): ('left' | 'center' | 'right' | null)[] | null {
  if (!hasUnescapedPipe(line)) return null;
  const cells = tableCells(line);
  if (cells.length === 0) return null;
  const align: ('left' | 'center' | 'right' | null)[] = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
}

/**
 * A table starts where a header line is followed by a delimiter line.
 *
 * Both lines are required before anything is drawn — the file's rule that a
 * half-written marker is not a marker. A header row alone is a paragraph of
 * pipes, which is exactly what it looks like, and it becomes a table the moment
 * the line under it arrives.
 */
function tableAt(lines: string[], from: number, partialTail: number): number | null {
  if (from + 1 >= lines.length || from + 1 === partialTail) return null;
  if (!lines[from].includes('|')) return null;
  const align = tableAlignment(lines[from + 1]);
  if (!align || align.length === 0) return null;
  return align.length;
}

function readTable(lines: string[], from: number, partialTail: number): [MdTable, number] {
  const align = tableAlignment(lines[from + 1]) ?? [];
  const width = align.length;
  const cellsOf = (line: string): MdSpan[][] => {
    const raw = tableCells(line).slice(0, width);
    while (raw.length < width) raw.push('');
    return raw.map((cell) => parseInline(cell));
  };
  const head = cellsOf(lines[from]);
  const rows: MdSpan[][][] = [];
  let i = from + 2;
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|') && i !== partialTail) {
    rows.push(cellsOf(lines[i]));
    i += 1;
  }
  return [{ kind: 'table', head, rows, align }, i];
}

export function parseMarkdown(source: string, live = false): MdBlock[] {
  const lines = source.split('\n');
  // Only the final line can be mid-keystroke, and only when no newline has
  // landed after it yet.
  const partialTail = live && !source.endsWith('\n') ? lines.length - 1 : -1;
  const blocks: MdBlock[] = [];
  let i = 0;

  const startsBlock = (index: number): boolean =>
    (index !== partialTail && fenceOpen(lines[index]) !== null) ||
    HEADING.test(lines[index]) ||
    listMarker(lines[index]) !== null ||
    tableAt(lines, index, partialTail) !== null;

  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i += 1;
      continue;
    }

    const fence = i === partialTail ? null : fenceOpen(lines[i]);
    if (fence) {
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (fenceCloses(lines[j], fence.marker)) {
          closed = true;
          j += 1;
          break;
        }
        body.push(lines[j]);
        j += 1;
      }
      blocks.push({ kind: 'fence', lang: fence.lang, text: body.join('\n'), closed });
      i = j;
      continue;
    }

    const heading = HEADING.exec(lines[i]);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, spans: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (tableAt(lines, i, partialTail) !== null) {
      const [table, next] = readTable(lines, i, partialTail);
      blocks.push(table);
      i = next;
      continue;
    }

    if (listMarker(lines[i]) !== null) {
      const [list, next] = readList(lines, i, indentWidth(/^[ \t]*/.exec(lines[i])?.[0] ?? ''));
      blocks.push(list);
      i = next;
      continue;
    }

    // A paragraph runs to the first blank line or the first line that opens
    // something else. Its newlines survive: that is what keeps plain prose
    // looking the way it always has.
    const start = i;
    i += 1;
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(i)) i += 1;
    blocks.push({ kind: 'paragraph', spans: parseInline(lines.slice(start, i).join('\n')) });
  }

  return blocks;
}

/**
 * One list, and any lists nested inside it.
 *
 * A blank line stays inside the list when the next indented line or same-kind
 * marker continues it. De-indented prose after the gap starts a new block.
 */
function readList(lines: string[], from: number, baseIndent: number): [MdList, number] {
  const first = listMarker(lines[from]);
  const list: MdList = {
    kind: 'list',
    ordered: first?.ordered ?? false,
    start: first?.start ?? 1,
    items: [],
  };
  let i = from;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === '') next += 1;
      if (next >= lines.length) break;

      const nextMarker = listMarker(lines[next]);
      const nextIndent = indentWidth(/^[ \t]*/.exec(lines[next])?.[0] ?? '');
      const continues = nextMarker
        ? nextMarker.indent >= baseIndent + 2 ||
          (nextMarker.indent >= baseIndent && nextMarker.ordered === list.ordered)
        : nextIndent >= baseIndent + 2;
      if (!continues) break;
      i = next;
      continue;
    }

    const marker = listMarker(line);
    if (marker && marker.indent >= baseIndent + 2 && list.items.length > 0) {
      const [child, next] = readList(lines, i, marker.indent);
      list.items[list.items.length - 1].children = child;
      i = next;
      continue;
    }

    if (marker && marker.indent >= baseIndent) {
      // A second list of the other flavour at the same depth is its own list.
      if (list.items.length > 0 && marker.ordered !== list.ordered) break;
      list.items.push({ spans: parseInline(marker.body), children: null });
      i += 1;
      continue;
    }

    if (marker) break;

    // An indented or lazy continuation line is the rest of the current item.
    const indent = indentWidth(/^[ \t]*/.exec(line)?.[0] ?? '');
    if (
      list.items.length > 0 &&
      (indent >= baseIndent + 2 || (HEADING.exec(line) === null && fenceOpen(line) === null))
    ) {
      const item = list.items[list.items.length - 1];
      item.spans = [...item.spans, { kind: 'text', text: ' ' }, ...parseInline(line.trim())];
      i += 1;
      continue;
    }

    break;
  }

  return [list, i];
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!>~|]/;

/** How many of `ch` sit in a row starting at `at`. */
function runLength(source: string, at: number, ch: string): number {
  let n = 0;
  while (at + n < source.length && source[at + n] === ch) n += 1;
  return n;
}

/** The next run of EXACTLY `n` backticks at or after `from`, or -1. */
function findBacktickRun(source: string, from: number, n: number): number {
  let i = from;
  while (i < source.length) {
    if (source[i] !== '`') {
      i += 1;
      continue;
    }
    const run = runLength(source, i, '`');
    if (run === n) return i;
    i += run;
  }
  return -1;
}

/** CommonMark strips one space from each end when both are there. */
function trimCodeSpan(text: string): string {
  if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') {
    return text.slice(1, -1);
  }
  return text;
}

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/**
 * Spans within one block's text.
 *
 * Every construct needs its closer before it counts, which is what makes this
 * safe to run against a message that is still arriving, and also what makes
 * `snake_case_names` and a lone `*` survive as themselves.
 */
export function parseInline(source: string, allowLink = true): MdSpan[] {
  const spans: MdSpan[] = [];
  let plain = '';

  const flush = (): void => {
    if (plain === '') return;
    spans.push(...autoSpans(plain));
    plain = '';
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\' && i + 1 < source.length && ESCAPABLE.test(source[i + 1])) {
      plain += source[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const run = runLength(source, i, '`');
      const close = findBacktickRun(source, i + run, run);
      if (close !== -1) {
        flush();
        spans.push({ kind: 'code', text: trimCodeSpan(source.slice(i + run, close)) });
        i = close + run;
        continue;
      }
      plain += source.slice(i, i + run);
      i += run;
      continue;
    }

    if (ch === '[' && allowLink) {
      const link = readLink(source, i);
      if (link) {
        flush();
        spans.push(...link.spans);
        i = link.next;
        continue;
      }
    }

    if (ch === '*' || ch === '_') {
      const emphasis = readEmphasis(source, i, allowLink);
      if (emphasis) {
        flush();
        spans.push(emphasis.span);
        i = emphasis.next;
        continue;
      }
    }

    plain += ch;
    i += 1;
  }

  flush();
  return spans;
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

/**
 * `[label](destination)`.
 *
 * A destination that is not http, https, mailto or an absolute path is dropped
 * and the label is kept as ordinary text. That is the sanitiser: a
 * `javascript:` destination cannot reach an element as an href because it never
 * becomes a link in the first place.
 */
function readLink(source: string, at: number): { spans: MdSpan[]; next: number } | null {
  let depth = 0;
  let close = -1;
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || source[close + 1] !== '(') return null;

  let paren = 0;
  let end = -1;
  for (let i = close + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')') {
      paren -= 1;
      if (paren === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const label = source.slice(at + 1, close);
  const inner = source.slice(close + 2, end).trim();
  // A title after the destination is not shown anywhere, so it is only parsed
  // far enough to keep it out of the destination.
  const dest = (inner.startsWith('<') ? /^<([^>]*)>/.exec(inner)?.[1] ?? '' : inner.split(/[ \t]/)[0]).trim();
  const next = end + 1;
  const spans = parseInline(label, false);

  if (SAFE_HREF.test(dest)) return { spans: [{ kind: 'link', href: dest, spans }], next };

  const path = absolutePath(dest);
  if (path) return { spans: [{ kind: 'path', target: path.target, text: label || path.text }], next };

  return { spans, next };
}

function readEmphasis(source: string, at: number, allowLink: boolean): { span: MdSpan; next: number } | null {
  const ch = source[at];
  const double = source[at + 1] === ch;
  const delim = double ? ch + ch : ch;

  // An underscore inside a word is part of the word. Without this every
  // snake_case identifier in a sentence turns half of it italic.
  if (ch === '_' && isAlnum(source[at - 1])) return null;

  const from = at + delim.length;
  if (from >= source.length || /\s/.test(source[from])) return null;

  let i = from;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source.startsWith(delim, i) && !/\s/.test(source[i - 1])) {
      if (ch === '_' && isAlnum(source[i + delim.length])) {
        i += 1;
        continue;
      }
      const content = source.slice(from, i);
      if (content === '') return null;
      return {
        span: { kind: double ? 'strong' : 'em', spans: parseInline(content, allowLink) },
        next: i + delim.length,
      };
    }
    i += 1;
  }
  return null;
}

/**
 * A bare URL, or an absolute path with no link syntax around it.
 *
 * Paths are the reason this exists. An agent that has just edited a file names
 * it in the sentence, and that name is the most clickable thing in the message.
 */
const AUTO_LINK = new RegExp(
  [
    // http and https, stopping before the brackets and quotes that usually
    // wrap a URL rather than belong to it.
    '(https?:\\/\\/[^\\s<>()\\[\\]{}"\'`]+)',
    // Drive-letter paths.
    '([A-Za-z]:[\\\\/](?:[^\\s\\\\/:*?"<>|]+[\\\\/])*[^\\s\\\\/:*?"<>|]+(?::\\d+(?::\\d+)?)?)',
    // Posix paths, two segments at least: one segment is far more often a
    // fraction or a word pair than a path worth pointing at.
    '(\\/(?:[A-Za-z0-9._@%+~-]+\\/)+[A-Za-z0-9._@%+~-]+(?::\\d+(?::\\d+)?)?)',
  ].join('|'),
  'g',
);

const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

/** Splits a `:12` or `:12:3` suffix off a path, keeping it in the shown text. */
function splitLineSuffix(value: string): { target: string; text: string } {
  const match = /^(.*?)(:\d+(?::\d+)?)$/.exec(value);
  return match ? { target: match[1], text: value } : { target: value, text: value };
}

function absolutePath(value: string): { target: string; text: string } | null {
  const trimmed = value.trim();
  AUTO_LINK.lastIndex = 0;
  const match = AUTO_LINK.exec(trimmed);
  if (!match || match.index !== 0 || match[0] !== trimmed || match[1] !== undefined) return null;
  return splitLineSuffix(trimmed);
}

/**
 * Text that carries no markdown, with bare URLs and paths lifted out of it.
 */
function autoSpans(source: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let last = 0;
  AUTO_LINK.lastIndex = 0;

  for (let match = AUTO_LINK.exec(source); match !== null; match = AUTO_LINK.exec(source)) {
    const [whole, url] = match;
    const before = source[match.index - 1];

    // A path has to start where a path can start. Without this the tail of
    // `docs/a/b` reads as the absolute path `/a/b`.
    if (url === undefined && before !== undefined && /[A-Za-z0-9_\\/:.~-]/.test(before)) continue;

    // Sentence punctuation that happens to follow is not part of it.
    const trimmed = whole.replace(TRAILING_PUNCT, '');
    if (trimmed === '') continue;

    if (match.index > last) spans.push({ kind: 'text', text: source.slice(last, match.index) });

    if (url !== undefined) {
      spans.push({ kind: 'link', href: trimmed, spans: [{ kind: 'text', text: trimmed }] });
    } else {
      const { target, text } = splitLineSuffix(trimmed);
      spans.push({ kind: 'path', target, text });
    }

    last = match.index + trimmed.length;
    AUTO_LINK.lastIndex = last;
  }

  if (last < source.length) spans.push({ kind: 'text', text: source.slice(last) });
  return spans;
}
