/**
 * Whole-model restore: replaces the in-memory project (model + script files)
 * with a previously captured `ProjectSnapshot`. Shared by `revertProject`
 * (restores to the diff baseline) and `undo`/`redo` (restores to a history
 * entry).
 */
import type { FsLike } from '../fs.js';
import { joinPath } from '../fs.js';
import type { ChangedRef } from '../commands/types.js';
import type { ProjectStore, ProjectSnapshot } from './store.js';

export interface RestoreContext {
  store: ProjectStore;
  fs: FsLike;
  root: string;
  changed: (ref: ChangedRef) => void;
}

/** Restore `ctx.store`'s model and script files to match `snapshot` exactly. */
export async function applySnapshot(ctx: RestoreContext, snapshot: ProjectSnapshot): Promise<void> {
  ctx.store.project = snapshot.project;
  ctx.store.scenes = new Map(Object.entries(snapshot.scenes));
  ctx.store.assets = snapshot.assets;
  ctx.store.playtests = new Map(Object.entries(snapshot.playtests));

  // Restore script files (including removing scripts created after the snapshot).
  const currentScripts = await ctx.store.listScripts();
  for (const path of currentScripts) {
    if (!(path in snapshot.scripts)) {
      await ctx.fs.remove(joinPath(ctx.root, path));
      ctx.changed({ kind: 'script', path, action: 'deleted' });
    }
  }
  for (const [path, source] of Object.entries(snapshot.scripts)) {
    await ctx.fs.writeFile(joinPath(ctx.root, path), source);
    ctx.changed({ kind: 'script', path, action: 'modified' });
  }
  ctx.changed({ kind: 'project', id: ctx.store.project.id, action: 'modified' });
}
