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
import { ZodError } from 'zod';
import type { FsLike } from '../fs.js';
import { joinPath } from '../fs.js';
import { readJson, writeJson, ProjectError, type ProjectSnapshot } from './store.js';
import { HISTORY_DIR, ProjectFileSchema, AssetIndexSchema, PlaytestSchema } from '../schema/project.js';
import { SceneSchema } from '../schema/scene.js';
import { pruneTrash } from './trash.js';

/**
 * `HistoryStore.undo`/`redo` read a `state-<seq>.json`/`redo-<seq>.json`
 * off disk and hand it straight to `applySnapshot`, which trusts its shape.
 * A tampered or hand-edited file (bad JSON is already caught by `readJson`;
 * this catches valid JSON with an invalid shape, e.g. a garbled asset entry)
 * would otherwise get applied, writing an invalid model to disk and
 * bricking every later command including redo. Parse every part with the
 * real schemas before it's allowed anywhere near `applySnapshot`.
 */
function validateSnapshot(raw: unknown, sourceFile: string): ProjectSnapshot {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('snapshot is not an object');
    }
    const snap = raw as Record<string, unknown>;

    const project = ProjectFileSchema.parse(snap.project);

    const scenesRaw = snap.scenes;
    if (typeof scenesRaw !== 'object' || scenesRaw === null || Array.isArray(scenesRaw)) {
      throw new Error('scenes must be an object keyed by scene id');
    }
    const scenes: ProjectSnapshot['scenes'] = {};
    for (const [id, scene] of Object.entries(scenesRaw as Record<string, unknown>)) {
      scenes[id] = SceneSchema.parse(scene);
    }

    const assets = AssetIndexSchema.parse(snap.assets);

    const scriptsRaw = snap.scripts;
    if (typeof scriptsRaw !== 'object' || scriptsRaw === null || Array.isArray(scriptsRaw)) {
      throw new Error('scripts must be an object keyed by path');
    }
    const scripts: Record<string, string> = {};
    for (const [path, source] of Object.entries(scriptsRaw as Record<string, unknown>)) {
      if (typeof source !== 'string') throw new Error(`script "${path}" is not a string`);
      scripts[path] = source;
    }

    const playtestsRaw = snap.playtests;
    if (typeof playtestsRaw !== 'object' || playtestsRaw === null || Array.isArray(playtestsRaw)) {
      throw new Error('playtests must be an object keyed by playtest id');
    }
    const playtests: ProjectSnapshot['playtests'] = {};
    for (const [id, pt] of Object.entries(playtestsRaw as Record<string, unknown>)) {
      playtests[id] = PlaytestSchema.parse(pt);
    }

    return { project, scenes, assets, scripts, playtests };
  } catch (err) {
    const detail =
      err instanceof ZodError
        ? err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        : (err as Error).message;
    throw new ProjectError(
      `Corrupt history snapshot in ${sourceFile}: ${detail}. The project was not changed.`,
      'HISTORY_CORRUPT',
    );
  }
}

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

  /**
   * Record a mutation: `before` is the model snapshot captured just before it
   * ran. `currentAssetIds` is the live project's asset index (post-mutation)
   * — needed alongside the retained snapshots to know which trash dirs are
   * still reachable when the bound drops old entries.
   */
  async record(
    command: string,
    summary: string,
    before: ProjectSnapshot,
    currentAssetIds: readonly string[] = [],
  ): Promise<void> {
    const index = await this.loadIndex();

    // A new mutation truncates any redo tail past the cursor.
    const truncated = index.entries.slice(index.cursor);
    for (const dropped of truncated) {
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
    const boundDropped: HistoryEntryMeta[] = [];
    while (index.entries.length > this.limit) {
      const removed = index.entries.shift()!;
      boundDropped.push(removed);
      await this.fs.remove(this.statePath(removed.seq));
      await this.fs.remove(this.redoPath(removed.seq));
    }
    index.cursor = index.entries.length;

    await this.saveIndex(index);

    // Orphaned trash dirs (assets that no longer appear in any retained
    // snapshot nor the live project) only need pruning when entries actually
    // fell off — the truncated-redo-tail case above doesn't shrink retention.
    if (truncated.length > 0 || boundDropped.length > 0) {
      await this.pruneOrphanedTrash(index, currentAssetIds);
    }
  }

  /** Remove `.hearth/trash/<id>` dirs for ids not in any retained snapshot or the live store. */
  private async pruneOrphanedTrash(index: HistoryIndex, currentAssetIds: readonly string[]): Promise<void> {
    const keep = new Set<string>(currentAssetIds);
    for (const entry of index.entries) {
      for (const path of [this.statePath(entry.seq), this.redoPath(entry.seq)]) {
        if (!(await this.fs.exists(path))) continue;
        const snapshot = (await readJson(this.fs, path)) as ProjectSnapshot;
        for (const asset of snapshot.assets?.assets ?? []) keep.add(asset.id);
      }
    }
    await pruneTrash(this.fs, this.root, keep);
  }

  /**
   * Undo the entry at the cursor: returns it plus the snapshot to restore.
   * Two-phase with `commitUndo` so a corrupt/invalid snapshot fails clean —
   * order is read -> validate -> write the redo file -> (caller applies the
   * snapshot) -> `commitUndo` moves the cursor. Validation runs before any
   * write, so on failure the index, cursor, and redo file are all untouched.
   */
  async undo(current: ProjectSnapshot): Promise<{ entry: HistoryEntryMeta; snapshot: ProjectSnapshot }> {
    const index = await this.loadIndex();
    if (index.cursor === 0) throw new Error('Nothing to undo');
    const entry = index.entries[index.cursor - 1];
    const raw = await readJson(this.fs, this.statePath(entry.seq));
    const snapshot = validateSnapshot(raw, `state-${entry.seq}.json`);
    await this.fs.mkdir(joinPath(this.root, HISTORY_DIR));
    await writeJson(this.fs, this.redoPath(entry.seq), current);
    return { entry, snapshot };
  }

  /** Commit a successful `undo()`: moves the cursor back. Call only after the caller's `applySnapshot` succeeds. */
  async commitUndo(): Promise<void> {
    const index = await this.loadIndex();
    index.cursor--;
    await this.saveIndex(index);
  }

  /**
   * Redo the entry just past the cursor: returns it plus the snapshot to
   * restore. Two-phase with `commitRedo`, same reasoning as `undo`/`commitUndo`.
   */
  async redo(): Promise<{ entry: HistoryEntryMeta; snapshot: ProjectSnapshot }> {
    const index = await this.loadIndex();
    if (index.cursor === index.entries.length) throw new Error('Nothing to redo');
    const entry = index.entries[index.cursor];
    const raw = await readJson(this.fs, this.redoPath(entry.seq));
    const snapshot = validateSnapshot(raw, `redo-${entry.seq}.json`);
    return { entry, snapshot };
  }

  /** Commit a successful `redo()`: moves the cursor forward. Call only after the caller's `applySnapshot` succeeds. */
  async commitRedo(): Promise<void> {
    const index = await this.loadIndex();
    index.cursor++;
    await this.saveIndex(index);
  }

  async list(): Promise<{ entries: (HistoryEntryMeta & { undone: boolean })[]; cursor: number }> {
    const index = await this.loadIndex();
    return {
      entries: index.entries.map((entry, i) => ({ ...entry, undone: i >= index.cursor })),
      cursor: index.cursor,
    };
  }
}
