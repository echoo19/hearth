import { z } from 'zod';
import { defineCommand } from './types.js';
import { findEntity } from '../schema/scene.js';
import {
  COMPONENT_SCHEMAS,
  COMPONENT_TYPES,
  createComponent,
  isComponentType,
  type ComponentType,
  type ComponentMap,
} from '../schema/components.js';
import { validateComponentPath } from '../schema/paths.js';
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

/**
 * Validates `pathParts` against `type`'s schema shape, throwing INVALID_INPUT
 * with a did-you-mean suggestion on the first bad segment. Without this, Zod
 * objects silently strip unknown keys, so e.g. `Transform.postiion.x` would
 * "succeed" against a throwaway key and corrupt the write without any error.
 */
function assertValidPath(type: ComponentType, pathParts: string[]): void {
  const check = validateComponentPath(type, pathParts);
  if (check.ok) return;
  const segments = check.failedAt.split('.');
  const badSegment = segments[segments.length - 1];
  const prefixPath = segments.slice(0, -1).join('.');
  const suggestion = check.suggestions.length > 0 ? ` Did you mean "${check.suggestions[0]}"?` : '';
  throw new ProjectError(
    `Unknown property "${badSegment}" on ${prefixPath}.${suggestion} Valid keys: ${check.validKeys.join(', ')}`,
    'INVALID_INPUT',
  );
}

/**
 * Data-aware post-check for discriminated-union array elements (waveG I-1).
 *
 * `validateComponentPath` accepts a path segment if it's valid on ANY member
 * of a discriminated union, because the schema-only path walker has no way to
 * know which member is actually stored at a given array index — that's
 * inherent to validating a *path* against a *schema* before the write
 * happens. So `Camera.postEffects.0.scanlineIntensity` (a crt-only field)
 * passes path validation even when element 0 is a stored bloom. The write
 * then goes through `safeParse`, which resolves the *real* discriminant and
 * silently strips the unknown field per normal Zod object semantics — so the
 * command would report success + a changed component while writing nothing.
 *
 * This walks `pathParts` back through the already-parsed (post-safeParse)
 * data and confirms every segment still resolves. This is a *resolves*
 * check, not a deep-equality check: legitimate writes zod coerces or fills
 * with defaults still resolve (the key exists), so only an actually-stripped
 * key is flagged. When a segment vanishes inside an object that carries a
 * `type` discriminant, the error names the real variant and lists only that
 * variant's own keys, instead of failing on the whole-union's fidelity claim.
 */
function assertWriteResolves(type: ComponentType, pathParts: string[], data: unknown): void {
  let cursor: unknown = data;
  for (let i = 0; i < pathParts.length; i++) {
    const segment = pathParts[i];
    if (cursor === null || typeof cursor !== 'object') {
      // Path validation already confirmed the schema shape; a non-object
      // cursor here means the path legitimately stopped early (wholesale
      // write of a primitive-adjacent value) — nothing further to check.
      return;
    }
    if (Array.isArray(cursor)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return;
      cursor = cursor[idx];
      continue;
    }
    const obj = cursor as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, segment)) {
      const prefixPath = [type, ...pathParts.slice(0, i)].join('.');
      const variant = typeof obj.type === 'string' ? obj.type : undefined;
      if (variant) {
        const validKeys = Object.keys(obj).filter((key) => key !== 'type');
        throw new ProjectError(
          `"${segment}" is not a property of the "${variant}" variant at ${prefixPath}. ` +
            `Valid keys for "${variant}": ${validKeys.join(', ')}.`,
          'INVALID_INPUT',
        );
      }
      throw new ProjectError(
        `Write to ${[type, ...pathParts].join('.')} did not take effect: the value was stripped during schema validation.`,
        'INVALID_INPUT',
      );
    }
    cursor = obj[segment];
  }
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
    assertValidPath(type, pathParts);
    const updated = setByPath(current, pathParts, params.value);
    const parsed = COMPONENT_SCHEMAS[type].safeParse(updated);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ProjectError(`Invalid value for ${params.property}: ${issues}`, 'SCHEMA_ERROR');
    }
    assertWriteResolves(type, pathParts, parsed.data);
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

export const setProperties = defineCommand({
  name: 'setProperties',
  description:
    'Set multiple component properties on one entity in a single undo step, e.g. properties={' +
    '"Transform.position.x": 100, "SpriteRenderer.width": 64}. Keys are "<ComponentType>.<path.to.property>", ' +
    'same as setComponentProperty. All-or-nothing: every key (component type, path shape, and the resulting ' +
    'component schema) is validated before anything is written, and one execute() call records exactly one undo ' +
    'entry for the whole batch. Keys are applied in the order given; when two keys target the same nested path ' +
    'on the same component, the later one wins.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    properties: z
      .record(z.string().min(1), z.unknown())
      .refine((obj) => Object.keys(obj).length > 0, { message: 'properties must have at least one entry' }),
  }),
  async run(ctx, params) {
    const { scene, entity } = resolve(ctx, params.scene, params.entity);

    // Phase 1: validate every key against a per-type clone before writing
    // anything to the entity, so a bad key anywhere fails the whole batch.
    const drafts = new Map<ComponentType, Record<string, unknown>>();
    const writes: Array<{ type: ComponentType; pathParts: string[] }> = [];
    for (const [key, value] of Object.entries(params.properties)) {
      const [type, ...pathParts] = key.split('.');
      if (!isComponentType(type)) {
        throw new ProjectError(
          `Property must start with a component type (got "${type}"). Example: Transform.position.x`,
          'INVALID_INPUT',
        );
      }
      if (pathParts.length === 0) {
        throw new ProjectError(
          `Property path missing for "${key}". Example: ${type === 'Transform' ? 'Transform.position.x' : `${type}.<property>`}`,
          'INVALID_INPUT',
        );
      }
      let draft = drafts.get(type);
      if (!draft) {
        const current = (entity.components as Record<string, unknown>)[type] as
          | Record<string, unknown>
          | undefined;
        if (!current) {
          throw new ProjectError(
            `Entity "${entity.name}" has no ${type} component. Add it first with addComponent.`,
            'NOT_FOUND',
          );
        }
        draft = structuredClone(current);
      }
      assertValidPath(type, pathParts);
      drafts.set(type, setByPath(draft, pathParts, value));
      writes.push({ type, pathParts });
    }

    const parsedByType = new Map<ComponentType, Record<string, unknown>>();
    for (const [type, draft] of drafts) {
      const parsed = COMPONENT_SCHEMAS[type].safeParse(draft);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new ProjectError(`Invalid value for ${type}: ${issues}`, 'SCHEMA_ERROR');
      }
      parsedByType.set(type, parsed.data as Record<string, unknown>);
    }

    // Every written path must still resolve in the final parsed data — a
    // cross-branch discriminated-union write (I-1) would otherwise pass
    // safeParse (Zod strips the unknown field) while reporting success.
    for (const { type, pathParts } of writes) {
      assertWriteResolves(type, pathParts, parsedByType.get(type));
    }

    // Phase 2: every key and every touched component passed validation — write it all.
    for (const [type, data] of parsedByType) {
      (entity.components as Record<string, unknown>)[type] = data;
      ctx.changed({ kind: 'component', id: entity.id, name: type, scene: scene.id, action: 'modified' });
    }

    return {
      entityId: entity.id,
      applied: params.properties,
      components: Object.fromEntries(parsedByType) as Partial<ComponentMap>,
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
