/**
 * The project's background reading: files the user drops in so the agent knows
 * what it is working on.
 *
 * A design doc, a spreadsheet of weapon stats, the sketch of a level — the
 * things a new collaborator would be handed on their first day. They live in
 * `.hearth/context/` inside the project rather than anywhere per-machine,
 * because context belongs to the game and not to the laptop: clone the repo and
 * the agent still knows what a "shrine" is. That also means this folder is
 * meant to be committed. Nothing here is a secret store, nothing is chmodded,
 * and nothing should be written here that the user would not put in git.
 *
 * The folder is flat and plain on purpose. A user can open it in Finder, drop a
 * PDF in by hand, and the app will list it on the next read — no index file to
 * keep in step, nothing to migrate. What this module owns is the other
 * direction: anything a CLIENT names is untrusted, so names are flattened to a
 * single safe segment (reusing chatAttachments' sanitiser rather than growing a
 * second one that could drift), sizes are capped before a payload is decoded,
 * and every path is re-checked against the folder before it is touched.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { base64Bytes, safeAttachmentName } from './chatAttachments.js';

/** Where a project's context files live, relative to the project root. */
export const CONTEXT_DIR = path.join('.hearth', 'context');

/**
 * Most files listed back. The pane draws a card per file; a folder someone has
 * pointed at a photo library should degrade to "the newest 200" rather than
 * hanging the UI, and the newest is the part anyone cares about.
 */
export const MAX_CONTEXT_FILES = 200;

/** Files accepted in one request. A drop zone, not a bulk importer. */
export const MAX_UPLOAD_FILES = 24;

/** Per-file ceiling, on the DECODED bytes. */
export const MAX_CONTEXT_FILE_BYTES = 12 * 1024 * 1024;

/**
 * Ceiling on ONE request's files, decoded and added up. Independent of the
 * per-file cap: two dozen files at the per-file limit is ~380 MB of base64 in a
 * single JSON body, which the body reader would refuse anyway — better to stop
 * counting them here, where the response can still be the file list.
 */
export const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;

/**
 * Above this, a file's lines are not counted. Counting means reading the whole
 * body, and a listing that has to slurp a 400 MB log to put a number on a card
 * is a listing that blocks the pane — the card says nothing instead.
 */
export const MAX_LINE_COUNT_BYTES = 2 * 1024 * 1024;

/** Longest preview handed back for reading. Enough for a doc, not for a dump. */
export const MAX_PREVIEW_BYTES = 512 * 1024;

/** One context file, as a card in the pane. */
export interface ContextFile {
  name: string;
  bytes: number;
  /**
   * Line count for text, and null for everything else. Null is a real answer
   * and not a failure: the pane prints "51 lines" when it has a number, and
   * must never claim a line count for a PNG.
   */
  lines: number | null;
  /** Lowercased, no leading dot. Empty when the name has no extension. */
  ext: string;
  modifiedAt: string;
}

/** One file as it arrives from the client, base64 like a chat attachment. */
export interface ContextFileInput {
  name: string;
  /** base64, without a data: prefix. */
  data: string;
}

/** The folder itself, for callers that want to show the user where this is. */
export function contextDir(projectRoot: string): string {
  return path.join(projectRoot, CONTEXT_DIR);
}

/**
 * Turn a client-supplied name into an absolute path inside the context folder,
 * or null if it cannot be made into one.
 *
 * The sanitiser already reduces `../../etc/passwd`, `C:\Users\me\x`, and a
 * leading-dot name to one harmless segment, so the resolve below should be a
 * formality. It is done anyway, and as a real containment check rather than a
 * prefix test on the raw string, because this is the only thing standing
 * between a hostile name and the user's disk — if a future sanitiser change
 * ever lets a separator through, the write still has to fail here.
 */
function resolveInside(projectRoot: string, rawName: unknown): { dir: string; abs: string; name: string } | null {
  const dir = path.resolve(contextDir(projectRoot));
  const name = safeAttachmentName(rawName);
  const abs = path.resolve(dir, name);
  if (abs === dir || !abs.startsWith(dir + path.sep)) return null;
  // A sanitised name is one segment; anything that resolved deeper got there
  // through a separator we did not expect, and is refused rather than repaired.
  if (path.dirname(abs) !== dir) return null;
  return { dir, abs, name };
}

/** The extension a card badges the file with. */
function extensionOf(name: string): string {
  const ext = path.extname(name);
  return ext.startsWith('.') ? ext.slice(1).toLowerCase() : ext.toLowerCase();
}

/**
 * Lines in a file, or null when it isn't text.
 *
 * "Is it text" is answered from the bytes rather than from the extension,
 * because the extension is the client's word and a `.md` full of NULs is not a
 * document. A NUL byte anywhere in the sample is the classic signal, and a
 * body that does not survive a UTF-8 round trip is the backstop for encodings
 * we cannot count lines in honestly.
 */
