import { z } from 'zod';
import { defineCommand } from './types.js';
import { findEntity, childrenOf } from '../schema/scene.js';
import { COMPONENT_DOCS, COMPONENT_ENUMS, COMPONENT_SCHEMAS, COMPONENT_TYPES } from '../schema/components.js';
import { validateProject } from '../validate.js';
import { ProjectError, readJson } from '../project/store.js';
import { joinPath } from '../fs.js';
import { PrefabDataSchema, type Asset } from '../schema/project.js';
import { CTX_API } from '../ctxApi.js';
import { collectNavSolids, buildNavGrid, findPath } from '../pathfinding.js';
import type { Scene } from '../schema/scene.js';
import type { CommandContext } from './types.js';

/**
 * Best-effort prefab summary for inspectAssets: entity count and the root
 * entity's component types, read fresh from the payload file. Returns
 * `undefined` (rather than throwing) when the file is missing or invalid —
 * validateProject is the source of truth for flagging that as an error.
 */
async function summarizePrefabAsset(
  ctx: CommandContext,
  asset: Asset,
): Promise<{ entityCount: number; rootComponents: string[] } | undefined> {
  try {
    const raw = await readJson(ctx.fs, joinPath(ctx.store.root, asset.path));
    const parsed = PrefabDataSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const root = parsed.data.entities[0];
    return {
      entityCount: parsed.data.entities.length,
      rootComponents: root ? Object.keys(root.components) : [],
    };
  } catch {
    return undefined;
  }
}

/** Helper: sum up Transform.position up the parent chain to get world position. */
function getWorldPosition(scene: Scene, entityId: string): { x: number; y: number } {
  let pos = { x: 0, y: 0 };
  let currentId: string | null = entityId;
  const visited = new Set<string>();
  while (currentId) {
    if (visited.has(currentId)) break; // cycle protection
    visited.add(currentId);
    const entity = scene.entities.find((e) => e.id === currentId);
    if (!entity) break;
    const transform = entity.components.Transform;
    if (transform) {
      pos.x += transform.position.x;
      pos.y += transform.position.y;
    }
    currentId = entity.parentId;
  }
  return pos;
}

export const inspectProject = defineCommand({
  name: 'inspectProject',
  description: 'Get project metadata: name, scenes, asset/script counts, input actions, build settings.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({}),
  async run(ctx) {
    const scripts = await ctx.store.listScripts();
    return {
      id: ctx.store.project.id,
      name: ctx.store.project.name,
      description: ctx.store.project.description,
      hearthVersion: ctx.store.project.hearthVersion,
      formatVersion: ctx.store.project.formatVersion,
      initialScene: ctx.store.project.initialScene,
      scenes: ctx.store.project.scenes.map((s) => ({
        id: s.id,
        name: s.name,
        path: s.path,
        entityCount: ctx.store.scenes.get(s.id)?.entities.length ?? 0,
      })),
      assetCount: ctx.store.assets.assets.length,
      scriptCount: scripts.length,
      playtestCount: ctx.store.playtests.size,
      inputActions: ctx.store.project.inputMappings.actions,
      // Full mappings (gamepadButtons/gamepadAxes/axes/deadzone) alongside the
      // back-compat inputActions key above — the editor's Input settings
      // panel needs the whole shape, not just the keyboard actions slice.
      inputMappings: ctx.store.project.inputMappings,
      buildSettings: ctx.store.project.buildSettings,
    };
  },
});

export const listScenes = defineCommand({
  name: 'listScenes',
  description: 'List all scenes with ids, names, and entity counts.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({}),
  async run(ctx) {
    return {
      initialScene: ctx.store.project.initialScene,
      scenes: ctx.store.project.scenes.map((s) => ({
        id: s.id,
        name: s.name,
        path: s.path,
        entityCount: ctx.store.scenes.get(s.id)?.entities.length ?? 0,
        isInitial: s.id === ctx.store.project.initialScene,
      })),
    };
  },
});

export const inspectScene = defineCommand({
  name: 'inspectScene',
  description:
    'Get a scene with its entity hierarchy. Set full=true to include all component data (default: summary per entity).',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    scene: z.string().min(1),
    full: z.boolean().default(false),
  }),
  async run(ctx, params) {
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');

    const summarize = (e: (typeof scene.entities)[number]) => ({
      id: e.id,
      name: e.name,
      parentId: e.parentId,
      enabled: e.enabled,
      tags: e.tags,
      components: params.full ? e.components : Object.keys(e.components),
      position: e.components.Transform?.position ?? null,
      children: childrenOf(scene, e.id).map((c) => c.id),
    });

    return {
      id: scene.id,
      name: scene.name,
      isInitial: scene.id === ctx.store.project.initialScene,
      entityCount: scene.entities.length,
      entities: scene.entities.map(summarize),
    };
  },
});

export const inspectEntity = defineCommand({
  name: 'inspectEntity',
  description: 'Get one entity with full component data.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
  }),
  async run(ctx, params) {
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');
    const entity = findEntity(scene, params.entity);
    if (!entity) throw new ProjectError(`Entity not found: ${params.entity}`, 'NOT_FOUND');
    return {
      sceneId: scene.id,
      sceneName: scene.name,
      ...entity,
      children: childrenOf(scene, entity.id).map((c) => ({ id: c.id, name: c.name })),
    };
  },
});

