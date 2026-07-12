/**
 * Pure helpers for reading prefab-instance override state in the Inspector.
 * Kept out of the component so the path-relationship logic stays
 * unit-testable without a DOM (same idiom as vec2List.ts / stringList.ts).
 */

/** One entry from inspectEntity's resolved `prefab.overridden` list — scoped to a single entity. */
export interface PrefabOverrideRef {
  component: string;
  path: string;
}

/** inspectEntity's resolved `prefab` block for the currently-inspected entity. */
export interface EntityPrefabInfo {
  asset: string;
  root: string;
  localId: string | null;
  overridden: PrefabOverrideRef[];
}

/**
 * True if `component`.`path` on the inspected entity carries a recorded
 * override — including ancestor/descendant path relationships, not just an
 * exact match:
 *
 * - A recorded override on a nested path marks its ancestor row overridden
 *   (e.g. a `Transform.position.x` override, from editing just the X axis,
 *   still lights up the single "Position" Inspector row that holds both
 *   axes).
 * - A recorded override on a whole field marks its descendant paths
 *   overridden (e.g. a `Transform.position` override covers
 *   `position.x`/`position.y`, for any caller that queries at that finer
 *   grain).
 *
 * A shared string prefix that isn't a real path boundary (`positionX` vs
 * `position`) is deliberately NOT a match — only `path` or `path.` prefixes
 * count as ancestor/descendant.
 */
export function isFieldOverridden(
  prefabInfo: EntityPrefabInfo | null | undefined,
  component: string,
  path: string,
): boolean {
  if (!prefabInfo) return false;
  return prefabInfo.overridden.some((o) => {
    if (o.component !== component) return false;
    if (o.path === path) return true;
    if (o.path.startsWith(`${path}.`)) return true;
    if (path.startsWith(`${o.path}.`)) return true;
    return false;
  });
}

/**
 * Every recorded override path (on `component`) that falls at or under
 * `path` — the exact set `revertPrefabOverride` calls must target to clear
 * everything an Inspector row's ember dot represents.
 *
 * `revertPrefabOverride`'s `path` param matches a recorded override's path
 * EXACTLY, not by prefix (see revertInstanceOverrides in prefabData.ts). So
 * a "Position" row lit up because of independently-recorded
 * `position.x`/`position.y` overrides needs BOTH of those exact paths
 * reverted individually — a single revert call with `path: "position"`
 * would match neither and silently revert nothing, even though the row
 * visibly showed as overridden.
 */
export function overriddenPathsUnder(
  prefabInfo: EntityPrefabInfo | null | undefined,
  component: string,
  path: string,
): string[] {
  if (!prefabInfo) return [];
  return prefabInfo.overridden
    .filter((o) => o.component === component && (o.path === path || o.path.startsWith(`${path}.`)))
    .map((o) => o.path);
}

/** One raw override record as stored on a prefab instance root's marker (schema/scene.ts EntitySchema.prefab.overrides). */
export interface RawPrefabOverride {
  entity: string;
  component: string;
  path: string;
  value?: unknown;
}

/**
 * Distinct member-entity ids carrying at least one recorded override, in
 * first-seen order — the minimal set of `revertPrefabOverride` calls (one
 * per entity, no component/path so each call clears everything on that
 * entity) needed to revert every override across a whole prefab instance.
 */
export function overriddenEntityIds(overrides: readonly RawPrefabOverride[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const o of overrides) {
    if (!seen.has(o.entity)) {
      seen.add(o.entity);
      order.push(o.entity);
    }
  }
  return order;
}
