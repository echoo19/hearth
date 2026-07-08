/**
 * Pure prefab data operations: subtree collection, serialization to portable
 * `PrefabData`, and instantiation back into fresh scene entities. No file
 * I/O and no `ProjectStore` here — commands (a later wave-F task) wire this
 * module to scenes and the asset index.
 */
import { generateId } from '../ids.js';
import { createComponent } from '../schema/components.js';
import type { Entity } from '../schema/scene.js';
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
 */
export function instantiatePrefabData(data: PrefabData, opts: InstantiateOptions = {}): Entity[] {
  const idMap = new Map<string, string>();
  data.entities.forEach((e, i) => {
    idMap.set(e.id, i === 0 && opts.preserveRootId ? opts.preserveRootId : generateId('ent'));
  });

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