export const inspectComponents = defineCommand({
  name: 'inspectComponents',
  description:
    'List all available component types with docs and default values. Use this before addComponent if unsure of properties.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({}),
  async run() {
    return {
      components: COMPONENT_TYPES.map((type) => ({
        type,
        description: COMPONENT_DOCS[type],
        defaults: COMPONENT_SCHEMAS[type].parse({}),
        enums: COMPONENT_ENUMS[type] ?? {},
      })),
    };
  },
});

export const inspectAssets = defineCommand({
  name: 'inspectAssets',
  description: 'List all assets (id, name, type, path, metadata).',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    type: z.string().optional(),
  }),
  async run(ctx, params) {
    let assets = ctx.store.assets.assets;
    if (params.type) assets = assets.filter((a) => a.type === params.type);
    const summarized = await Promise.all(
      assets.map(async (asset) => {
        if (asset.type !== 'prefab') return asset;
        const prefab = await summarizePrefabAsset(ctx, asset);
        return prefab ? { ...asset, prefab } : asset;
      }),
    );
    return { count: assets.length, assets: summarized };
  },
});

export const inspectScripts = defineCommand({
  name: 'inspectScripts',
  description: 'List all script files, with attachment info (which entities use them).',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({}),
  async run(ctx) {
    const paths = await ctx.store.listScripts();
    const attachments: Record<string, { scene: string; entity: string; entityName: string }[]> = {};
    for (const [sceneId, scene] of ctx.store.scenes) {
      for (const e of scene.entities) {
        const sp = e.components.Script?.scriptPath;
        if (sp) {
          (attachments[sp] ??= []).push({ scene: sceneId, entity: e.id, entityName: e.name });
        }
      }
    }
    return {
      scripts: paths.map((path) => ({ path, attachedTo: attachments[path] ?? [] })),
    };
  },
});

export const readScript = defineCommand({
  name: 'readScript',
  description: 'Read the source of a script file (project-relative path).',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({ path: z.string().min(1) }),
  async run(ctx, params) {
    const scripts = await ctx.store.listScripts();
    if (!scripts.includes(params.path)) {
      throw new ProjectError(
        `Script not found: ${params.path}. Known scripts: ${scripts.join(', ') || '(none)'}`,
        'NOT_FOUND',
      );
    }
    const source = await ctx.store.readScript(params.path);
    return { path: params.path, source, lines: source.split('\n').length };
  },
});

export const inspectApi = defineCommand({
  name: 'inspectApi',
  description:
    'Machine-readable reference for the script ctx API: every method and property, with signatures and Lua + JS examples.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({}),
  async run() {
    return {
      api: CTX_API,
      languages: ['lua', 'js'],
      notes: [
        'Lua scripts call ctx with a dot, not a colon: ctx.log("hi"), never ctx:log("hi").',
        'ctx.random (and Lua math.random) is seeded and deterministic: the same seed produces the same sequence, so playtests are reproducible. Never use wall-clock time or Math.random for gameplay.',
      ],
    };
  },
});

export const validateProjectCommand = defineCommand({
  name: 'validateProject',
  description: 'Validate the whole project: schemas, references, cameras, scripts, assets, playtests.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({}),
  async run(ctx) {
    const report = await validateProject(ctx.store);
    if (!report.valid) {
      ctx.suggest('inspectScene <scene> to locate issues', 'fix issues then validateProject again');
    }
    return report;
  },
});

export const inspectPath = defineCommand({
  name: 'inspectPath',
  description:
    'Find a walkable grid path between two world points in a scene (A* over solid tilemaps and static colliders). Read-only; uses authored entity positions.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    scene: z.string().min(1),
    from: z.object({ x: z.number(), y: z.number() }),
    to: z.object({ x: z.number(), y: z.number() }),
    diagonals: z.boolean().default(false),
  }),
  async run(ctx, params) {
    // Resolve scene by id or name (mirror inspectScene's lookup + unknown-scene error).
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');

    // Map entities → NavEntityInput: bodyType from components.PhysicsBody?.bodyType ?? 'static'.
    // World position per entity = sum of Transform.position up the parent chain.
    // Disabled entities are skipped entirely, mirroring SceneRuntime (which never
    // spawns/considers `enabled: false` entities), so an authored-scene path query
    // matches what a live script's ctx.scene.findPath would see.
    const navInputs = scene.entities
      .filter((e) => e.enabled ?? true)
      .map((e) => ({
        position: getWorldPosition(scene, e.id),
        transform: e.components.Transform,
        collider: e.components.Collider,
        tilemap: e.components.Tilemap,
        bodyType: (e.components.PhysicsBody?.bodyType ?? 'static') as 'dynamic' | 'static' | 'kinematic',
      }));

    const { cellSize, solids } = collectNavSolids(navInputs);

    // Build grid; buildNavGrid's only failure mode is an oversized grid, so
    // convert any throw into a command error rather than an internal crash.
    let grid;
    try {
      grid = buildNavGrid({ cellSize, solids, include: [params.from, params.to] });
    } catch (err) {
      throw new ProjectError((err as Error).message, 'INVALID_INPUT');
    }

    const path = findPath(grid, params.from, params.to, { diagonals: params.diagonals });
    return { found: path !== null, path, cells: grid.cols * grid.rows, cellSize };
  },
});
