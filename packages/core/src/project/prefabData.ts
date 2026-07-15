/**
 * Pure prefab data operations: subtree collection, serialization to portable
 * `PrefabData`, and instantiation back into fresh scene entities. No file
 * I/O and no `ProjectStore` here — commands (a later wave-F task) wire this
 * module to scenes and the asset index.
 */
import { generateId } from '../ids.js';
import { createComponent, COMPONENT_SCHEMAS, isComponentType } from '../schema/components.js';
import type { Entity, Scene } from '../schema/scene.js';
import { PrefabDataSchema, type PrefabData, type PrefabEntity } from '../schema/project.js';
import { ProjectError } from './store.js';

/** Read a nested value by dot-path segments (undefined if any segment is absent). */
export function valueAtPath(data: unknown, path: string[]): unknown {
  let cursor: unknown = data;
  for (const seg of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/** Set a nested value by dot-path segments, returning a modified deep copy. */
export function setAtPath(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const copy = structuredClone(target);
  let cursor: Record<string, unknown> = copy;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = cursor[key];
    if (typeof next !== 'object' || next === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
  return copy;
}

/**
 * BFS `entities` starting at `rootId`, returning the root and every
 * descendant (root first, stable order). Entities outside the subtree are
 * ignored. Throws `ProjectError('NOT_FOUND')` if `rootId` doesn't exist.
 */
export function collectSubtree(entities: Entity[], rootId: string): Entity[] {
  const root = entities.find((e) => e.id === rootId);
  if (!root) {
    throw new ProjectError(`Entity not found: ${rootId}`, 'NOT_FOUND');
  }

  const subtree: Entity[] = [];
  const seen = new Set<string>([root.id]);
  const queue: Entity[] = [root];
  while (queue.length) {
    const current = queue.shift()!;
    subtree.push(current);
    for (const e of entities) {
      if (e.parentId === current.id && !seen.has(e.id)) {
        seen.add(e.id);
        queue.push(e);
      }
    }
  }
  return subtree;
}

/**
 * Serialize `rootId`'s subtree (from `entities`) into portable prefab data:
 * ids normalized to `pfe_1..` in BFS order, `parentId` remapped to match,
 * and any `prefab` marker stripped from every entity (root included).
 */
export function serializePrefab(name: string, entities: Entity[], rootId: string): PrefabData {
  const subtree = collectSubtree(entities, rootId);

  const idMap = new Map<string, string>();
  subtree.forEach((e, i) => idMap.set(e.id, `pfe_${i + 1}`));

  const prefabEntities: PrefabEntity[] = subtree.map((e) => {
    const clone = structuredClone(e) as Entity & { prefab?: unknown };
    delete clone.prefab;
    return {
      ...clone,
      id: idMap.get(e.id)!,
      parentId: e.id === rootId ? null : (idMap.get(e.parentId!) ?? null),
      // If a component ever stores entity ids, remap here (see wave F plan).
    };
  });

  return PrefabDataSchema.parse({ name, entities: prefabEntities });
}

export interface InstantiateOptions {
  position?: { x: number; y: number };
  name?: string;
  /** Keep this id for the root instance instead of generating a fresh one (sync uses this). */
  preserveRootId?: string;
}

/**
 * Instantiate `data` into fresh scene entities: every id becomes a new
 * `ent_*` id (unless `opts.preserveRootId` pins the root), `parentId` is
 * remapped to match, `opts.position` overrides the root's Transform
 * position (creating a Transform if the root doesn't have one), and the
 * root's name defaults to `data.name` or `opts.name` when given.
 *
 * This function is pure and sceneless, so it does NOT uniquify the root name
 * against any scene — a caller that inserts the result into a scene is
 * responsible for scene-level name uniquification (see instantiatePrefab in
 * prefabCommands.ts).
 *
 * If `idMapOut` is provided, it is filled with the local-id (`pfe_<n>`) ->
 * spawned scene-id mapping for every entity, so the caller can write the live
 * `prefab.ids` link on the instance root. (Passed as an out-param rather than
 * a richer return type to keep existing array consumers, e.g. the runtime's
 * spawnPrefab, source-compatible.)
 */
export function instantiatePrefabData(
  data: PrefabData,
  opts: InstantiateOptions = {},
  idMapOut?: Record<string, string>,
): Entity[] {
  const idMap = new Map<string, string>();
  data.entities.forEach((e, i) => {
    idMap.set(e.id, i === 0 && opts.preserveRootId ? opts.preserveRootId : generateId('ent'));
  });
  if (idMapOut) {
    for (const [localId, sceneId] of idMap) idMapOut[localId] = sceneId;
  }

  const instances: Entity[] = data.entities.map((e) => {
    const clone = structuredClone(e) as PrefabEntity;
    return {
      ...clone,
      id: idMap.get(e.id)!,
      parentId: e.parentId === null ? null : (idMap.get(e.parentId) ?? null),
      // If a component ever stores entity ids, remap here (see wave F plan).
    };
  });

  const root = instances[0];
  root.name = opts.name ?? data.name;
  if (opts.position) {
    root.components.Transform = {
      ...(root.components.Transform ?? createComponent('Transform')),
      position: { ...opts.position },
    };
  }

  return instances;
}

/** Human-readable problems with `data`'s local-id invariants, or `[]` if none. */
export function validatePrefabLocalIds(data: PrefabData): string[] {
  const problems: string[] = [];
  const { entities } = data;
  if (entities.length === 0) {
    return ['prefab has no entities'];
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const e of entities) {
    if (seen.has(e.id)) duplicates.add(e.id);
    seen.add(e.id);
  }
  if (duplicates.size > 0) {
    problems.push(`duplicate local ids: ${[...duplicates].join(', ')}`);
  }

  entities.forEach((e, i) => {
    if (i === 0) {
      if (e.parentId !== null) {
        problems.push(`root entity (index 0, id ${e.id}) must have parentId null, got ${e.parentId}`);
      }
      return;
    }
    if (e.parentId === null) {
      problems.push(`entity ${e.id} at index ${i} has parentId null but is not the root (non-root-first)`);
      return;
    }
    const parentIndex = entities.findIndex((p) => p.id === e.parentId);
    if (parentIndex === -1) {
      problems.push(`entity ${e.id} has a dangling parentId: ${e.parentId}`);
    } else if (parentIndex >= i) {
      problems.push(`entity ${e.id} at index ${i} appears before its parent ${e.parentId} (non-root-first order)`);
    }
  });

  for (const e of entities) {
    if ((e as unknown as { prefab?: unknown }).prefab !== undefined) {
      problems.push(`entity ${e.id} still has a prefab marker (markers must be stripped from prefab data)`);
    }
  }

  return problems;
}

/** The prefab instance a scene entity belongs to (see findInstanceMembership). */
export interface InstanceMembership {
  /** Scene id of the instance root that owns this entity. */
  rootId: string;
  /** Prefab asset id the instance links to. */
  asset: string;
  /** This entity's prefab-local id (`pfe_<n>`) within the instance. */
  localId: string;
}

/**
 * Locate the prefab instance `entityId` belongs to by scanning root markers'
 * `ids` maps in the same scene. Returns the root id, prefab asset, and the
 * entity's prefab-local id, or `null` when it is not a member of any instance
 * (including "legacy-detached" instances whose `ids` map is empty). The root
 * itself is a member (it maps to `pfe_1`).
 *
 * A reverse scan is built per call — there is no persistent cache that could
 * go stale. Each spawned entity id appears in at most one marker's `ids` map
 * (instantiate only writes ids for its own freshly-spawned subtree), so the
 * first match is unambiguous.
 */
export function findInstanceMembership(scene: Scene, entityId: string): InstanceMembership | null {
  for (const e of scene.entities) {
    const marker = e.prefab;
    // `marker.ids` can be absent on a marker written by older code paths (e.g.
    // createPrefab marks the source root with `{ asset }` only) before a
    // save/reload normalizes it — treat such markers as legacy-detached.
    if (!marker?.ids) continue;
    for (const [localId, sceneId] of Object.entries(marker.ids)) {
      if (sceneId === entityId) {
        return { rootId: e.id, asset: marker.asset, localId };
      }
    }
  }
  return null;
}

/**
 * A root carries a BROKEN prefab marker when it has a `.prefab` link but no
 * self-entry in its own `ids` map — i.e. no id in the map resolves back to the
 * root itself (an empty `ids: {}` is the common case, e.g. a `createPrefab`
 * source that was never synced/healed). Such a marker looks like a live
 * instance to the UI but resolves to no membership, so every structural-edit
 * detach check anchored on it silently no-ops (SH-1). It is not a live
 * instance: treat it as a non-member and repair it away rather than trusting it.
 */
export function isBrokenPrefabMarker(entity: Entity): boolean {
  const marker = entity.prefab;
  if (!marker) return false;
  const ids = marker.ids ?? {};
  return !Object.values(ids).includes(entity.id);
}

/**
 * Record (or replace) an implicit override on the instance root that owns
 * `entityId`. No-op when `entityId` is not an instance member. `value` must be
 * the post-parse, JSON-safe written value (what the component now holds); it is
 * cloned so the stored record doesn't alias live component data.
 *
 * The instance root's own name, enabled flag, and `Transform.position` are
 * per-instance placement, never overrides — so a write to the ROOT's
 * `Transform.position` (or any deeper position path) is skipped here. Every
 * other write, on the root or any descendant, records. Overrides on the same
 * (entity, component, path) replace in place rather than appending.
 */
export function recordInstanceOverride(
  scene: Scene,
  entityId: string,
  component: string,
  path: string,
  value: unknown,
): void {
  const membership = findInstanceMembership(scene, entityId);
  if (!membership) return;

  const isRoot = membership.rootId === entityId;
  if (isRoot && component === 'Transform' && (path === 'position' || path.startsWith('position.'))) {
    return; // root position is per-instance placement, not an override
  }

  const root = scene.entities.find((e) => e.id === membership.rootId);
  if (!root?.prefab) return;
  const overrides = (root.prefab.overrides ??= []);
  const cloned = structuredClone(value);
  const existing = overrides.find(
    (o) => o.entity === entityId && o.component === component && o.path === path,
  );
  if (existing) {
    existing.value = cloned;
  } else {
    overrides.push({ entity: entityId, component, path, value: cloned });
  }
}

/** A prefab override record (component-property or non-root move) on a marker. */
export interface OverrideRecord {
  entity: string;
  component: string;
  path: string;
  value?: unknown;
}

/** Result of building the merged subtree for a single instance root. */
export interface MergedInstance {
  /** Rebuilt subtree (root first) with reused scene ids and overrides re-applied. */
  instances: Entity[];
  /** Overrides that were re-applied (survived the merge). */
  overridesPreserved: OverrideRecord[];
  /** Overrides dropped because their local/component/path no longer exists in the prefab. */
  overridesDropped: OverrideRecord[];
}

/**
 * Rebuild the subtree for the instance rooted at `rootId` from `data`, MERGING
 * rather than replacing: every prefab local that already has a scene id in the
 * root marker's `ids` map keeps that id (so references stay stable), new prefab
 * locals get fresh ids, and locals removed from the prefab simply aren't
 * rebuilt (their old entities are dropped by the caller). The root keeps its
 * scene id, name, `enabled`, and `Transform.position` (per-instance placement);
 * every other field comes from the prefab. Recorded overrides are then
 * re-applied on top of the rebuilt components; an override whose local,
 * component, or path no longer exists in the prefab is dropped (surfaced via
 * `overridesDropped`). The returned root marker carries the complete new `ids`
 * map and the surviving overrides.
 *
 * Pure: reads the current marker off `scene` but does not mutate the scene —
 * the caller splices `instances` in and deletes the old subtree.
 */
export function buildMergedInstance(scene: Scene, rootId: string, data: PrefabData): MergedInstance {
  const root = scene.entities.find((e) => e.id === rootId);
  if (!root) throw new ProjectError(`Entity not found: ${rootId}`, 'NOT_FOUND');
  const asset = root.prefab?.asset;
  if (!asset) throw new ProjectError(`Entity ${rootId} is not a prefab instance root`, 'INVALID_INPUT');

  const oldIds: Record<string, string> = root.prefab?.ids ?? {};
  const oldOverrides: OverrideRecord[] = (root.prefab?.overrides ?? []).map((o) => ({ ...o }));

  // local id (pfe_*) -> scene id: reuse existing, fresh for new locals; root pinned.
  const newIds: Record<string, string> = {};
  data.entities.forEach((e, i) => {
    if (i === 0) newIds[e.id] = rootId;
    else newIds[e.id] = oldIds[e.id] ?? generateId('ent');
  });

  const instances: Entity[] = data.entities.map((e) => {
    const clone = structuredClone(e) as PrefabEntity;
    return {
      ...clone,
      id: newIds[e.id],
      parentId: e.parentId === null ? null : (newIds[e.parentId] ?? null),
    };
  });

  // Preserve per-instance placement on the root.
  const newRoot = instances[0];
  newRoot.name = root.name;
  newRoot.enabled = root.enabled;
  const preservedPosition = root.components.Transform?.position;
  if (preservedPosition) {
    newRoot.components.Transform = {
      ...(newRoot.components.Transform ?? createComponent('Transform')),
      position: { ...preservedPosition },
    };
  }

  // Re-apply overrides. Map each override's scene id back to its local id via
  // the OLD ids map to check the local still exists in the new prefab, then
  // confirm the component/path still resolve there.
  const reverse = new Map<string, string>(); // sceneId -> pfe local id
  for (const [local, sid] of Object.entries(oldIds)) reverse.set(sid, local);
  const prefabByLocal = new Map(data.entities.map((e) => [e.id, e]));
  const instanceById = new Map(instances.map((e) => [e.id, e]));

  const overridesPreserved: OverrideRecord[] = [];
  const overridesDropped: OverrideRecord[] = [];
  for (const o of oldOverrides) {
    const local = reverse.get(o.entity);
    const prefabEntity = local ? prefabByLocal.get(local) : undefined;
    const prefabComponent = prefabEntity
      ? (prefabEntity.components as Record<string, unknown>)[o.component]
      : undefined;
    const parts = o.path.split('.');
    const stale =
      !local ||
      !prefabEntity ||
      prefabComponent === undefined ||
      valueAtPath(prefabComponent, parts) === undefined;
    if (stale) {
      overridesDropped.push(o);
      continue;
    }
    const target = instanceById.get(o.entity);
    if (!target) {
      overridesDropped.push(o);
      continue;
    }
    const current = (target.components as Record<string, unknown>)[o.component];
    if (current === undefined || current === null || typeof current !== 'object') {
      overridesDropped.push(o);
      continue;
    }
    // Re-apply the override, then re-parse via the component schema (same
    // posture as revertInstanceOverrides). A value that no longer fits the
    // prefab's current schema shape (e.g. a numeric override on a field the
    // prefab turned into a string) is dropped as stale rather than written —
    // the rebuilt prefab value is kept so the component stays valid.
    const applied = setAtPath(current as Record<string, unknown>, parts, structuredClone(o.value));
    if (isComponentType(o.component)) {
      const parsed = COMPONENT_SCHEMAS[o.component].safeParse(applied);
      if (!parsed.success) {
        overridesDropped.push(o);
        continue;
      }
      (target.components as Record<string, unknown>)[o.component] = parsed.data;
    } else {
      (target.components as Record<string, unknown>)[o.component] = applied;
    }
    overridesPreserved.push(o);
  }

  newRoot.prefab = {
    asset,
    ids: newIds,
    overrides: overridesPreserved.map((o) => ({ ...o, value: structuredClone(o.value) })),
  };

  return { instances, overridesPreserved, overridesDropped };
}

/**
 * Restore the prefab's own value(s) for the overrides on `entityId` that match
 * `component`/`path` scope, dropping the matching override records. Scope:
 * both omitted -> every override on this entity; only `component` -> all of
 * that component's overrides; both -> the single field. `data` is the current
 * prefab payload (used to read the value to restore). Returns the reverted
 * targets; a no-op (empty) when nothing matches. Mutates the live entity's
 * component data and the root marker's overrides list in place.
 */
export function revertInstanceOverrides(
  scene: Scene,
  entityId: string,
  data: PrefabData,
  component?: string,
  path?: string,
): { component: string; path: string }[] {
  const membership = findInstanceMembership(scene, entityId);
  if (!membership) return [];
  const root = scene.entities.find((e) => e.id === membership.rootId);
  const entity = scene.entities.find((e) => e.id === entityId);
  if (!root?.prefab || !entity) return [];

  const overrides = root.prefab.overrides ?? [];
  const matches = overrides.filter(
    (o) =>
      o.entity === entityId &&
      (component === undefined || o.component === component) &&
      (path === undefined || o.path === path),
  );
  if (matches.length === 0) return [];

  const prefabEntity = data.entities.find((e) => e.id === membership.localId);
  const reverted: { component: string; path: string }[] = [];
  for (const o of matches) {
    const prefabComponent = prefabEntity
      ? (prefabEntity.components as Record<string, unknown>)[o.component]
      : undefined;
    const parts = o.path.split('.');
    const prefabValue = prefabComponent !== undefined ? valueAtPath(prefabComponent, parts) : undefined;
    const current = (entity.components as Record<string, unknown>)[o.component];
    if (prefabValue !== undefined && current !== undefined && current !== null && typeof current === 'object') {
      const updated = setAtPath(current as Record<string, unknown>, parts, structuredClone(prefabValue));
      if (isComponentType(o.component)) {
        const parsed = COMPONENT_SCHEMAS[o.component].safeParse(updated);
        (entity.components as Record<string, unknown>)[o.component] = parsed.success ? parsed.data : updated;
      } else {
        (entity.components as Record<string, unknown>)[o.component] = updated;
      }
    }
    reverted.push({ component: o.component, path: o.path });
  }

  root.prefab.overrides = overrides.filter((o) => !matches.includes(o));
  return reverted;
}

/**
 * If `entityId` belongs to a live prefab instance, detach that instance by
 * removing its root marker and return the detach info; otherwise a no-op. Used
 * by structural edits (adding/removing an entity or component inside an
 * instance) that break the live link between an instance and its prefab.
 *
 * A root with a BROKEN marker (a `.prefab` link but no self-entry in its `ids`
 * map — see `isBrokenPrefabMarker`) resolves to no membership and is left
 * untouched here: it is not a live instance, and the createPrefab "source
 * master" (an unsynced empty-ids marker) intentionally survives structural
 * edits so `updatePrefab` can push the evolved subtree back to the asset. Such
 * markers converge by being synced/updated (which repopulates `ids`), not by
 * being cleared. The editor gates its "instance" banner on membership so a
 * broken marker never presents as a healthy live instance (SH-1).
 */
export function detachInstanceContaining(
  scene: Scene,
  entityId: string,
): { detached: boolean; rootId?: string; asset?: string } {
  const membership = findInstanceMembership(scene, entityId);
  if (!membership) return { detached: false };
  const root = scene.entities.find((e) => e.id === membership.rootId);
  if (!root?.prefab) return { detached: false };
  delete root.prefab;
  return { detached: true, rootId: membership.rootId, asset: membership.asset };
}
