import { z } from 'zod';
import { defineCommand } from './types.js';
import { ProjectError } from '../project/store.js';
import { HistoryStore } from '../project/history.js';
import { applySnapshot } from '../project/restore.js';

/**
 * Commands that must never themselves become an undoable history entry:
 * `undo`/`redo` are the history navigation itself, and `revertProject` /
 * `snapshotProject` operate on the separate diff-baseline mechanism.
 */
export const HISTORY_EXEMPT: Set<string> = new Set(['undo', 'redo', 'revertProject', 'snapshotProject']);

/**
 * Map only the expected empty-history signals ('Nothing to undo/redo') to a
 * friendly NOT_FOUND error. Anything else (corrupt index.json, disk errors)
 * propagates unchanged so a broken history store isn't misreported as empty.
 */
function rethrowHistoryError(err: unknown): never {
  const message = (err as Error).message;
  if (message === 'Nothing to undo' || message === 'Nothing to redo') {
    throw new ProjectError(message, 'NOT_FOUND');
  }
  throw err;
}

export const undo = defineCommand({
  name: 'undo',
  description: 'Undo the most recent recorded change (see listHistory).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({}),
  async run(ctx) {
    const history = new HistoryStore(ctx.fs, ctx.store.root);
    const current = await ctx.store.toSnapshot();
    let result: Awaited<ReturnType<HistoryStore['undo']>>;
    try {
      result = await history.undo(current);
    } catch (err) {
      rethrowHistoryError(err);
    }
    await applySnapshot(ctx, result.snapshot);
    return { undone: result.entry.command, seq: result.entry.seq };
  },
});

export const redo = defineCommand({
  name: 'redo',
  description: 'Redo the most recently undone change (see listHistory).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({}),
  async run(ctx) {
    const history = new HistoryStore(ctx.fs, ctx.store.root);
    let result: Awaited<ReturnType<HistoryStore['redo']>>;
    try {
      result = await history.redo();
    } catch (err) {
      rethrowHistoryError(err);
    }
    await applySnapshot(ctx, result.snapshot);
    return { redone: result.entry.command, seq: result.entry.seq };
  },
});

export const listHistory = defineCommand({
  name: 'listHistory',
  description: 'List recorded undo/redo history entries, oldest first, marking which ones are currently undone.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({}),
  async run(ctx) {
    const history = new HistoryStore(ctx.fs, ctx.store.root);
    return history.list();
  },
});
