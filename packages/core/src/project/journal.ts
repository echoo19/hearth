/**
 * Disk-backed command journal: an append-only log of every command run
 * through `HearthSession.execute` (see the append hook in `../session.ts`),
 * independent of the undo/redo history in `./history.ts`. Feeds the editor's
 * trust timeline and external-change detection — unlike history, it records
 * both successes and failures, and is never rewound by undo/redo.
 *
 * Layout: a single file, `.hearth/log/commands.jsonl`, one JSON `JournalEntry`
 * per line, oldest first. Rotated (kept bounded) rather than indexed, since
 * entries are never mutated or removed individually.
 */
import type { FsLike } from '../fs.js';
import { joinPath } from '../fs.js';
import { LOG_DIR, JOURNAL_FILE } from '../schema/project.js';

export interface JournalEntry {
  seq: number;
  ts: string; // ISO
  source: string; // 'editor' | 'cli' | 'mcp' | 'unknown'
  command: string;
  summary: string;
  ok: boolean;
  error?: string; // error code when ok=false
  detail?: Record<string, unknown>; // small facts only
}

/** Once the journal grows past this many lines, it's rewritten down to `JOURNAL_ROTATE_KEEP`. */
export const JOURNAL_ROTATE_MAX = 4000;
export const JOURNAL_ROTATE_KEEP = 2000;

/**
 * Commands journaled even though they don't mutate the project: their
 * outcome (pass/fail counts, validation results) is itself the kind of fact
 * an agent's trust timeline needs, even on a read-only run.
 */
export const JOURNAL_ALLOWLIST = new Set(['runPlaytest', 'validateProject', 'exportDesktop', 'rememberNote']);

export function shouldJournal(name: string, mutates: boolean): boolean {
  return mutates || JOURNAL_ALLOWLIST.has(name);
}

export class JournalStore {
  constructor(
    private readonly fs: FsLike,
    private readonly root: string,
  ) {}

  private path(): string {
    return joinPath(this.root, JOURNAL_FILE);
  }

  /**
   * The seq of the last line in the file. Every write to this file (append
   * or rotation-rewrite) leaves exactly one trailing '\n' and no blank
   * lines, so the last line can be found with a backward scan instead of
   * parsing (or even reading past) every prior line — this runs on every
   * `append` (every mutating command), and journals can grow to thousands
   * of entries between rotations.
   */
  async lastSeq(): Promise<number> {
    const path = this.path();
    if (!(await this.fs.exists(path))) return 0;
    const text = await this.fs.readFile(path);
    if (text.length === 0) return 0;
    const end = text.length - 1; // index of the single trailing '\n'
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const lastLine = text.slice(start, end);
    return (JSON.parse(lastLine) as JournalEntry).seq;
  }

  /** Number of entries currently on disk, without JSON-parsing any of them. */
  private async countLines(): Promise<number> {
    const path = this.path();
    if (!(await this.fs.exists(path))) return 0;
    const text = await this.fs.readFile(path);
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 /* '\n' */) count++;
    }
    return count;
  }

  private async readAll(): Promise<JournalEntry[]> {
    const path = this.path();
    if (!(await this.fs.exists(path))) return [];
    const text = await this.fs.readFile(path);
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JournalEntry);
  }

  /** Append one entry, assigning `seq = maxSeq + 1`. Rotates the file if it just crossed `JOURNAL_ROTATE_MAX` lines. */
  async append(entry: Omit<JournalEntry, 'seq'>): Promise<JournalEntry> {
    const seq = (await this.lastSeq()) + 1;
    const full: JournalEntry = { seq, ...entry };
    await this.fs.mkdir(joinPath(this.root, LOG_DIR));
    await this.fs.appendFile(this.path(), `${JSON.stringify(full)}\n`);
    await this.rotateIfNeeded(seq);
    return full;
  }

  private async rotateIfNeeded(seq: number): Promise<void> {
    // The file can never have more lines than the highest seq ever assigned
    // (each line carries a distinct seq, rotation only ever removes lines),
    // so there's nothing to check — let alone rewrite — until `seq` itself
    // has climbed past the rotation threshold.
    if (seq <= JOURNAL_ROTATE_MAX) return;
    const count = await this.countLines();
    if (count <= JOURNAL_ROTATE_MAX) return;
    const entries = await this.readAll();
    const kept = entries.slice(entries.length - JOURNAL_ROTATE_KEEP);
    const text = kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await this.fs.writeFile(this.path(), text);
  }

  /**
   * Entries in ascending seq order.
   *
   * With `since`, this is forward-cursor paging: entries with seq > since,
   * oldest-first, capped at `limit`. Without `since` (no cursor position
   * yet), callers want the tail of the log, not its head, so this returns
   * the newest `limit` entries instead — still ascending within the result.
   */
  async read(opts: { since?: number; limit?: number } = {}): Promise<JournalEntry[]> {
    const entries = await this.readAll();
    if (opts.since !== undefined) {
      const filtered = entries.filter((e) => e.seq > opts.since!);
      return opts.limit !== undefined ? filtered.slice(0, opts.limit) : filtered;
    }
    return opts.limit !== undefined ? entries.slice(Math.max(0, entries.length - opts.limit)) : entries;
  }
}
