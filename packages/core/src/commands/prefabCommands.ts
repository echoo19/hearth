import { z } from 'zod';
import { defineCommand } from './types.js';
import { generateId, slugify } from '../ids.js';
import { ProjectError, writeJson, readJson } from '../project/store.js';
import { joinPath } from '../fs.js';
import { PREFABS_DIR, PrefabDataSchema, type Asset, type PrefabData } from '../schema/project.js';
import { findEntity, type Entity, type Scene } from '../schema/scene.js';
import {
  serializePrefab,
  instantiatePrefabData,
  validatePrefabLocalIds,
  collectSubtree,
  buildMergedInstance,
  revertInstanceOverrides,
  findInstanceMembership,
  detachInstanceContaining,
} from '../project/prefabData.js';

import type { CommandContext } from './types.js';

/**
 * Merge-sync every marked instance of `asset` across `targetScenes` from the
 * given prefab `data`. Each instance keeps its scene ids (via the marker's ids
 * map), gains fresh ids for new prefab locals, drops entities for removed
 * locals, preserves per-instance root name/position/enabled, and has its
 * recorded overrides re-applied on top — stale overrides (local/component/path
 * gone from the prefab) are dropped, each surfacing a PREFAB_OVERRIDE_STALE
 * warning. Returns per-scene instance counts and the total override tallies.
 */
function syncInstances(
  ctx: CommandContext,
  asset: Asset,
  data: PrefabData,
  targetScenes: Scene[],
): { scenes: { scene: string; instances: number }[]; total: number; overridesPreserved: number; overridesDropped: number } {
  const scenes: { scene: string; instances: number }[] = [];
  let total = 0;
  let overridesPreserved = 0;
  let overridesDropped = 0;

  for (const scene of targetScenes) {
    const marked = scene.entities
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => e.prefab?.asset === asset.id)
      .sort((a, b) => a.index - b.index)
      .map(({ e }) => e);

    // Drop any marked instance nested inside another marked instance's subtree:
    // rebuilding the outer root deletes the inner one's entities first, so
    // iterating it afterward would collectSubtree a now-missing entity. The
    // nested instance is rebuilt as a plain child of the outer instance.
    const roots = marked.filter(
      (candidate) =>
        !marked.some(
          (other) =>
            other.id !== candidate.id &&
            collectSubtree(scene.entities, other.id).some((e) => e.id === candidate.id),
        ),
    );
    if (roots.length === 0) continue;

    for (const root of roots) {
      const before = scene.entities;
      const rootIndex = before.findIndex((e) => e.id === root.id);
      const subtreeIds = new Set(collectSubtree(before, root.id).map((e) => e.id));
      const insertIndex = before.slice(0, rootIndex).filter((e) => !subtreeIds.has(e.id)).length;
      const kept = before.filter((e) => !subtreeIds.has(e.id));

      const merged = buildMergedInstance(scene, root.id, data);
      overridesPreserved += merged.overridesPreserved.length;
      overridesDropped += merged.overridesDropped.length;
      for (const dropped of merged.overridesDropped) {
        ctx.warn(
          'PREFAB_OVERRIDE_STALE',
          `Dropped a stale override on ${dropped.entity} (${dropped.component}.${dropped.path}): ` +
            `that component/path no longer exists in prefab "${asset.name}".`,
        );
      }

      kept.splice(insertIndex, 0, ...merged.instances);
      scene.entities = kept;

      const newRoot = merged.instances[0];
      ctx.changed({ kind: 'entity', id: newRoot.id, name: newRoot.name, scene: scene.id, action: 'modified' });
    }

    scenes.push({ scene: scene.id, instances: roots.length });
    total += roots.length;
  }

  return { scenes, total, overridesPreserved, overridesDropped };
}

/** Every scene in the project that loads successfully (stable project order). */
function allScenes(ctx: CommandContext): Scene[] {
  return ctx.store.project.scenes
    .map((ref) => ctx.store.getScene(ref.id))
    .filter((s): s is Scene => Boolean(s));
}

