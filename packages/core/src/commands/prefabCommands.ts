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
} from '../project/prefabData.js';

import type { CommandContext } from './types.js';

function requireScene(ctx: CommandContext, sceneRef: string): Scene {
  const scene = ctx.store.getScene(sceneRef);
  if (!scene) throw new ProjectError(`Scene not found: ${sceneRef}`, 'NOT_FOUND');
  return scene;
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

    root.prefab = { asset: asset.id };
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

    const instances = instantiatePrefabData(data, {
      position: params.position,
      name: params.name,
    });

    const root = instances[0];
    root.prefab = { asset: asset.id };

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
    ctx.suggest(`syncPrefabInstances --prefab ${asset.id}`);

    return { asset, entityCount: data.entities.length };
  },
});

export const syncPrefabInstances = defineCommand({
  name: 'syncPrefabInstances',
  description:
    'Rebuild every marked instance of a prefab (all scenes, or one scene via `scene`) from the current prefab ' +
    "asset payload: each instance root keeps its id, name, Transform.position, and enabled state; the root's " +
    'descendants are deleted and rebuilt from the payload.',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    prefab: z.string().min(1),
    scene: z.string().optional(),
  }),
  async run(ctx, params) {
    const asset = requirePrefabAsset(ctx, params.prefab);
    const data = await loadPrefabData(ctx, asset);

    const targetScenes: Scene[] = params.scene
      ? [requireScene(ctx, params.scene)]
      : ctx.store.project.scenes
          .map((ref) => ctx.store.getScene(ref.id))
          .filter((s): s is Scene => Boolean(s));

    const scenes: { scene: string; instances: number }[] = [];
    let total = 0;

    for (const scene of targetScenes) {
      const roots = scene.entities
        .map((e, index) => ({ e, index }))
        .filter(({ e }) => e.prefab?.asset === asset.id)
        .sort((a, b) => a.index - b.index)
        .map(({ e }) => e);

      if (roots.length === 0) continue;

      for (const root of roots) {
        const before = scene.entities;
        const rootIndex = before.findIndex((e) => e.id === root.id);
        const subtreeIds = new Set(collectSubtree(before, root.id).map((e) => e.id));
        const insertIndex = before.slice(0, rootIndex).filter((e) => !subtreeIds.has(e.id)).length;
        const kept = before.filter((e) => !subtreeIds.has(e.id));

        const instances = instantiatePrefabData(data, {
          preserveRootId: root.id,
          name: root.name,
          position: root.components.Transform?.position,
        });
        const newRoot = instances[0];
        newRoot.enabled = root.enabled;
        newRoot.prefab = { asset: asset.id };

        kept.splice(insertIndex, 0, ...instances);
        scene.entities = kept;

        ctx.changed({ kind: 'entity', id: newRoot.id, name: newRoot.name, scene: scene.id, action: 'modified' });
      }

      scenes.push({ scene: scene.id, instances: roots.length });
      total += roots.length;
    }

    return { scenes, total };
  },
});
