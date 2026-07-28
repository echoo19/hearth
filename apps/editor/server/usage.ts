/**
 * What this machine has actually done with Hearth.
 *
 * There is no account behind Hearth, no quota and no meter — so there is no
 * "tokens used" to report, and inventing one would be a lie told in a settings
 * pane. What DOES exist is files: a recents list in `~/.hearth`, a chat index
 * per project, a sweep directory per playtest, a command journal per project,
 * and a skills folder. This module counts those, and nothing else.
 *
 * Two rules shape everything below.
 *
 * Never throws. This runs when a dialog opens, over folders the user may have
 * deleted, renamed or half-written. Every read is wrapped and every failure
 * degrades to "that one contributed nothing" — a project that has been moved to
 * the trash must not take the other eleven's numbers with it. See
 * `readRecentsState` in projectServer.ts for why this codebase is careful here:
 * one swallowed error there once replaced the user's project list with a list
 * of one.
 *
 * Bounded IO. Nothing walks a transcript, a shots directory or a whole journal.
 * Per project this is: one read of `.hearth/chats/index.json`, one readdir of
 * `.hearth/evidence/sweeps`, and a tail read of the last 64KB of
 * `.hearth/log/commands.jsonl` — the journal assigns a monotonic `seq`, so its
 * last line already knows how many entries have ever been recorded, rotations
 * included. Numbers that would have cost more than that (how many messages are
 * in a conversation, how many screenshots a sweep saved) are deliberately not
 * offered rather than offered approximately.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JOURNAL_FILE } from '@hearth/core';
import { chatIndexPath, parseChatIndex } from './chatStore.js';
import { EVIDENCE_DIR } from './evidenceWatcher.js';
import { listSkills } from './skills.js';

/**
 * Where a project's playtest sweeps land — one numbered directory per sweep,
 * created by `NodeEvidenceStore.beginSweep` (packages/probe-core/src/
 * evidenceStore.ts). Counting the directories is one readdir and is exact.
 */
export const SWEEPS_DIR = path.join(EVIDENCE_DIR, 'sweeps');

/**
 * How much of the tail of a command journal is read to find its last `seq`.
 * Generous enough that a single fat entry still leaves a line boundary in the
 * window; small enough that a rotated 4,000-line journal costs one short read.
 */
export const JOURNAL_TAIL_BYTES = 64 * 1024;

/**
 * Ceiling on how many recent folders are counted. The recents list is capped at
 * twelve where it is written, so this only ever bites on a file some other tool
 * grew — and a settings dialog must not turn into a thousand-folder scan.
 */
export const MAX_PROJECTS_SCANNED = 64;

/** One folder this machine has opened, and what is in it. */
export interface UsageProject {
  /** Absolute path, as the recents list recorded it. */
  path: string;
  /** The folder's name, as the app shows it elsewhere. */
  name: string;
  /** The same path with the home directory written as `~`, for reading. */
  display: string;
  /** False when the folder is not on disk any more. Its counts are then zero. */
  exists: boolean;
  /** Conversations in `.hearth/chats/index.json`. */
  chats: number;
  /** Playtest sweeps recorded under `.hearth/evidence/sweeps`. */
  playtests: number;
  /** Entries in the project's command journal, from its last `seq`. */
  changes: number;
  /** ISO. When this folder was last opened, from the recents list. */
  openedAt: string | null;
  /** ISO. The earliest conversation start in this folder. */
  firstChatAt: string | null;
  /** ISO. The most recent conversation activity in this folder. */
  lastChatAt: string | null;
  /** ISO. The most recent of everything above — what the list sorts on. */
  lastActivityAt: string | null;
}

/** Skills as the Skills screen counts them: everything found, and how many are on. */
export interface UsageSkills {
  total: number;
  enabled: number;
}

/** Everything the Usage pane shows. Every field is a count of something on disk. */
export interface UsageReport {
  /** ISO. When these numbers were read, so relative times have a reference. */
  gatheredAt: string;
  /** Newest activity first. Includes folders that are no longer on disk. */
  projects: UsageProject[];
  totals: {
    projects: number;
    /** How many of those are gone from disk. */
    missing: number;
    chats: number;
    playtests: number;
    changes: number;
  };
  skills: UsageSkills;
  /** ISO. Earliest conversation across every remembered folder. */
  firstChatAt: string | null;
  /** ISO. Most recent activity across every remembered folder. */
  lastActivityAt: string | null;
}

