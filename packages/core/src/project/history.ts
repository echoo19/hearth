/**
 * Disk-backed undo/redo history: a bounded stack of whole-model snapshots
 * captured around every mutating command (see `HISTORY_EXEMPT` in
 * `../commands/historyCommands.ts` and the capture hook in `../session.ts`).
 *
 * Layout under `.hearth/history/`:
 *   index.json      - a `HistoryIndex` (the ordered entry list + cursor)
 *   state-<seq>.json - the before-snapshot for entry <seq> (undo target)
 *   redo-<seq>.json  - written on undo; the snapshot to restore on redo
 */
import type { FsLike } from '../fs.js';
import { joinPath } from '../fs.js';
import { readJson, writeJson, type ProjectSnapshot } from './store.js';
import { HISTORY_DIR } from '../schema/project.js';

export interface HistoryEntryMeta {
  seq: number;
  command: string;
  summary: string;
  timestamp: string;
}

export interface HistoryIndex {
  nextSeq: number;
  cursor: number;
  entries: HistoryEntryMeta[];
}

const INDEX_FILE = 'index.json';

export class HistoryStore {
  constructor(
    private readonly fs: FsLike,
    private readonly root: string,
    private readonly limit = 25,
  ) {}

  private indexPath(): string {
    return joinPath(this.root, HISTORY_DIR, INDEX_FILE);
  }

  private statePath(seq: number): string {
    return joinPath(this.root, HISTORY_DIR, `state-${seq}.json`);
  }

  private redoPath(seq: number): string {
    return joinPath(this.root, HISTORY_DIR, `redo-${seq}.json`);
  }

  private async loadIndex(): Promise<HistoryIndex> {
    const path = this.indexPath();
    if (!(await this.fs.exists(path))) {
      return { nextSeq: 1, cursor: 0, entries: [] };
    }
    return (await readJson(this.fs, path)) as HistoryIndex;
  }

  private async saveIndex(index: HistoryIndex): Promise<void> {
    await this.fs.mkdir(joinPath(this.root, HISTORY_DIR));
    await writeJson(this.fs, this.indexPath(), index);
  }

  /** Record a mutation: `before` is the model snapshot captured just before it ran. */
  async record(command: string, summary: string, before: ProjectSnapshot): Promise<void> {
    const index = await this.loadIndex();

    // A new mutation truncates any redo tail past the cursor.
    for (const dropped of index.entries.slice(index.cursor)) {
      await this.fs.remove(this.statePath(dropped.seq));
      await this.fs.remove(this.redoPath(dropped.seq));
    }
    index.entries = index.entries.slice(0, index.cursor);

    const seq = index.nextSeq++;
    index.entries.push({ seq, command, summary, timestamp: new Date().toISOString() });
    await this.fs.mkdir(joinPath(this.root, HISTORY_DIR));
    await writeJson(this.fs, this.statePath(seq), before);
    index.cursor = index.entries.length;

    // Bound the history: drop the oldest entries beyond `limit`.
    while (index.entries.length > this.limit) {
      const removed = index.entries.shift()!;
      await this.fs.remove(this.statePath(removed.seq));
      await this.fs.remove(this.redoPath(removed.seq));
    }
    index.cursor = index.entries.length;

    await this.saveIndex(index);
  }

  /** Undo the entry at the cursor, returning it plus the snapshot to restore. */
  async undo(current: ProjectSnapshot): Promise<{ entry: HistoryEntryMeta; snapshot: ProjectSnapshot }> {
    const index = await this.loadIndex();
    if (index.cursor === 0) throw new Error('Nothing to undo');
    const entry = index.entries[index.cursor - 1];
    await this.fs.mkdir(joinPath(this.root, HISTORY_DIR));
    await writeJson(this.fs, this.redoPath(entry.seq), current);
    const snapshot = (await readJson(this.fs, this.statePath(entry.seq))) as ProjectSnapshot;
    index.cursor--;
    await this.saveIndex(index);
    return { entry, snapshot };
  }

  /** Redo the entry just past the cursor, returning it plus the snapshot to restore. */
  async redo(): Promise<{ entry: HistoryEntryMeta; snapshot: ProjectSnapshot }> {
    const index = await this.loadIndex();
    if (index.cursor === index.entries.length) throw new Error('Nothing to redo');
    const entry = index.entries[index.cursor];
    const snapshot = (await readJson(this.fs, this.redoPath(entry.seq))) as ProjectSnapshot;
    index.cursor++;
    await this.saveIndex(index);
    return { entry, snapshot };
  }

  async list(): Promise<{ entries: (HistoryEntryMeta & { undone: boolean })[]; cursor: number }> {
    const index = await this.loadIndex();
    return {
      entries: index.entries.map((entry, i) => ({ ...entry, undone: i >= index.cursor })),
      cursor: index.cursor,
    };
  }
}
