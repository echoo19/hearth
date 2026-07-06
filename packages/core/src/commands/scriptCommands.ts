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
 *   ctx.scenes.current              - current scene { id, name }
 *   ctx.scenes.list()               - all scenes as { id, name }
 *   ctx.scenes.load(idOrName)       - switch scene at end of frame (false if unknown)
 *   ctx.timers.after(seconds, fn)   - run fn once; returns a cancel id
 *   ctx.timers.every(seconds, fn)   - run fn repeatedly; returns a cancel id
 *   ctx.timers.cancel(id)           - cancel a timer
 *   ctx.tweens.to(path, target, seconds, opts) - tween a numeric component
 *       property, e.g. ctx.tweens.to('Transform.position.x', 400, 0.5,
 *       { easing: 'easeOut' }); returns a cancel id
 *   ctx.tweens.cancel(id)           - cancel a tween
 *   ctx.random.next()               - seeded deterministic [0, 1)
 *   ctx.random.range(min, max)      - seeded float in [min, max)
 *   ctx.random.int(min, max)        - seeded integer, inclusive
 *   ctx.particles.burst(count)      - spawn count particles now (needs ParticleEmitter)
 *   ctx.particles.count()           - live particle count (needs ParticleEmitter)
 *   ctx.animate(assetRef)           - switch SpriteAnimator to an animation asset, restart at frame 0
 *   ctx.save(key, value)            - persistent save data (JSON values)
 *   ctx.load(key)                   - read saved data (null when absent)
 *   ctx.clearSave(key?)             - clear one key (no key = clear all)
 *   ctx.camera.getPosition() / .setPosition(x, y) - main camera position
 *   ctx.camera.getZoom() / .setZoom(zoom)         - main camera zoom
 *   ctx.camera.follow(idOrName)     - follow an entity each frame (null stops)
 *   ctx.audio.play(assetRef, opts)  - play a sound; returns a handle id
 *       (opts: { volume, loop }); ctx.audio.stop(handleOrAssetRef) stops it
 *   ctx.vars          - per-entity persistent state object
 *   ctx.time          - { elapsed, delta, frame }
 *   ctx.log(...args)  - log to the Hearth console
 *   ctx.collisions    - this entity's current collisions
 *   ctx.isGrounded()  - standing on something?
 *   ctx.destroySelf() - remove this entity
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

  onUiEvent(ctx, event) {
    // Pointer/focus events on this entity's interactive UIElement
    // (event.type: click|press|release|enter|exit|drag|change|focus|blur;
    // event.value is set on "change" — the slider/toggle's new value).
  },
};
`;

export const LUA_SCRIPT_TEMPLATE = `-- {{NAME}} — a Hearth behavior script (Lua).
--
-- IMPORTANT: call ctx with a dot, not a colon: ctx.log("hi"), never ctx:log("hi").
--
-- Lifecycle hooks receive a context (ctx) with:
--   ctx.entity                      - { id, name, tags }
--   ctx.transform                   - live Transform { position, rotation, scale }
--   ctx.getComponent(type)          - live component data (mutable)
--   ctx.params                      - parameters from the Script component
--   ctx.input.isDown(action)        - is an input action held?
--   ctx.input.justPressed(action)   - pressed this frame?
--   ctx.scene.find(name)            - EntityHandle or nil
--   ctx.scene.findByTag(tag)        - list of EntityHandles
--   ctx.scene.spawn(def)            - create an entity at runtime
--   ctx.scene.destroy(idOrHandle)   - remove an entity at runtime
--   ctx.scenes.current              - current scene { id, name }
--   ctx.scenes.list()               - all scenes as { id, name }
--   ctx.scenes.load(idOrName)       - switch scene at end of frame (false if unknown)
--   ctx.timers.after(seconds, fn)   - run fn once; returns a cancel id
--   ctx.timers.every(seconds, fn)   - run fn repeatedly; returns a cancel id
--   ctx.timers.cancel(id)           - cancel a timer
--   ctx.tweens.to(path, target, seconds, opts) - tween a numeric component
--       property, e.g. ctx.tweens.to("Transform.position.x", 400, 0.5,
--       { easing = "easeOut" }); returns a cancel id
--   ctx.tweens.cancel(id)           - cancel a tween
--   ctx.random.next()               - seeded deterministic [0, 1)
--   ctx.random.range(min, max)      - seeded float in [min, max)
--   ctx.random.int(min, max)        - seeded integer, inclusive
--   ctx.particles.burst(count)      - spawn count particles now (needs ParticleEmitter)
--   ctx.particles.count()           - live particle count (needs ParticleEmitter)
--   ctx.animate(assetRef)           - switch SpriteAnimator to an animation asset, restart at frame 0
--   ctx.save(key, value)            - persistent save data (JSON values)
--   ctx.load(key)                   - read saved data (nil when absent)
--   ctx.clearSave(key)              - clear one key (no key = clear all)
--   ctx.camera.getPosition() / ctx.camera.setPosition(x, y) - main camera position
--   ctx.camera.getZoom() / ctx.camera.setZoom(zoom)         - main camera zoom
--   ctx.camera.follow(idOrName)     - follow an entity each frame (nil stops)
--   ctx.audio.play(assetRef, opts)  - play a sound; returns a handle id
--       (opts: { volume = ..., loop = ... }); ctx.audio.stop(handleOrAssetRef) stops it
--   ctx.vars                        - per-entity persistent state table
--   ctx.time                        - { elapsed, delta, frame }
--   ctx.log(...)                    - log to the Hearth console
--   ctx.collisions                  - this entity's current collisions
--   ctx.isGrounded()                - standing on something?
--   ctx.destroySelf()               - remove this entity

