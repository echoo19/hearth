/**
 * Where the tester keeps what it knows, and what it thought each time it played.
 *
 * Plain files in the project folder, like everything else Hearth writes: copy
 * the folder and the tester comes with it. `memory.md` is markdown on purpose.
 * It is meant to be read by a person and corrected by hand, because a memory you
 * cannot inspect is one you cannot trust, and a tester you cannot correct is one
 * you stop listening to.
 *
 * Sessions are append-only. The verdict history is the product: a tester that
 * could revise what it used to think could never be caught contradicting itself,
 * and being caught is the point.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { unreadableNote, type TesterNote } from './types.js';

/** Relative location of the tester's folder within a project. */
export const TESTER_DIR = path.join('.hearth', 'tester');

/** Absolute path of the tester's folder for `root`. */
export function testerDir(root: string): string {
  return path.join(root, TESTER_DIR);
}

/** Absolute path of the durable memory file. */
export function memoryPath(root: string): string {
  return path.join(testerDir(root), 'memory.md');
}

/** Zero-padded so the sessions directory sorts the way it reads. */
export function sessionDir(root: string, id: number): string {
  return path.join(testerDir(root), 'sessions', String(id).padStart(4, '0'));
}

/** Where a session's frames land. Every claim in a note points at one of these. */
export function framesDir(root: string, id: number): string {
  return path.join(sessionDir(root, id), 'frames');
}

/**
 * What the tester knows about this game, or an empty string when it has never
 * played. Absent and empty mean the same thing to every caller, so they are not
 * distinguished here.
 */
export async function readMemory(root: string): Promise<string> {
  try {
    return await fsp.readFile(memoryPath(root), 'utf8');
  } catch {
    return '';
  }
}

/** Replace the durable memory. The tester rewrites the whole file each session. */
export async function writeMemory(root: string, text: string): Promise<void> {
  await fsp.mkdir(testerDir(root), { recursive: true });
  await fsp.writeFile(memoryPath(root), text, 'utf8');
}

/**
 * The id the next session should claim: one past the highest that has ever
 * existed. Counted from the directories rather than the notes, so a session that
 * crashed before writing one does not have its number handed out twice.
 */
export async function nextSessionId(root: string): Promise<number> {
  const dir = path.join(testerDir(root), 'sessions');
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 1;
  }
  let highest = 0;
  for (const entry of entries) {
    const id = Number.parseInt(entry, 10);
    if (Number.isFinite(id) && id > highest) highest = id;
  }
  return highest + 1;
}

/**
 * Claim a session's folder before it starts, so its frames have somewhere to
 * land while it plays. Separate from `writeNote` because the note is written
 * last and the frames it cites are written throughout.
 */
export async function createSessionDir(root: string, id: number): Promise<string> {
  const dir = sessionDir(root, id);
  await fsp.mkdir(path.join(dir, 'frames'), { recursive: true });
  return dir;
}

/**
 * Write a session's note, once. The `wx` flag is what makes append-only real:
 * a stat-then-write would leave a window where two sessions could both decide
 * the file was absent. The note is the sentinel rather than the folder, because
 * the folder is already there by the time a session has anything to say.
 */