function requireScene(ctx: CommandContext, sceneRef: string): Scene {
  const scene = ctx.store.getScene(sceneRef);
  if (!scene) throw new ProjectError(`Scene not found: ${sceneRef}`, 'NOT_FOUND');
  return scene;
}

/**
 * A scene-unique entity name derived from `desired`: returns it unchanged if
 * free, else appends the lowest " 2", " 3", ... suffix that isn't taken (the
 * same convention duplicateScene uses). Instance roots are uniquified so that
 * placing a prefab twice yields addressable names ("Slime", "Slime 2") rather
 * than two identically-named entities that update/inspect-by-name can't tell
 * apart.
 */
function uniquifyEntityName(scene: Scene, desired: string): string {
  const taken = new Set(scene.entities.map((e) => e.name));
  if (!taken.has(desired)) return desired;
  let suffix = 2;
  while (taken.has(`${desired} ${suffix}`)) suffix += 1;
  return `${desired} ${suffix}`;
}

function requireEntity(scene: Scene, ref: string): Entity {
  const entity = findEntity(scene, ref);
  if (!entity) {
    throw new ProjectError(
      `Entity not found in scene "${scene.name}": ${ref}. Use inspectScene to list entities.`,
      'NOT_FOUND',
    );
  }
  return entity;
}

function requirePrefabAsset(ctx: CommandContext, ref: string): Asset {
  const asset = ctx.store.getAsset(ref);
  if (!asset) throw new ProjectError(`Prefab asset not found: ${ref}`, 'NOT_FOUND');
  if (asset.type !== 'prefab') {
    throw new ProjectError(`Asset "${ref}" is type ${asset.type}, expected prefab`, 'INVALID_INPUT');
  }
  return asset;
}

/** Read, schema-parse, and local-id-validate a prefab asset's payload file. */
async function loadPrefabData(ctx: CommandContext, asset: Asset): Promise<PrefabData> {
  const absPath = joinPath(ctx.store.root, asset.path);
  let raw: unknown;
  try {
    raw = await readJson(ctx.fs, absPath);
  } catch (err) {
    throw new ProjectError(
      `Prefab data for "${asset.name}" (${asset.path}) could not be read: ${(err as Error).message}`,
      'PREFAB_DATA_INVALID',
    );
  }

  let data: PrefabData;
  try {
    data = PrefabDataSchema.parse(raw);
  } catch (err) {
    throw new ProjectError(
      `Prefab data for "${asset.name}" (${asset.path}) does not match the prefab schema: ${(err as Error).message}`,
      'PREFAB_DATA_INVALID',
    );
  }
  const problems = validatePrefabLocalIds(data);
  if (problems.length > 0) {
    throw new ProjectError(
      `Prefab data for "${asset.name}" (${asset.path}) is invalid: ${problems.join('; ')}`,
      'PREFAB_DATA_INVALID',
    );
  }
  return data;
}

function registerAsset(ctx: CommandContext, asset: Asset): Asset {
  if (ctx.store.getAsset(asset.name)) {
    throw new ProjectError(
      `An asset named "${asset.name}" already exists. Asset names must be unique so agents can reference them.`,
      'CONFLICT',
    );
  }
  ctx.store.assets.assets.push(asset);
  ctx.changed({ kind: 'asset', id: asset.id, name: asset.name, path: asset.path, action: 'created' });
  return asset;
}