local script = {}

function script.onStart(ctx)
  -- Runs once when the scene starts.
end

function script.onUpdate(ctx, dt)
  -- Runs every frame. dt is seconds since last frame.
end

function script.onCollision(ctx, other)
  -- Runs when this entity's collider touches another ("other" is an EntityHandle).
end

function script.onUiEvent(ctx, event)
  -- Pointer/focus events on this entity's interactive UIElement
  -- (event.type: click|press|release|enter|exit|drag|change|focus|blur;
  -- event.value is set on "change" - the slider/toggle's new value).
end

return script
`;

export const createScript = defineCommand({
  name: 'createScript',
  description:
    'Create a new script file in scripts/ from the standard template (or custom source). Lua by default; language "js" for JavaScript. Returns its path.',
  permission: 'code-edit',
  mutates: true,
  paramsSchema: z.object({
    name: z.string().min(1),
    /** Scripting language; Lua is the Hearth default. */
    language: z.enum(['lua', 'js']).default('lua'),
    /** Full source; omit to use the documented template. */
    source: z.string().optional(),
  }),
  async run(ctx, params) {
    const filename = slugify(params.name).replace(/_/g, '-') + '.' + params.language;
    const relPath = joinPath(SCRIPTS_DIR, filename);
    const absPath = joinPath(ctx.store.root, relPath);
    if (await ctx.fs.exists(absPath)) {
      throw new ProjectError(`Script already exists: ${relPath}. Use editScript to modify it.`, 'CONFLICT');
    }
    const template = params.language === 'js' ? SCRIPT_TEMPLATE : LUA_SCRIPT_TEMPLATE;
    const source = params.source ?? template.replace('{{NAME}}', params.name);
    await ctx.fs.writeFile(absPath, source);
    ctx.changed({ kind: 'script', path: relPath, name: params.name, action: 'created' });
    ctx.suggest(`attachScript --scene <scene> --entity <entity> --script ${relPath}`);
    return { path: relPath, language: params.language, lines: source.split('\n').length };
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
        `Script not found: ${params.script}. Known scripts: ${scripts.join(', ') || '(none; use createScript)'}`,
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