export interface UsageOptions {
  /** Where the recents list lives. Default: `~/.hearth/recent-projects.json`. */
  recentsFile?: string;
  /** The home directory paths are shortened against. Default: `os.homedir()`. */
  home?: string;
  /** Injectable clock, so a test can pin `gatheredAt`. */
  now?: () => Date;
}

/** One row of the recents list, as much of it as we can trust. */
interface RecentRow {
  path: string;
  name: string;
  openedAt: string | null;
}

/** The empty answer: a machine that has opened nothing. Also the failure floor. */
function emptyReport(gatheredAt: string): UsageReport {
  return {
    gatheredAt,
    projects: [],
    totals: { projects: 0, missing: 0, chats: 0, playtests: 0, changes: 0 },
    skills: { total: 0, enabled: 0 },
    firstChatAt: null,
    lastActivityAt: null,
  };
}

/**
 * Read the recents list, keeping only rows that name a folder. A missing file
 * is a first run; an unparseable one is a machine we can say nothing about —
 * both answer with no rows, and neither is written back to (nothing here
 * writes at all).
 */
export async function readRecentRows(file: string): Promise<RecentRow[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: RecentRow[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as { path?: unknown; name?: unknown; openedAt?: unknown };
    if (typeof row.path !== 'string' || row.path.trim() === '') continue;
    const projectPath = row.path;
    rows.push({
      path: projectPath,
      name:
        typeof row.name === 'string' && row.name.trim() !== ''
          ? row.name
          : path.basename(projectPath) || projectPath,
      openedAt: typeof row.openedAt === 'string' && row.openedAt !== '' ? row.openedAt : null,
    });
    if (rows.length >= MAX_PROJECTS_SCANNED) break;
  }
  return rows;
}

/** Write an absolute path the way a person reads it: `~/Hearth/shooter`. */
export function displayPath(abs: string, home: string): string {
  if (home === '') return abs;
  if (abs === home) return '~';
  return abs.startsWith(home + path.sep) ? `~${abs.slice(home.length)}` : abs;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The conversations in one folder: how many, when the first one started and
 * when the last one was spoken to. Straight off the index — the transcripts
 * themselves are never opened, which is what keeps this cheap.
 */
export async function readChatCounts(
  root: string,
): Promise<{ chats: number; firstChatAt: string | null; lastChatAt: string | null }> {
  let summaries;
  try {
    summaries = parseChatIndex(JSON.parse(await fsp.readFile(chatIndexPath(root), 'utf8')));
  } catch {
    // Absent (a folder nobody has talked to) or corrupt. Both mean no rows.
    return { chats: 0, firstChatAt: null, lastChatAt: null };
  }
  let first: string | null = null;
  let last: string | null = null;
  for (const chat of summaries) {
    first = earlier(first, chat.createdAt);
    last = later(last, chat.updatedAt);
  }
  return { chats: summaries.length, firstChatAt: first, lastChatAt: last };
}

/**
 * How many playtest sweeps this folder holds. One readdir: each sweep is a
 * directory, so the count is exact without opening any of them.
 */
export async function countPlaytests(root: string): Promise<number> {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, SWEEPS_DIR), { withFileTypes: true });
  } catch {
    return 0; // no evidence directory: this game has never been played
  }
  let count = 0;
  for (const entry of entries) if (entry.isDirectory()) count += 1;
  return count;
}

/**
 * How many entries this project's command journal has ever recorded.
 *
 * The journal assigns `seq = last + 1` on every append and keeps counting
 * across rotation, so the last line's `seq` is the running total — which means
 * this is a tail read rather than a file read.
 *
 * The scan walks backwards from the end rather than trusting the final line,
 * because a journal being appended to while this reads has a half-written line
 * at the bottom, and answering zero for a project with four hundred recorded
 * changes because a write was in flight would be a worse lie than being one
 * entry behind. When nothing in the window parses at all, zero is what "we
 * counted nothing here" already means everywhere else in this module.
 */
