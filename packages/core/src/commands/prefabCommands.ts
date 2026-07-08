import { z } from 'zod';
import { defineCommand } from './types.js';
import { generateId, slugify } from '../ids.js';
import { ProjectError, writeJson, readJson } from '../project/store.js';
import { joinPath } from '../fs.js';
import { PREFABS_DIR, PrefabDataSchema, type Asset } from '../schema/project.js';
import { findEntity, type Entity, type Scene } from '../schema/scene.js';
import { serializePrefab, instantiatePrefabData, validatePrefabLocalIds } from '../project/prefabData.js';

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
    const asset = ctx.store.getAsset(params.prefab);
    if (!asset) throw new ProjectError(`Prefab asset not found: ${params.prefab}`, 'NOT_FOUND');
    if (asset.type !== 'prefab') {
      throw new ProjectError(`Asset "${params.prefab}" is type ${asset.type}, expected prefab`, 'INVALID_INPUT');
    }

    const scene = requireScene(ctx, params.scene);

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

    let data;
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
