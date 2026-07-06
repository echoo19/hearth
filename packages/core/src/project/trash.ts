/**
 * Binary asset trash: `.hearth/trash/<assetId>/<basename>`. Deleting an asset
 * (or restoring away from an import) never unlinks the file outright — it
 * moves it here so undo/redo can bring it back. All path math for the trash
 * lives in this one module; callers (assetCommands' removeAsset, restore.ts's
 * reconciliation pass, HistoryStore's prune) only deal in asset ids and
 * project-relative paths.
 */
import type { FsLike } from '../fs.js';
import { joinPath, dirnamePath, basenamePath } from '../fs.js';
import { TRASH_DIR } from '../schema/project.js';

/** Absolute path to an asset's trash directory. */
export function assetTrashDir(root: string, assetId: string): string {
  return joinPath(root, TRASH_DIR, assetId);
}

/** Absolute path an asset's file would occupy inside its trash directory. */
export function assetTrashPath(root: string, assetId: string, relPath: string): string {
  return joinPath(assetTrashDir(root, assetId), basenamePath(relPath));
}

async function moveFile(fs: FsLike, src: string, dest: string): Promise<void> {
  const bytes = await fs.readFileBinary(src);
  await fs.mkdir(dirnamePath(dest));
  await fs.writeFile(dest, bytes);
  await fs.remove(src);
}

/**
 * Move an asset's file (project-relative `relPath`) into its trash directory.
 * No-op (returns false) if the file isn't on disk.
 */
export async function moveToTrash(
  fs: FsLike,
  root: string,
  assetId: string,
  relPath: string,
): Promise<boolean> {
  const src = joinPath(root, relPath);
  if (!(await fs.exists(src))) return false;
  await moveFile(fs, src, assetTrashPath(root, assetId, relPath));
  return true;
}

/**
 * Move an asset's file back from trash to its project-relative `relPath`.
 * Returns false (no-op) if the trash copy is missing.
 */
export async function restoreFromTrash(
  fs: FsLike,
  root: string,
  assetId: string,
  relPath: string,
): Promise<boolean> {
  const src = assetTrashPath(root, assetId, relPath);
  if (!(await fs.exists(src))) return false;
  await moveFile(fs, src, joinPath(root, relPath));

  // Tidy up the now-(likely-)empty per-asset trash directory.
  const dir = assetTrashDir(root, assetId);
  if (await fs.exists(dir)) {
    const remaining = await fs.readdir(dir);
    if (remaining.length === 0) await fs.remove(dir);
  }
  return true;
}

/** Remove every trash directory whose asset id is not in `keepIds`. */
export async function pruneTrash(fs: FsLike, root: string, keepIds: ReadonlySet<string>): Promise<void> {
  const trashRoot = joinPath(root, TRASH_DIR);
  if (!(await fs.exists(trashRoot))) return;
  for (const assetId of await fs.readdir(trashRoot)) {
    if (!keepIds.has(assetId)) {
      await fs.remove(joinPath(trashRoot, assetId));
    }
  }
}