export const createPrefab = defineCommand({
  name: 'createPrefab',
  description:
    "Serialize an entity's full descendant subtree into a reusable prefab asset " +
    '(assets/prefabs/<slug>.prefab.json). The source root entity becomes an instance of the new prefab.',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    name: z.string().min(1),
  }),
  async run(ctx, params) {
    const scene = requireScene(ctx, params.scene);
    const root = requireEntity(scene, params.entity);

    const data = serializePrefab(params.name, scene.entities, root.id);

    const relPath = joinPath(PREFABS_DIR, `${slugify(params.name)}.prefab.json`);
    const absPath = joinPath(ctx.store.root, relPath);
    if (await ctx.fs.exists(absPath)) {
      throw new ProjectError(`Asset file already exists: ${relPath}`, 'CONFLICT');
    }
    await writeJson(ctx.fs, absPath, data);

    const asset = registerAsset(ctx, {
      id: generateId('ast'),
      name: params.name,
      type: 'prefab',
      path: relPath,
      metadata: { entityCount: data.entities.length },
    });

    // If the source is already a LIVE prefab instance, saving it as a new
    // prefab re-links it. Sever the old live link explicitly (removing the
    // stale marker/ids) and warn, rather than silently overwriting the marker
    // and discarding the instance's overrides against its original prefab —
    // the row's live-link badge shouldn't quietly re-point (L-012).
    if (findInstanceMembership(scene, root.id)) {
      detachInstanceContaining(scene, root.id);
      ctx.warn(
        'PREFAB_INSTANCE_RELINKED',
        `"${root.name}" was a live instance of another prefab; that link was replaced by the new prefab "${params.name}" and its per-instance overrides were dropped.`,
      );
    }

    // Write the fully-defaulted marker shape (empty ids/overrides) so the live
    // store matches what a save/reload produces. The source keeps an empty ids
    // map — it's "legacy-detached" (no membership, no implicit override
    // recording); edits to the source are pushed to the asset via updatePrefab.
    root.prefab = { asset: asset.id, ids: {}, overrides: [] };
    ctx.changed({ kind: 'entity', id: root.id, name: root.name, scene: scene.id, action: 'modified' });
    ctx.suggest(`instantiatePrefab --prefab ${asset.id} --scene <scene>`);

    return { asset, entityCount: data.entities.length };
  },
});

export const instantiatePrefab = defineCommand({
  name: 'instantiatePrefab',
  description:
    'Instantiate a prefab asset into a scene as a fresh entity subtree (fresh ids), optionally overriding ' +
    'position/name. The new root entity gains a prefab marker linking it back to the asset.',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    prefab: z.string().min(1),
    scene: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    name: z.string().optional(),
  }),
  async run(ctx, params) {
    const asset = requirePrefabAsset(ctx, params.prefab);
    const scene = requireScene(ctx, params.scene);
    const data = await loadPrefabData(ctx, asset);

    const ids: Record<string, string> = {};
    const instances = instantiatePrefabData(
      data,
      { position: params.position, name: params.name },
      ids,
    );

    const root = instances[0];
    // instantiatePrefabData is pure and sceneless, so the root name it sets
    // (opts.name ?? data.name) can collide with an existing entity. Uniquify
    // here, where the target scene is known, so names stay addressable.
    root.name = uniquifyEntityName(scene, root.name);
    // Live-link marker: `ids` maps every prefab local id to its spawned scene
    // id so later edits inside the subtree can be traced back to this root;
    // `overrides` starts empty and accrues implicit per-instance edits.
    root.prefab = { asset: asset.id, ids, overrides: [] };

    scene.entities.push(...instances);
    ctx.changed({ kind: 'entity', id: root.id, name: root.name, scene: scene.id, action: 'created' });
    ctx.suggest(`inspectEntity --scene ${scene.id} ${root.id}`);

    return { entity: root, entityCount: instances.length };
  },
});