export async function readJournalSeq(root: string): Promise<number> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(path.join(root, JOURNAL_FILE), 'r');
  } catch {
    return 0;
  }
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return 0;
    const length = Math.min(size, JOURNAL_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // The first line of the window is dropped when the window did not start at
    // the start of the file: it is a fragment, and a multi-byte character
    // sliced in half lives there too.
    if (length < size) lines.shift();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (line === '') continue;
      try {
        const seq = (JSON.parse(line) as { seq?: unknown }).seq;
        if (typeof seq === 'number' && Number.isFinite(seq) && seq > 0) return Math.floor(seq);
      } catch {
        continue; // a torn trailing line, or one entry of nonsense: look further back
      }
    }
    return 0;
  } catch {
    return 0;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Skills, counted the same way the Skills screen counts them. */
export async function readSkillCounts(): Promise<UsageSkills> {
  try {
    const skills = await listSkills();
    return { total: skills.length, enabled: skills.filter((skill) => skill.enabled).length };
  } catch {
    return { total: 0, enabled: 0 };
  }
}

/** The earlier of two ISO timestamps, ignoring anything unparseable. */
function earlier(a: string | null, b: string | null): string | null {
  const at = a === null ? NaN : Date.parse(a);
  const bt = b === null ? NaN : Date.parse(b);
  if (!Number.isFinite(bt)) return Number.isFinite(at) ? a : null;
  if (!Number.isFinite(at)) return b;
  return bt < at ? b : a;
}

/** The later of two ISO timestamps, ignoring anything unparseable. */
function later(a: string | null, b: string | null): string | null {
  const at = a === null ? NaN : Date.parse(a);
  const bt = b === null ? NaN : Date.parse(b);
  if (!Number.isFinite(bt)) return Number.isFinite(at) ? a : null;
  if (!Number.isFinite(at)) return b;
  return bt > at ? b : a;
}

/** Everything one remembered folder contributes. A gone folder contributes zeroes. */
async function readProject(row: RecentRow, home: string): Promise<UsageProject> {
  const base: UsageProject = {
    path: row.path,
    name: row.name,
    display: displayPath(row.path, home),
    exists: false,
    chats: 0,
    playtests: 0,
    changes: 0,
    openedAt: row.openedAt,
    firstChatAt: null,
    lastChatAt: null,
    lastActivityAt: row.openedAt,
  };
  if (!(await isDirectory(row.path))) return base;

  const [counts, playtests, changes] = await Promise.all([
    readChatCounts(row.path),
    countPlaytests(row.path),
    readJournalSeq(row.path),
  ]);
  return {
    ...base,
    exists: true,
    chats: counts.chats,
    playtests,
    changes,
    firstChatAt: counts.firstChatAt,
    lastChatAt: counts.lastChatAt,
    lastActivityAt: later(row.openedAt, counts.lastChatAt),
  };
}

/**
 * Count everything, and never fail. The outer try is the last net: any surprise
 * from the filesystem answers with an empty machine rather than a broken pane,
 * because "nothing yet" is at least a state the pane knows how to draw.
 */
export async function collectUsage(options: UsageOptions = {}): Promise<UsageReport> {
  const gatheredAt = (options.now?.() ?? new Date()).toISOString();
  try {
    const home = options.home ?? os.homedir();
    const recentsFile = options.recentsFile ?? path.join(home, '.hearth', 'recent-projects.json');
    const rows = await readRecentRows(recentsFile);
    const [projects, skills] = await Promise.all([
      Promise.all(rows.map((row) => readProject(row, home))),
      readSkillCounts(),
    ]);

    const totals = { projects: projects.length, missing: 0, chats: 0, playtests: 0, changes: 0 };
    let firstChatAt: string | null = null;
    let lastActivityAt: string | null = null;
    for (const project of projects) {
      if (!project.exists) totals.missing += 1;
      totals.chats += project.chats;
      totals.playtests += project.playtests;
      totals.changes += project.changes;
      firstChatAt = earlier(firstChatAt, project.firstChatAt);
      lastActivityAt = later(lastActivityAt, project.lastActivityAt);
    }

    // Newest activity first, then by name, so two folders touched in the same
    // millisecond do not swap places between two readings of the same disk.
    projects.sort((a, b) => {
      const at = a.lastActivityAt === null ? 0 : Date.parse(a.lastActivityAt) || 0;
      const bt = b.lastActivityAt === null ? 0 : Date.parse(b.lastActivityAt) || 0;
      return at === bt ? a.name.localeCompare(b.name) : bt - at;
    });

    return { gatheredAt, projects, totals, skills, firstChatAt, lastActivityAt };
  } catch {
    return emptyReport(gatheredAt);
  }
}
