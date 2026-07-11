import { z } from 'zod';
import { defineCommand } from './types.js';
import { generateId } from '../ids.js';
import { findEntity, wouldCreateCycle, type Entity } from '../schema/scene.js';
import { createComponent, isComponentType, COMPONENT_TYPES } from '../schema/components.js';
import { ProjectError } from '../project/store.js';
import { recordInstanceOverride } from '../project/prefabData.js';

import type { Scene } from '../schema/scene.js';
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

export const createEntity = defineCommand({
  name: 'createEntity',
  description:
    'Create an entity in a scene. Always gets a Transform. Pass components to add more, e.g. {"SpriteRenderer": {"color": "#ff0000"}}.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    name: z.string().min(1),
    parent: z.string().optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    tags: z.array(z.string()).default([]),
    /** Component type -> property overrides (defaults applied). */
    components: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  }),
  async run(ctx, params) {
    const scene = requireScene(ctx, params.scene);
    let parentId: string | null = null;
    if (params.parent) {
      parentId = requireEntity(scene, params.parent).id;
    }
    const entity: Entity = {
      id: generateId('ent'),
      name: params.name,
      parentId,
      enabled: true,
      tags: params.tags,
      components: {
        Transform: createComponent('Transform', params.position ? { position: params.position } : {}),
      },
    };
    for (const [type, overrides] of Object.entries(params.components)) {
      if (!isComponentType(type)) {
        throw new ProjectError(
          `Unknown component type "${type}". Valid types: ${COMPONENT_TYPES.join(', ')}`,
          'INVALID_INPUT',
        );
      }
      (entity.components as Record<string, unknown>)[type] = createComponent(type, overrides);
    }
    scene.entities.push(entity);
    ctx.changed({ kind: 'entity', id: entity.id, name: entity.name, scene: scene.id, action: 'created' });
    ctx.suggest(`inspectEntity --scene ${scene.id} ${entity.id}`, `addComponent --scene ${scene.id} ${entity.id} <type>`);
    return { entityId: entity.id, name: entity.name, sceneId: scene.id, components: Object.keys(entity.components) };
  },
});

export const deleteEntity = defineCommand({
  name: 'deleteEntity',
  description: 'Delete an entity (children are re-parented to the deleted entity\'s parent).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({ scene: z.string().min(1), entity: z.string().min(1) }),
  async run(ctx, params) {
    const scene = requireScene(ctx, params.scene);
    const entity = requireEntity(scene, params.entity);
    for (const child of scene.entities) {
      if (child.parentId === entity.id) child.parentId = entity.parentId;
    }
    scene.entities = scene.entities.filter((e) => e.id !== entity.id);
    ctx.changed({ kind: 'entity', id: entity.id, name: entity.name, scene: scene.id, action: 'deleted' });
    return { entityId: entity.id, name: entity.name };
  },
});

export const renameEntity = defineCommand({
  name: 'renameEntity',
  description: 'Rename an entity.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    newName: z.string().min(1),
  }),
  async run(ctx, params) {
    const scene = requireScene(ctx, params.scene);
    const entity = requireEntity(scene, params.entity);
    const previous = entity.name;
    entity.name = params.newName;
    ctx.changed({ kind: 'entity', id: entity.id, name: entity.name, scene: scene.id, action: 'modified' });
    return { entityId: entity.id, previousName: previous, name: entity.name };
  },
});

