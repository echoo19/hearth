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
import type { TesterNote } from './types.js';

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
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof (parsed as TesterNote).session === 'number') {
        notes.push(parsed as TesterNote);
      }
    } catch {
      /* unreadable or absent: this session simply has no note to show */
    }
  }
  return notes.sort((a, b) => a.session - b.session);
}
