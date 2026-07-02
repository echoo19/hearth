import { z } from 'zod';
import { defineCommand } from './types.js';
import { generateId, slugify } from '../ids.js';
import { SCENES_DIR } from '../schema/project.js';
import type { Scene, Entity } from '../schema/scene.js';
import { ProjectError } from '../project/store.js';
import { joinPath } from '../fs.js';
import { createComponent } from '../schema/components.js';

export const createScene = defineCommand({
  name: 'createScene',
  description: 'Create a new scene. Optionally adds a default main camera entity.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    name: z.string().min(1),
    /** Add a "Main Camera" entity automatically (default true). */
    withCamera: z.boolean().default(true),
    /** Make this the project's initial scene if none is set (default true). */
    makeInitialIfFirst: z.boolean().default(true),
  }),
  async run(ctx, params) {
    if (ctx.store.getScene(params.name)) {
      throw new ProjectError(`A scene named "${params.name}" already exists`, 'CONFLICT');
    }
    const id = generateId('scn');
    const path = joinPath(SCENES_DIR, `${slugify(params.name)}.scene.json`);
    if (ctx.store.project.scenes.some((s) => s.path === path)) {
      throw new ProjectError(`Scene file ${path} already exists (name slug collision)`, 'CONFLICT');
    }
    const scene: Scene = { formatVersion: 1, id, name: params.name, entities: [] };
    if (params.withCamera) {
      scene.entities.push({
        id: generateId('ent'),
        name: 'Main Camera',
        parentId: null,
        enabled: true,
        tags: [],
        components: {
          Transform: createComponent('Transform'),
          Camera: createComponent('Camera'),
        },
      });
    }
    ctx.store.scenes.set(id, scene);
    ctx.store.project.scenes.push({ id, name: params.name, path });
    if (params.makeInitialIfFirst && !ctx.store.project.initialScene) {
      ctx.store.project.initialScene = id;
    }
    ctx.changed({ kind: 'scene', id, name: params.name, path, action: 'created' });
    ctx.suggest(`createEntity --scene ${id}`, `inspectScene ${id}`);
    return { sceneId: id, name: params.name, path };
  },
});

export const deleteScene = defineCommand({
  name: 'deleteScene',
  description: 'Delete a scene from the project (removes the scene file).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({ scene: z.string().min(1) }),
  async run(ctx, params) {
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');
    const ref = ctx.store.sceneRef(scene.id)!;
    ctx.store.scenes.delete(scene.id);
    ctx.store.project.scenes = ctx.store.project.scenes.filter((s) => s.id !== scene.id);
    if (ctx.store.project.initialScene === scene.id) {
      ctx.store.project.initialScene = ctx.store.project.scenes[0]?.id ?? null;
      ctx.warn('INITIAL_SCENE_REASSIGNED', `initialScene was deleted; now ${ctx.store.project.initialScene ?? 'null'}`);
    }
    await ctx.fs.remove(joinPath(ctx.store.root, ref.path));
    ctx.changed({ kind: 'scene', id: scene.id, name: scene.name, path: ref.path, action: 'deleted' });
    return { sceneId: scene.id, name: scene.name };
  },
});

export const duplicateScene = defineCommand({
  name: 'duplicateScene',
  description: 'Duplicate a scene (all entities get fresh ids).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    newName: z.string().min(1),
  }),
  async run(ctx, params) {
    const source = ctx.store.getScene(params.scene);
    if (!source) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');
    if (ctx.store.getScene(params.newName)) {
      throw new ProjectError(`A scene named "${params.newName}" already exists`, 'CONFLICT');
    }
    const id = generateId('scn');
    const path = joinPath(SCENES_DIR, `${slugify(params.newName)}.scene.json`);
    const idMap = new Map<string, string>();
    for (const e of source.entities) idMap.set(e.id, generateId('ent'));
    const entities: Entity[] = structuredClone(source.entities).map((e) => ({
      ...e,
      id: idMap.get(e.id)!,
      parentId: e.parentId ? (idMap.get(e.parentId) ?? null) : null,
    }));
    const scene: Scene = { formatVersion: 1, id, name: params.newName, entities };
    ctx.store.scenes.set(id, scene);
    ctx.store.project.scenes.push({ id, name: params.newName, path });
    ctx.changed({ kind: 'scene', id, name: params.newName, path, action: 'created' });
    return { sceneId: id, name: params.newName, path, entityCount: entities.length };
  },
});

export const renameScene = defineCommand({
  name: 'renameScene',
  description: 'Rename a scene (scene file keeps its path).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({ scene: z.string().min(1), newName: z.string().min(1) }),
  async run(ctx, params) {
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');
    const previous = scene.name;
    scene.name = params.newName;
    const ref = ctx.store.sceneRef(scene.id)!;
    ref.name = params.newName;
    ctx.changed({ kind: 'scene', id: scene.id, name: params.newName, action: 'modified' });
    return { sceneId: scene.id, previousName: previous, name: params.newName };
  },
});

export const setInitialScene = defineCommand({
  name: 'setInitialScene',
  description: "Set the project's initial scene (the one that runs first).",
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({ scene: z.string().min(1) }),
  async run(ctx, params) {
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');
    ctx.store.project.initialScene = scene.id;
    ctx.changed({ kind: 'project', id: ctx.store.project.id, action: 'modified' });
    return { initialScene: scene.id, name: scene.name };
  },
});