export const updatePrefab = defineCommand({
  name: 'updatePrefab',
  description:
    "Re-serialize a modified prefab instance's subtree back over the prefab asset's payload file (same path, " +
    'same asset id). The entity must be a marked instance of that exact prefab.',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    prefab: z.string().min(1),
    scene: z.string().min(1),
    entity: z.string().min(1),
  }),
  async run(ctx, params) {
    const asset = requirePrefabAsset(ctx, params.prefab);
    const scene = requireScene(ctx, params.scene);
    const entity = requireEntity(scene, params.entity);

    if (!entity.prefab || entity.prefab.asset !== asset.id) {
      throw new ProjectError(
        `Entity "${entity.name}" (${entity.id}) is not a marked instance of prefab "${asset.name}" (${asset.id}).`,
        'PREFAB_NOT_INSTANCE',
      );
    }

    const data = serializePrefab(asset.name, scene.entities, entity.id);
    const absPath = joinPath(ctx.store.root, asset.path);
    await writeJson(ctx.fs, absPath, data);

    asset.metadata = { ...asset.metadata, entityCount: data.entities.length };
    ctx.changed({ kind: 'asset', id: asset.id, name: asset.name, path: asset.path, action: 'modified' });

    // Auto-sync: push the new payload to every instance of this prefab across
    // all scenes in the SAME command, so one undo entry rolls back both the
    // payload file and every re-synced instance.
    const synced = syncInstances(ctx, asset, data, allScenes(ctx));
    ctx.suggest(`inspectAssets --type prefab`);

    return {
      asset,
      entityCount: data.entities.length,
      instancesSynced: synced.total,
      overridesPreserved: synced.overridesPreserved,
      overridesDropped: synced.overridesDropped,
    };
  },
});

export const syncPrefabInstances = defineCommand({
  name: 'syncPrefabInstances',
  description:
    'Rebuild every marked instance of a prefab (all scenes, or one scene via `scene`) from the current prefab ' +
    "asset payload: each instance root keeps its id, name, Transform.position, and enabled state; the root's " +
    'descendants are deleted and rebuilt from the payload. If one instance is nested inside another instance of ' +
    'the same prefab, only the outermost is rebuilt as an instance — the nested one is rebuilt as a plain child ' +
    'of the outer instance (it loses its own marker).',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    prefab: z.string().min(1),
    scene: z.string().optional(),
  }),
  async run(ctx, params) {
    const asset = requirePrefabAsset(ctx, params.prefab);
    const data = await loadPrefabData(ctx, asset);

    const targetScenes: Scene[] = params.scene ? [requireScene(ctx, params.scene)] : allScenes(ctx);
    const synced = syncInstances(ctx, asset, data, targetScenes);

    return {
      scenes: synced.scenes,
      total: synced.total,
      overridesPreserved: synced.overridesPreserved,
      overridesDropped: synced.overridesDropped,
    };
  },
});

export const revertPrefabOverride = defineCommand({
  name: 'revertPrefabOverride',
  description:
    'Revert per-instance prefab overrides on an entity back to the prefab asset values. `entity` may be any ' +
    'member of the instance (root or descendant). Scope narrows with optional args: `component` + `path` reverts ' +
    'one field; `component` alone reverts every override on that component; neither reverts every override on that ' +
    "entity. Restores the prefab value(s) write-through and removes the override records. A no-op success when the " +
    'entity has no matching overrides.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    component: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  }),
  async run(ctx, params) {
    const scene = requireScene(ctx, params.scene);
    const entity = requireEntity(scene, params.entity);

    const membership = findInstanceMembership(scene, entity.id);
    if (!membership) {
      throw new ProjectError(
        `Entity "${entity.name}" (${entity.id}) is not a member of any prefab instance.`,
        'PREFAB_NOT_INSTANCE',
      );
    }
    if (params.path && !params.component) {
      throw new ProjectError('revertPrefabOverride: `path` requires `component`.', 'INVALID_INPUT');
    }

    const asset = requirePrefabAsset(ctx, membership.asset);
    const data = await loadPrefabData(ctx, asset);

    const reverted = revertInstanceOverrides(scene, entity.id, data, params.component, params.path);
    if (reverted.length > 0) {
      ctx.changed({ kind: 'entity', id: entity.id, name: entity.name, scene: scene.id, action: 'modified' });
    }

    const rootMarker = scene.entities.find((e) => e.id === membership.rootId)?.prefab;
    return {
      entityId: entity.id,
      reverted,
      remaining: rootMarker?.overrides?.length ?? 0,
    };
  },
});
