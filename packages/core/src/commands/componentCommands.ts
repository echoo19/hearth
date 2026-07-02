import { z } from 'zod';
import { defineCommand } from './types.js';
import { findEntity } from '../schema/scene.js';
import {
  COMPONENT_SCHEMAS,
  COMPONENT_TYPES,
  createComponent,
  isComponentType,
} from '../schema/components.js';
import { ProjectError } from '../project/store.js';

function resolve(ctx: any, sceneRef: string, entityRef: string) {
  const scene = ctx.store.getScene(sceneRef);
  if (!scene) throw new ProjectError(`Scene not found: ${sceneRef}`, 'NOT_FOUND');
  const entity = findEntity(scene, entityRef);
  if (!entity) throw new ProjectError(`Entity not found in scene "${scene.name}": ${entityRef}`, 'NOT_FOUND');
  return { scene, entity };
}

export const addComponent = defineCommand({
  name: 'addComponent',
  description:
    'Add a component to an entity with schema defaults plus optional property overrides.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    type: z.string().min(1),
    properties: z.record(z.string(), z.unknown()).default({}),
  }),
  async run(ctx, params) {
    const { scene, entity } = resolve(ctx, params.scene, params.entity);
    if (!isComponentType(params.type)) {
      throw new ProjectError(
        `Unknown component type "${params.type}". Valid types: ${COMPONENT_TYPES.join(', ')}`,
        'INVALID_INPUT',
      );
    }
    if ((entity.components as Record<string, unknown>)[params.type]) {
      throw new ProjectError(
        `Entity "${entity.name}" already has a ${params.type} component. Use setComponentProperty to modify it.`,
        'CONFLICT',
      );
    }
    const component = createComponent(params.type, params.properties);
    (entity.components as Record<string, unknown>)[params.type] = component;
    ctx.changed({ kind: 'component', id: entity.id, name: params.type, scene: scene.id, action: 'created' });
    return { entityId: entity.id, type: params.type, component };
  },
});

export const removeComponent = defineCommand({
  name: 'removeComponent',
  description: 'Remove a component from an entity.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    type: z.string().min(1),
  }),
  async run(ctx, params) {
    const { scene, entity } = resolve(ctx, params.scene, params.entity);
    if (!(params.type in (entity.components as Record<string, unknown>))) {
      throw new ProjectError(`Entity "${entity.name}" has no ${params.type} component`, 'NOT_FOUND');
    }
    if (params.type === 'Transform') {
      ctx.warn('REMOVED_TRANSFORM', 'Removing Transform: the entity will not be positioned or rendered.');
    }
    delete (entity.components as Record<string, unknown>)[params.type];
    ctx.changed({ kind: 'component', id: entity.id, name: params.type, scene: scene.id, action: 'deleted' });
    return { entityId: entity.id, type: params.type };
  },
});

/** Set a nested value by dot path, returning a modified deep copy. */
function setByPath(target: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const copy = structuredClone(target);
  let cursor: Record<string, unknown> = copy;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = cursor[key];
    if (typeof next !== 'object' || next === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
  return copy;
}

export const setComponentProperty = defineCommand({
  name: 'setComponentProperty',
  description:
    'Set a component property by dot path, e.g. property="Transform.position.x", value=100. ' +
    'The full component is re-validated against its schema, so invalid values are rejected.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    /** "<ComponentType>.<path.to.property>" */
    property: z.string().min(1),
    value: z.unknown(),
  }),
  async run(ctx, params) {
    const { scene, entity } = resolve(ctx, params.scene, params.entity);
    const [type, ...pathParts] = params.property.split('.');
    if (!isComponentType(type)) {
      throw new ProjectError(
        `Property must start with a component type (got "${type}"). Example: Transform.position.x`,
        'INVALID_INPUT',
      );
    }
    if (pathParts.length === 0) {
      throw new ProjectError(
        `Property path missing. Example: ${type === 'Transform' ? 'Transform.position.x' : `${type}.<property>`}`,
        'INVALID_INPUT',
      );
    }
    const current = (entity.components as Record<string, unknown>)[type] as
      | Record<string, unknown>
      | undefined;
    if (!current) {
      throw new ProjectError(
        `Entity "${entity.name}" has no ${type} component. Add it first with addComponent.`,
        'NOT_FOUND',
      );
    }
    const updated = setByPath(current, pathParts, params.value);
    const parsed = COMPONENT_SCHEMAS[type].safeParse(updated);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ProjectError(`Invalid value for ${params.property}: ${issues}`, 'SCHEMA_ERROR');
    }
    (entity.components as Record<string, unknown>)[type] = parsed.data;
    ctx.changed({ kind: 'component', id: entity.id, name: type, scene: scene.id, action: 'modified' });
    return {
      entityId: entity.id,
      property: params.property,
      value: params.value,
      component: parsed.data,
    };
  },
});

export const setInputMapping = defineCommand({
  name: 'setInputMapping',
  description:
    'Set the key bindings for an input action, e.g. action="jump", keys=["Space","KeyW"]. Keys are KeyboardEvent.code values.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    action: z.string().min(1),
    /** Empty array removes the action. */
    keys: z.array(z.string()),
  }),
  async run(ctx, params) {
    if (params.keys.length === 0) {
      delete ctx.store.project.inputMappings.actions[params.action];
    } else {
      ctx.store.project.inputMappings.actions[params.action] = params.keys;
    }
    ctx.changed({ kind: 'project', id: ctx.store.project.id, action: 'modified' });
    return { action: params.action, keys: params.keys, actions: ctx.store.project.inputMappings.actions };
  },
});
