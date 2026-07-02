import { z } from 'zod';
import { defineCommand } from './types.js';
import { findEntity } from '../schema/scene.js';
import { createComponent } from '../schema/components.js';
import { ProjectError } from '../project/store.js';
import { joinPath, isSafeRelativePath } from '../fs.js';
import { slugify } from '../ids.js';
import { SCRIPTS_DIR } from '../schema/project.js';

export const SCRIPT_TEMPLATE = `/**
 * {{NAME}} — a Hearth behavior script.
 *
 * Lifecycle hooks receive a context (ctx) with:
 *   ctx.entity        - { id, name, tags }
 *   ctx.transform     - live Transform { position, rotation, scale }
 *   ctx.getComponent(type)          - live component data (mutable)
 *   ctx.params        - parameters from the Script component
 *   ctx.input.isDown(action)        - is an input action held?
 *   ctx.input.justPressed(action)   - pressed this frame?
 *   ctx.scene.find(name)            - EntityHandle | null
 *   ctx.scene.findByTag(tag)        - EntityHandle[]
 *   ctx.scene.spawn(def)            - create an entity at runtime
 *   ctx.scene.destroy(idOrHandle)   - remove an entity at runtime
 *   ctx.vars          - per-entity persistent state object
 *   ctx.time          - { elapsed, delta, frame }
 *   ctx.log(...args)  - log to the Hearth console
 */
export default {
  onStart(ctx) {
    // Runs once when the scene starts.
  },

  onUpdate(ctx, dt) {
    // Runs every frame. dt is seconds since last frame.
  },

  onCollision(ctx, other) {
    // Runs when this entity's collider touches another ("other" is an EntityHandle).
  },
};
`;

export const createScript = defineCommand({
  name: 'createScript',
  description:
    'Create a new script file in scripts/ from the standard template (or custom source). Returns its path.',
  permission: 'code-edit',
  mutates: true,
  paramsSchema: z.object({
    name: z.string().min(1),
    /** Full source; omit to use the documented template. */
    source: z.string().optional(),
  }),
  async run(ctx, params) {
    const filename = slugify(params.name).replace(/_/g, '-') + '.js';
    const relPath = joinPath(SCRIPTS_DIR, filename);
    const absPath = joinPath(ctx.store.root, relPath);
    if (await ctx.fs.exists(absPath)) {
      throw new ProjectError(`Script already exists: ${relPath}. Use editScript to modify it.`, 'CONFLICT');
    }
    const source = params.source ?? SCRIPT_TEMPLATE.replace('{{NAME}}', params.name);
    await ctx.fs.writeFile(absPath, source);
    ctx.changed({ kind: 'script', path: relPath, name: params.name, action: 'created' });
    ctx.suggest(`attachScript --scene <scene> --entity <entity> --script ${relPath}`);
    return { path: relPath, lines: source.split('\n').length };
  },
});

export const editScript = defineCommand({
  name: 'editScript',
  description: 'Replace the full source of an existing script file.',
  permission: 'code-edit',
  mutates: true,
  paramsSchema: z.object({
    path: z.string().min(1),
    source: z.string(),
  }),
  async run(ctx, params) {
    if (!isSafeRelativePath(params.path) || !params.path.startsWith(SCRIPTS_DIR + '/')) {
      throw new ProjectError(`Script path must be inside ${SCRIPTS_DIR}/ (got: ${params.path})`, 'INVALID_INPUT');
    }
    const absPath = joinPath(ctx.store.root, params.path);
    if (!(await ctx.fs.exists(absPath))) {
      throw new ProjectError(`Script not found: ${params.path}. Use createScript first.`, 'NOT_FOUND');
    }
    await ctx.fs.writeFile(absPath, params.source);
    ctx.changed({ kind: 'script', path: params.path, action: 'modified' });
    ctx.suggest('validateProject', 'runPlaytest <playtest> to verify behavior');
    return { path: params.path, lines: params.source.split('\n').length };
  },
});

export const attachScript = defineCommand({
  name: 'attachScript',
  description:
    'Attach a script to an entity (adds or updates its Script component). Optional params are exposed to the script as ctx.params.',
  permission: 'code-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    script: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  async run(ctx, params) {
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');
    const entity = findEntity(scene, params.entity);
    if (!entity) throw new ProjectError(`Entity not found: ${params.entity}`, 'NOT_FOUND');

    const scripts = await ctx.store.listScripts();
    if (!scripts.includes(params.script)) {
      throw new ProjectError(
        `Script not found: ${params.script}. Known scripts: ${scripts.join(', ') || '(none — use createScript)'}`,
        'NOT_FOUND',
      );
    }
    entity.components.Script = createComponent('Script', {
      scriptPath: params.script,
      params: params.params,
    }) as typeof entity.components.Script;
    ctx.changed({ kind: 'component', id: entity.id, name: 'Script', scene: scene.id, action: 'modified' });
    return { entityId: entity.id, script: params.script, params: params.params };
  },
});
