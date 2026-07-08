/**
 * Small shared helpers for the prefab editor surfaces (Hierarchy's "Save as
 * prefab" badge lookup, AssetsPanel's "Sync instances", and Inspector's
 * "Sync all") — kept out of the components so the copy and the instance-count
 * preflight aren't duplicated across the two surfaces that both need them.
 */
import type { CommandResult } from './types';

type ExecFn = <T = unknown>(
  name: string,
  params?: unknown,
  opts?: { quiet?: boolean },
) => Promise<CommandResult<T>>;

/**
 * Count how many entities across the given scenes are marked instances of
 * `prefabAssetId` — a read-only preflight (inspectScene per scene, no
 * mutation) so a sync confirm dialog can state its blast radius ("Rebuilds N
 * instances...") before the user commits. syncPrefabInstances itself has no
 * dry-run mode, so this is the only way to know N ahead of time.
 */
export async function countPrefabInstances(
  exec: ExecFn,
  sceneIds: readonly string[],
  prefabAssetId: string,
): Promise<number> {
  let total = 0;
  for (const sceneId of sceneIds) {
    const result = await exec<{ entities: { prefab?: { asset: string } }[] }>(
      'inspectScene',
      { scene: sceneId },
      { quiet: true },
    );
    if (result.success && result.data) {
      total += result.data.entities.filter((e) => e.prefab?.asset === prefabAssetId).length;
    }
  }
  return total;
}

/** Exact confirm-dialog copy for syncing a prefab's instances (spec: verbatim, N substituted). */
export function syncConfirmBody(count: number): string {
  return `Rebuilds ${count} instances from this prefab. Names and positions are kept.`;
}