export async function writeNote(root: string, note: TesterNote): Promise<void> {
  const dir = sessionDir(root, note.session);
  await fsp.mkdir(dir, { recursive: true });
  try {
    await fsp.writeFile(path.join(dir, 'note.json'), `${JSON.stringify(note, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') {
      throw new Error(`Session ${note.session} already has a note. Sessions are never rewritten.`);
    }
    throw err;
  }
}

/** The human-readable half of a session: what it thought, in order. */
export async function writeTranscript(root: string, id: number, text: string): Promise<void> {
  const dir = sessionDir(root, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'transcript.md'), text, 'utf8');
}

const VERDICTS = new Set(['better', 'worse', 'no-difference', 'first-session', 'unreadable', 'unclear']);
const ENDINGS = new Set(['done', 'budget', 'user', 'error', 'unreadable']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Does this note carry every field its readers dereference?
 *
 * Named field by field rather than cast, because a cast is what shipped and a
 * cast is what blanked the window. `typeof session === 'number'` was the whole
 * check, so a note from an older or newer Hearth, or one a person had edited by
 * hand, arrived at the history missing `onTheChange` and `regression`. The
 * history reads `note.onTheChange.verdict` and calls a regression helper on
 * `note.regression`, both of which throw on undefined, and a throw during
 * render with no boundary above it takes the ENTIRE app to a white screen that
 * comes back white on reload until the file is deleted. The folder is
 * documented as hand-editable and meant to be committed, so this is a file
 * someone will absolutely produce.
 *
 * Anything optional is checked only if present: `placement`, `proposals` and
 * `frames` are all absent on notes written by earlier Hearths and those notes
 * are perfectly readable.
 */
function isWholeNote(value: Record<string, unknown>): boolean {
  const change = value.onTheChange;
  if (!isRecord(change)) return false;
  if (typeof change.seen !== 'string' || typeof change.why !== 'string') return false;
  if (typeof change.verdict !== 'string' || !VERDICTS.has(change.verdict)) return false;
  if (typeof value.regression !== 'string') return false;
  if (typeof value.startedAt !== 'string' || typeof value.finishedAt !== 'string') return false;
  if (typeof value.steps !== 'number') return false;
  if (typeof value.stopped !== 'string' || !ENDINGS.has(value.stopped)) return false;
  // Element by element, not just Array.isArray. The array check was the whole
  // guard and it does not hold for the shape a hand-edit actually produces:
  // `observations: [{ frame: 3 }]` has no `text`, and the report renders
  // `observation.text` straight into a node; `openQuestions: [42]` is rendered
  // as a key and a child. Both throw during render, and a throw during render
  // is the white screen this guard exists to prevent.
  if (!Array.isArray(value.observations) || !value.observations.every(isWholeObservation)) return false;
  if (!Array.isArray(value.openQuestions) || !value.openQuestions.every((q) => typeof q === 'string')) {
    return false;
  }
  if (value.proposals !== undefined) {
    if (!Array.isArray(value.proposals) || !value.proposals.every(isWholeProposal)) return false;
  }
  if (value.placedFrom !== undefined && typeof value.placedFrom !== 'number') return false;
  if (value.frames !== undefined && typeof value.frames !== 'number') return false;
  return true;
}

/** One observation the report can render without reaching for a field it lacks. */
function isWholeObservation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.frame !== 'number' || typeof value.text !== 'string') return false;
  // Absent is the answer on notes written before the tester could be placed
  // anywhere, and `observationReach` reads absence as 'played'. A value that is
  // neither is a value nothing here knows how to read.
  return value.reached === undefined || value.reached === 'played' || value.reached === 'placed';
}

/** One proposal the plan of action can read without throwing on the way. */
function isWholeProposal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind !== 'bug' && value.kind !== 'suggestion') return false;
  if (typeof value.text !== 'string') return false;
  if (value.evidence === undefined) return true;
  return Array.isArray(value.evidence) && value.evidence.every((frame) => typeof frame === 'number');
}

/**
 * One note off disk, as something every reader can render.
 *
 * A note that parses as JSON and names a session but is not whole comes back as
 * the unreadable note for that session: the session stays in the history and
 * says plainly that it could not be read. That is the honest outcome for an
 * append-only record, where a session quietly disappearing is its own lie. Only
 * a file with no session number at all is dropped, because without one there is
 * nothing to call it.
 */
export function readNote(parsed: unknown): TesterNote | null {
  if (!isRecord(parsed)) return null;
  const session = parsed.session;
  if (typeof session !== 'number' || !Number.isFinite(session)) return null;
  if (isWholeNote(parsed)) return parsed as unknown as TesterNote;
  return unreadableNote(
    session,
    typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    typeof parsed.finishedAt === 'string' ? parsed.finishedAt : '',
  );
}

/**
 * Every session this project has, oldest first, so the history reads as a
 * history. A note that will not parse is dropped rather than thrown: these files
 * are hand-editable, so one broken file must not take the whole record with it.
 */
export async function listSessions(root: string): Promise<TesterNote[]> {
  const dir = path.join(testerDir(root), 'sessions');
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const notes: TesterNote[] = [];
  for (const entry of entries.sort()) {
    try {
      const raw = await fsp.readFile(path.join(dir, entry, 'note.json'), 'utf8');
      const note = readNote(JSON.parse(raw));
      if (note) notes.push(note);
    } catch {
      /* unreadable or absent: this session simply has no note to show */
    }
  }
  return notes.sort((a, b) => a.session - b.session);
}
