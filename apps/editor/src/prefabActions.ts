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

/**
 * Confirm-dialog copy for syncing a prefab's instances. `syncPrefabInstances`
 * is a MERGE, not a wholesale rebuild (Wave I): each instance's subtree is
 * reconciled against the prefab reusing its existing scene ids, so per-
 * instance overrides survive the sync and are only dropped when the field
 * they targeted no longer exists on the updated prefab.
 */
export function syncConfirmBody(count: number): string {
  return `Syncs ${count} instances with this prefab. Overrides you've made on each instance are kept; any that no longer apply to the updated prefab are dropped. Names and positions are kept.`;
}

/** Total override count across a prefab instance, from the root marker's raw `overrides` list (each entry already scoped to whichever member entity it was recorded on — root or a descendant). */
export function instanceOverrideCount(overrides: readonly { entity: string }[]): number {
  return overrides.length;
}

/** Confirm-dialog copy for the Inspector banner's "Revert all" — clears every recorded override across the whole instance, root and descendants alike, restoring the prefab's own values. */
export function revertAllConfirmBody(count: number): string {
  return `Reverts ${count} override${count === 1 ? '' : 's'} across this prefab instance, restoring the prefab's own values.`;
}

/**
 * Guards a countPrefabInstances preflight against races: AssetsPanel's
 * "Sync instances" and Inspector's "Sync all" both `await
 * countPrefabInstances(...)` (a multi-scene inspectScene round-trip) before
 * opening a destructive-styled confirm dialog for whatever was the target at
 * click time. If the user moves on — clicks Sync again (for the same or a
 * different target) or the underlying selection changes — while that count
 * is still in flight, the eventual result must not surface a confirm dialog
 * for a target the user is no longer looking at.
 *
 * `begin()` marks the start of a new attempt and invalidates every prior one
 * from this controller; call sites should call it again (or otherwise bump
 * it) whenever the target itself changes, not just when a new count starts,
 * so a passive selection change also drops a stale in-flight result.
 * `isCurrent(token)` is the only source of truth for "is this result still
 * wanted" — false means drop it silently, no dialog, no state update beyond
 * clearing the pending flag.
 */
export interface SyncPreflight {
  /** Start a new attempt, invalidating any earlier one from this controller. Returns a token for this attempt. */
  begin(): number;
  /** True only if no `begin()` call has happened since `token` was issued. */
  isCurrent(token: number): boolean;
}

export function createSyncPreflight(): SyncPreflight {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      return latest;
    },
    isCurrent(token) {
      return token === latest;
    },
  };
}
