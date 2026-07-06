/**
 * Whole-model restore: replaces the in-memory project (model + script files)
 * with a previously captured `ProjectSnapshot`. Shared by `revertProject`
 * (restores to the diff baseline) and `undo`/`redo` (restores to a history
 * entry).
 */
import type { FsLike } from '../fs.js';
import { joinPath, isSafeRelativePath } from '../fs.js';
import type { ChangedRef } from '../commands/types.js';
import type { ProjectStore, ProjectSnapshot } from './store.js';
import { playtestFilePath } from './store.js';
import { moveToTrash, restoreFromTrash, isSafeTrashAssetId } from './trash.js';
import { PLAYTESTS_DIR, SCENES_DIR } from '../schema/project.js';

export interface RestoreContext {
  store: ProjectStore;
  fs: FsLike;
  root: string;
  changed: (ref: ChangedRef) => void;
  /** Optional: reconciliation reports a missing trash file this way, if provided. */
  warn?: (code: string, message: string) => void;
}

/** Restore `ctx.store`'s model and script files to match `snapshot` exactly. */
export async function applySnapshot(ctx: RestoreContext, snapshot: ProjectSnapshot): Promise<void> {
  const previousAssets = ctx.store.assets;

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

  // Playtest and scene files aren't reconstructed from the snapshot (unlike
  // scripts, whose content IS the snapshot) — they're written wholesale by
  // store.save() from whatever's now in ctx.store.playtests/scenes. save()
  // only ever writes, never removes, so a playtest/scene that existed before
  // this restore but not after (the thing being undone) would otherwise be
  // left on disk: inert as far as the live model is concerned, but a fresh
  // ProjectStore.load slurps every *.playtest.json it finds regardless of
  // the model, resurrecting it in the next session. Clean up both the same
  // way the scripts loop above does: diff current on-disk files against the
  // filename set the restored snapshot implies, remove anything stale.
  const expectedPlaytestFiles = new Set(
    Object.values(snapshot.playtests).map((pt) => playtestFilePath(pt.name)),
  );
  await removeStaleFiles(ctx, PLAYTESTS_DIR, '.playtest.json', expectedPlaytestFiles, 'playtest');

  // Scenes are referenced from hearth.json, so an orphaned scene file is
  // inert (nothing loads it) — but it silently shadows a later same-name
  // createScene, which writes to the same slugified path. Clean it up too.
  const expectedSceneFiles = new Set(snapshot.project.scenes.map((ref) => ref.path));
  await removeStaleFiles(ctx, SCENES_DIR, '.scene.json', expectedSceneFiles, 'scene');

  await reconcileAssetFiles(ctx, previousAssets.assets, snapshot.assets.assets);

  ctx.changed({ kind: 'project', id: ctx.store.project.id, action: 'modified' });
}

/**
 * Binary asset files aren't part of a `ProjectSnapshot` (only the asset index
 * is), so restoring the model alone leaves files out of sync. Diff the asset
 * index before vs. after this restore: assets that disappeared get their file
 * moved into `.hearth/trash/<id>/`; assets that reappeared get their file
 * moved back out, if it's missing at its project path. Symmetric by
 * construction, so it makes both deleteAsset and importAsset undo/redo
 * correctly with no command-specific logic here.
 */
async function reconcileAssetFiles(
  ctx: RestoreContext,
  before: { id: string; path: string }[],
  after: { id: string; path: string }[],
): Promise<void> {
  const beforeIds = new Set(before.map((a) => a.id));
  const afterIds = new Set(after.map((a) => a.id));

  // Snapshots are plain JSON on disk, so ids/paths here are untrusted: a
  // corrupted or hand-edited state-<seq>.json must not be able to move files
  // outside the project or the trash. Unsafe entries are skipped with a
  // warning; the model still restores.
  const isSafe = (asset: { id: string; path: string }): boolean => {
    if (isSafeTrashAssetId(asset.id) && isSafeRelativePath(asset.path)) return true;
    ctx.warn?.(
      'ASSET_TRASH_UNSAFE',
      `Skipping asset file reconciliation for "${asset.id}" (${asset.path}): unsafe id or path in snapshot.`,
    );
    return false;
  };

  for (const asset of before) {
    if (afterIds.has(asset.id)) continue;
    if (!isSafe(asset)) continue;
    // Deliberately a pure index diff: even if the command that removed this
    // asset never touched its file (removeAsset with deleteFile:false),
    // redoing that removal still moves the file to trash so disk stays
    // consistent with the index. Round-trip-safe — the matching undo pulls
    // it back out. Pinned by a regression test in history-assets.test.ts.
    const moved = await moveToTrash(ctx.fs, ctx.root, asset.id, asset.path);
    if (moved) {
      ctx.changed({ kind: 'asset', id: asset.id, path: asset.path, action: 'deleted' });
    }
  }

  for (const asset of after) {
    if (beforeIds.has(asset.id)) continue;
    if (!isSafe(asset)) continue;
    const destPath = joinPath(ctx.root, asset.path);
    if (await ctx.fs.exists(destPath)) continue;
    const restored = await restoreFromTrash(ctx.fs, ctx.root, asset.id, asset.path);
    if (restored) {
      ctx.changed({ kind: 'asset', id: asset.id, path: asset.path, action: 'created' });
    } else {
      ctx.warn?.(
        'ASSET_TRASH_MISSING',
        `Asset "${asset.id}" was restored to the project but its file is not in trash (${asset.path}) — the model is back but the file is gone.`,
      );
    }
  }
}

/**
 * Remove on-disk files under `dir` matching `suffix` that aren't in
 * `expected` (project-relative paths). Shared by the playtest and scene
 * stale-file cleanup above — best-effort id/name extraction for the
 * `changed` record, but an unparsable orphan still gets removed.
 */
async function removeStaleFiles(
  ctx: RestoreContext,
  dir: string,
  suffix: string,
  expected: ReadonlySet<string>,
  kind: ChangedRef['kind'],
): Promise<void> {
  const dirPath = joinPath(ctx.root, dir);
  if (!(await ctx.fs.exists(dirPath))) return;
  for (const file of await ctx.fs.readdir(dirPath)) {
    if (!file.endsWith(suffix)) continue;
    const relPath = joinPath(dir, file);
    if (expected.has(relPath)) continue;
    const absPath = joinPath(ctx.root, relPath);
    let id: string | undefined;
    let name: string | undefined;
    try {
      const raw = JSON.parse(await ctx.fs.readFile(absPath)) as Record<string, unknown>;
      if (typeof raw.id === 'string') id = raw.id;
      if (typeof raw.name === 'string') name = raw.name;
    } catch {
      // Orphan file isn't valid JSON — still remove it, just without id/name.
    }
    await ctx.fs.remove(absPath);
    ctx.changed({ kind, id, name, path: relPath, action: 'deleted' });
  }
}