export const duplicateEntity = defineCommand({
  name: 'duplicateEntity',
  description:
    'Duplicate an entity and its full descendant subtree (fresh ids for every copy). ' +
    "The root copy's position is offset from the original (default 16,16); descendants keep their " +
    'parent-relative Transform.position unchanged, so the whole subtree moves together.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    newName: z.string().optional(),
    offset: z.object({ x: z.number(), y: z.number() }).default({ x: 16, y: 16 }),
  }),
  async run(ctx, params) {
    const scene = requireScene(ctx, params.scene);
    const root = requireEntity(scene, params.entity);

    // BFS the full subtree (root + every descendant), building the fresh-id
    // map as we go so a re-visited id can never be queued twice.
    const subtree: Entity[] = [];
    const idMap = new Map<string, string>();
    idMap.set(root.id, generateId('ent'));
    const queue: Entity[] = [root];
    while (queue.length) {
      const current = queue.shift()!;
      subtree.push(current);
      for (const e of scene.entities) {
        if (e.parentId === current.id && !idMap.has(e.id)) {
          idMap.set(e.id, generateId('ent'));
          queue.push(e);
        }
      }
    }

    const copies: Entity[] = structuredClone(subtree).map((e) => ({
      ...e,
      id: idMap.get(e.id)!,
      // The root copy keeps the ORIGINAL root's parent unchanged; every
      // other copy's parentId is remapped inside the subtree.
      parentId: e.id === root.id ? root.parentId : (idMap.get(e.parentId!) ?? null),
    }));

    const rootCopy = copies[0];
    rootCopy.name = params.newName ?? `${root.name} copy`;
    if (rootCopy.components.Transform) {
      const pos = rootCopy.components.Transform.position;
      rootCopy.components.Transform = {
        ...rootCopy.components.Transform,
        position: { x: pos.x + params.offset.x, y: pos.y + params.offset.y },
      };
    }

    scene.entities.push(...copies);
    ctx.changed({ kind: 'entity', id: rootCopy.id, name: rootCopy.name, scene: scene.id, action: 'created' });
    ctx.suggest(`inspectEntity --scene ${scene.id} ${rootCopy.id}`);
    return { entityId: rootCopy.id, name: rootCopy.name, copiedCount: copies.length };
  },
});

export const moveEntity = defineCommand({
  name: 'moveEntity',
  description:
    'Move an entity: set position (Transform) and/or re-parent it. Position is in scene pixels.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    /** New parent entity (id or name), or null to move to scene root. */
    parent: z.string().nullable().optional(),
  }),
  async run(ctx, params) {
    const scene = requireScene(ctx, params.scene);
    const entity = requireEntity(scene, params.entity);
    if (params.position) {
      const transform = entity.components.Transform ?? createComponent('Transform');
      transform.position = { ...params.position };
      entity.components.Transform = transform;
      // A move of a NON-root instance member is an implicit Transform.position
      // override; a move of the instance ROOT is per-instance placement and is
      // never recorded (recordInstanceOverride enforces the root exclusion).
      recordInstanceOverride(scene, entity.id, 'Transform', 'position', entity.components.Transform.position);
    }
    if (params.parent !== undefined) {
      const newParentId = params.parent === null ? null : requireEntity(scene, params.parent).id;
      if (newParentId && wouldCreateCycle(scene, entity.id, newParentId)) {
        throw new ProjectError(
          `Cannot parent "${entity.name}" under ${params.parent}: would create a cycle`,
          'INVALID_INPUT',
        );
      }
      entity.parentId = newParentId;
    }
    ctx.changed({ kind: 'entity', id: entity.id, name: entity.name, scene: scene.id, action: 'modified' });
    return {
      entityId: entity.id,
      position: entity.components.Transform?.position ?? null,
      parentId: entity.parentId,
    };
  },
});

export const setEntityEnabled = defineCommand({
  name: 'setEntityEnabled',
  description: 'Enable or disable an entity (disabled entities are skipped by the runtime).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    enabled: z.boolean(),
  }),
  async run(ctx, params) {
    const scene = requireScene(ctx, params.scene);
    const entity = requireEntity(scene, params.entity);
    entity.enabled = params.enabled;
    ctx.changed({ kind: 'entity', id: entity.id, name: entity.name, scene: scene.id, action: 'modified' });
    return { entityId: entity.id, enabled: entity.enabled };
  },
});

export const setEntityTags = defineCommand({
  name: 'setEntityTags',
  description: 'Replace the tags of an entity (tags support script queries like scene.findByTag).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    tags: z.array(z.string()),
  }),
  async run(ctx, params) {
    const scene = requireScene(ctx, params.scene);
    const entity = requireEntity(scene, params.entity);
    entity.tags = params.tags;
    ctx.changed({ kind: 'entity', id: entity.id, name: entity.name, scene: scene.id, action: 'modified' });
    return { entityId: entity.id, tags: entity.tags };
  },
});
