/**
 * Pure prefab data operations: subtree collection, serialization to portable
 * `PrefabData`, and instantiation back into fresh scene entities. No file
 * I/O and no `ProjectStore` here — commands (a later wave-F task) wire this
 * module to scenes and the asset index.
 */
import { generateId } from '../ids.js';
import { createComponent } from '../schema/components.js';
import type { Entity, Scene } from '../schema/scene.js';
import { PrefabDataSchema, type PrefabData, type PrefabEntity } from '../schema/project.js';
import { ProjectError } from './store.js';

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