export function countLines(bytes: Buffer): number | null {
  if (bytes.length === 0) return 0;
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return null;
  const text = sample.toString('utf8');
  if (text.includes('\ufffd')) return null;
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  // A file whose last line has no trailing newline still shows that line.
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

/** Line count for one stored file, skipping bodies too big to be worth reading. */
async function linesFor(abs: string, size: number): Promise<number | null> {
  if (size > MAX_LINE_COUNT_BYTES) return null;
  try {
    return countLines(await fsp.readFile(abs));
  } catch {
    return null;
  }
}

/**
 * Everything in the context folder, newest first.
 *
 * A project that has never been given context has no folder, and that reads as
 * an empty list rather than an error — "nothing yet" is the normal state, and
 * the pane's empty state is the answer. Subdirectories and dotfiles are skipped
 * because this is a flat drop zone: a folder someone dragged in is not a card,
 * and `.DS_Store` is not context.
 */
export async function listContextFiles(projectRoot: string): Promise<ContextFile[]> {
  const dir = path.resolve(contextDir(projectRoot));
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stated = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || entry.name.startsWith('.')) return null;
      try {
        const stat = await fsp.stat(path.join(dir, entry.name));
        return { name: entry.name, bytes: stat.size, modified: stat.mtimeMs };
      } catch {
        // Disappeared between the listing and the stat; not an error worth
        // failing the whole pane over.
        return null;
      }
    }),
  );
  const newest = stated
    .filter((row): row is { name: string; bytes: number; modified: number } => row !== null)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, MAX_CONTEXT_FILES);
  // Bodies are read only for the rows that survived the cap, so a folder with
  // thousands of files costs thousands of stats and 200 reads, not 200 MB.
  return Promise.all(
    newest.map(async (row) => ({
      name: row.name,
      bytes: row.bytes,
      lines: await linesFor(path.join(dir, row.name), row.bytes),
      ext: extensionOf(row.name),
      modifiedAt: new Date(row.modified).toISOString(),
    })),
  );
}

/**
 * Coerce whatever arrived on the wire into files worth writing. A row that is
 * the wrong shape, empty, or over the per-file cap is dropped on its own — one
 * bad file must not lose the rest of a drop.
 */
export function parseContextInputs(raw: unknown): ContextFileInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextFileInput[] = [];
  let total = 0;
  for (const row of raw) {
    if (out.length >= MAX_UPLOAD_FILES) break;
    if (!row || typeof row !== 'object') continue;
    const { name, data } = row as Record<string, unknown>;
    if (typeof data !== 'string' || data === '') continue;
    // Measured, not decoded: an oversized payload must never become a Buffer.
    const bytes = base64Bytes(data);
    if (bytes === 0 || bytes > MAX_CONTEXT_FILE_BYTES) continue;
    if (total + bytes > MAX_UPLOAD_BYTES) break;
    total += bytes;
    out.push({ name: safeAttachmentName(name), data });
  }
  return out;
}

/**
 * A name nothing else in the folder is using, by numbering the collisions:
 * `notes.md`, `notes-2.md`, `notes-3.md`. Dropping two files called
 * `notes.md` has to leave two files — the second one silently replacing the
 * first would lose work the user believes they just added.
 */
async function freeName(dir: string, taken: Set<string>, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = ext === '' ? name : name.slice(0, -ext.length);
  for (let n = 1; n <= MAX_CONTEXT_FILES; n += 1) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    if (taken.has(candidate)) continue;
    try {
      await fsp.stat(path.join(dir, candidate));
    } catch {
      taken.add(candidate);
      return candidate;
    }
  }
  // Every number up to the folder cap is spoken for; fall back to something
  // unique rather than overwriting a file that is already there.
  const candidate = `${stem}-${Date.now().toString(36)}${ext}`;
  taken.add(candidate);
  return candidate;
}

/**
 * Write dropped files into the context folder and describe what landed.
 *
 * Inputs are re-parsed here rather than trusted from the caller, so the route
 * layer cannot forget: this function is the boundary. A file that fails to
 * write is skipped instead of failing the request, because the user's next
 * action is to look at the list, and a list is a better answer than an error.
 */
export async function saveContextFiles(
  projectRoot: string,
  inputs: unknown,
): Promise<ContextFile[]> {
  const parsed = parseContextInputs(inputs);
  if (parsed.length === 0) return [];
  const dir = path.resolve(contextDir(projectRoot));
  await fsp.mkdir(dir, { recursive: true });
  const taken = new Set<string>();
  const saved: ContextFile[] = [];
  for (const input of parsed) {
    const target = resolveInside(projectRoot, input.name);
    if (!target) continue;
    try {
      const bytes = Buffer.from(input.data, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_CONTEXT_FILE_BYTES) continue;
      const name = await freeName(dir, taken, target.name);
      const placed = resolveInside(projectRoot, name);
      if (!placed) continue;
      await fsp.writeFile(placed.abs, bytes);
      const stat = await fsp.stat(placed.abs);
      saved.push({
        name,
        bytes: bytes.length,
        lines: bytes.length > MAX_LINE_COUNT_BYTES ? null : countLines(bytes),
        ext: extensionOf(name),
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
      });
    } catch {
      /* one unwritable file must not cost the rest of the drop */
    }
  }
  return saved;
}

/**
 * Remove one file. Answers false for a file that was not there, which is why
 * it stats first: `rm --force` succeeds on a missing path, and reporting a
 * deletion that never happened would let the pane show a card as removed while
 * something else entirely is still on disk.
 */
export async function deleteContextFile(projectRoot: string, name: unknown): Promise<boolean> {
  const target = resolveInside(projectRoot, name);
  if (!target) return false;
  try {
    const stat = await fsp.stat(target.abs);
    if (!stat.isFile()) return false;
    await fsp.rm(target.abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The text of one file, for the preview sheet, or null when there is nothing
 * worth showing — missing, a directory, binary, or long enough that shipping
 * it would be a download rather than a preview. Null is the pane's cue to say
 * "no preview", so it is never worth throwing here.
 */
export async function readContextFile(projectRoot: string, name: unknown): Promise<string | null> {
  const target = resolveInside(projectRoot, name);
  if (!target) return null;
  try {
    const stat = await fsp.stat(target.abs);
    if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) return null;
    const bytes = await fsp.readFile(target.abs);
    return countLines(bytes) === null ? null : bytes.toString('utf8');
  } catch {
    return null;
  }
}
