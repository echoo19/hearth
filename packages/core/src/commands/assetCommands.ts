import { z } from 'zod';
import { defineCommand } from './types.js';
import { generateId, slugify } from '../ids.js';
import { ProjectError, writeJson } from '../project/store.js';
import { joinPath, basenamePath, isSafeRelativePath } from '../fs.js';
import { ASSETS_DIR, AnimationDataSchema, ASSET_TYPES, type Asset } from '../schema/project.js';
import {
  generateSpriteSvg,
  generateTileSvg,
  resolveColor,
  SPRITE_SHAPES,
  type SpriteShape,
} from '../assets/procedural.js';
import { generateSoundWav, SOUND_PRESETS } from '../assets/sounds.js';

function registerAsset(ctx: any, asset: Asset): Asset {
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

const EXT_TO_TYPE: Record<string, Asset['type']> = {
  png: 'sprite',
  jpg: 'sprite',
  jpeg: 'sprite',
  gif: 'sprite',
  webp: 'sprite',
  svg: 'sprite',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  ttf: 'font',
  otf: 'font',
  woff2: 'font',
  json: 'data',
};

export const importAsset = defineCommand({
  name: 'importAsset',
  description:
    'Import an external file into the project assets/ directory and register it in the asset index.',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    /** Source path (absolute, or relative to project root). */
    sourcePath: z.string().min(1),
    name: z.string().optional(),
    type: z.enum(ASSET_TYPES).optional(),
  }),
  async run(ctx, params) {
    if (!(await ctx.fs.exists(params.sourcePath))) {
      throw new ProjectError(`Source file not found: ${params.sourcePath}`, 'NOT_FOUND');
    }
    const filename = basenamePath(params.sourcePath);
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const type = params.type ?? EXT_TO_TYPE[ext] ?? 'other';
    const name = params.name ?? filename.replace(/\.[^.]+$/, '');
    const relPath = joinPath(ASSETS_DIR, type === 'sprite' ? 'sprites' : type, filename);
    const destPath = joinPath(ctx.store.root, relPath);
    if (await ctx.fs.exists(destPath)) {
      throw new ProjectError(`Destination already exists: ${relPath}`, 'CONFLICT');
    }
    await ctx.fs.mkdir(joinPath(ctx.store.root, ASSETS_DIR, type === 'sprite' ? 'sprites' : type));
    await ctx.fs.copyFile(params.sourcePath, destPath);
    const asset = registerAsset(ctx, {
      id: generateId('ast'),
      name,
      type,
      path: relPath,
      metadata: { importedFrom: filename },
    });
    return { asset };
  },
});

export const createSpriteAsset = defineCommand({
  name: 'createSpriteAsset',
  description:
    `Create a procedural placeholder sprite (deterministic SVG). Shapes: ${SPRITE_SHAPES.join(', ')}. ` +
    'Colors: hex (#ff8800) or named (red, blue, gold...).',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    name: z.string().min(1),
    shape: z.enum(SPRITE_SHAPES as [SpriteShape, ...SpriteShape[]]).default('rectangle'),
    color: z.string().default('#3498db'),
    width: z.number().int().positive().max(1024).default(32),
    height: z.number().int().positive().max(1024).default(32),
    accentColor: z.string().optional(),
    sides: z.number().int().min(3).max(12).optional(),
    strokeColor: z.string().optional(),
    strokeWidth: z.number().positive().optional(),
    cornerRadius: z.number().min(0).optional(),
  }),
  async run(ctx, params) {
    const svg = generateSpriteSvg({
      shape: params.shape,
      color: resolveColor(params.color),
      width: params.width,
      height: params.height,
      accentColor: params.accentColor ? resolveColor(params.accentColor) : undefined,
      sides: params.sides,
      strokeColor: params.strokeColor ? resolveColor(params.strokeColor) : undefined,
      strokeWidth: params.strokeWidth,
      cornerRadius: params.cornerRadius,
    });
    const relPath = joinPath(ASSETS_DIR, 'sprites', `${slugify(params.name)}.svg`);
    const absPath = joinPath(ctx.store.root, relPath);
    if (await ctx.fs.exists(absPath)) {
      throw new ProjectError(`Asset file already exists: ${relPath}`, 'CONFLICT');
    }
    await ctx.fs.writeFile(absPath, svg);
    const asset = registerAsset(ctx, {
      id: generateId('ast'),
      name: params.name,
      type: 'sprite',
      path: relPath,
      metadata: {
        procedural: true,
        shape: params.shape,
        color: params.color,
        width: params.width,
        height: params.height,
      },
    });
    ctx.suggest(`setComponentProperty --property SpriteRenderer.assetId --value ${asset.id}`);
    return { asset };
  },
});

export const createTileAsset = defineCommand({
  name: 'createTileAsset',
  description: 'Create a procedural tile asset (square SVG with edge shading) for tilemaps.',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    name: z.string().min(1),
    color: z.string().default('#2ecc71'),
    size: z.number().int().positive().max(256).default(32),
  }),
  async run(ctx, params) {
    const svg = generateTileSvg(resolveColor(params.color), params.size);
    const relPath = joinPath(ASSETS_DIR, 'tiles', `${slugify(params.name)}.svg`);
    const absPath = joinPath(ctx.store.root, relPath);
    if (await ctx.fs.exists(absPath)) {
      throw new ProjectError(`Asset file already exists: ${relPath}`, 'CONFLICT');
    }
    await ctx.fs.writeFile(absPath, svg);
    const asset = registerAsset(ctx, {
      id: generateId('ast'),
      name: params.name,
      type: 'tile',
      path: relPath,
      metadata: { procedural: true, color: params.color, size: params.size },
    });
    return { asset };
  },
});

export const createSound = defineCommand({
  name: 'createSound',
  description:
    `Create a procedural sound effect (deterministic 16-bit PCM WAV). Presets: ${SOUND_PRESETS.join(', ')}. ` +
    'The same preset + seed always produces identical audio.',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    name: z.string().min(1),
    preset: z.enum(SOUND_PRESETS),
    seed: z.number().int().min(0).optional(),
  }),
  async run(ctx, params) {
    const seed = params.seed ?? 0;
    const wav = generateSoundWav(params.preset, seed);
    const relPath = joinPath(ASSETS_DIR, 'sounds', `${slugify(params.name)}.wav`);
    const absPath = joinPath(ctx.store.root, relPath);
    if (await ctx.fs.exists(absPath)) {
      throw new ProjectError(`Asset file already exists: ${relPath}`, 'CONFLICT');
    }
    await ctx.fs.writeFile(absPath, wav);
    const asset = registerAsset(ctx, {
      id: generateId('ast'),
      name: params.name,
      type: 'audio',
      path: relPath,
      metadata: { procedural: true, preset: params.preset, seed },
    });
    ctx.suggest(`setComponentProperty --property AudioSource.assetId --value ${asset.id}`);
    return { asset };
  },
});

export const createAnimationAsset = defineCommand({
  name: 'createAnimationAsset',
  description:
    'Create an animation asset from existing sprite assets (frame ids or names, in order).',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    name: z.string().min(1),
    frames: z.array(z.string()).min(1),
    frameDuration: z.number().positive().default(0.15),
    loop: z.boolean().default(true),
  }),
  async run(ctx, params) {
    const frameIds: string[] = [];
    for (const ref of params.frames) {
      const frame = ctx.store.getAsset(ref);
      if (!frame) throw new ProjectError(`Frame asset not found: ${ref}`, 'NOT_FOUND');
      if (frame.type !== 'sprite' && frame.type !== 'tile') {
        throw new ProjectError(`Frame asset "${ref}" is type ${frame.type}, expected sprite/tile`, 'INVALID_INPUT');
      }
      frameIds.push(frame.id);
    }
    const data = AnimationDataSchema.parse({
      frames: frameIds,
      frameDuration: params.frameDuration,
      loop: params.loop,
    });
    const relPath = joinPath(ASSETS_DIR, 'animations', `${slugify(params.name)}.anim.json`);
    const absPath = joinPath(ctx.store.root, relPath);
    if (await ctx.fs.exists(absPath)) {
      throw new ProjectError(`Asset file already exists: ${relPath}`, 'CONFLICT');
    }
    await writeJson(ctx.fs, absPath, data);
    const asset = registerAsset(ctx, {
      id: generateId('anm').replace(/^anm/, 'ast'),
      name: params.name,
      type: 'animation',
      path: relPath,
      metadata: { frameCount: frameIds.length, frameDuration: params.frameDuration, loop: params.loop },
    });
    return { asset, frames: frameIds };
  },
});

export const setAssetMetadata = defineCommand({
  name: 'setAssetMetadata',
  description: 'Merge keys into an asset\'s metadata (set a key to null to delete it).',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    asset: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()),
  }),
  async run(ctx, params) {
    const asset = ctx.store.getAsset(params.asset);
    if (!asset) throw new ProjectError(`Asset not found: ${params.asset}`, 'NOT_FOUND');
    for (const [key, value] of Object.entries(params.metadata)) {
      if (value === null) delete asset.metadata[key];
      else asset.metadata[key] = value;
    }
    ctx.changed({ kind: 'asset', id: asset.id, name: asset.name, action: 'modified' });
    return { asset };
  },
});

export const removeAsset = defineCommand({
  name: 'removeAsset',
  description:
    'Unregister an asset from the index. The file on disk is kept unless deleteFile=true. ' +
    'Fails if any entity still references the asset.',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    asset: z.string().min(1),
    deleteFile: z.boolean().default(false),
  }),
  async run(ctx, params) {
    const asset = ctx.store.getAsset(params.asset);
    if (!asset) throw new ProjectError(`Asset not found: ${params.asset}`, 'NOT_FOUND');

    const references: string[] = [];
    for (const [sceneId, scene] of ctx.store.scenes) {
      for (const e of scene.entities) {
        const c = e.components;
        if (
          c.SpriteRenderer?.assetId === asset.id ||
          c.AudioSource?.assetId === asset.id ||
          Object.values(c.Tilemap?.tileAssets ?? {}).includes(asset.id)
        ) {
          references.push(`${e.name} (${e.id}) in scene ${sceneId}`);
        }
      }
    }
    if (references.length > 0) {
      throw new ProjectError(
        `Asset "${asset.name}" is still referenced by: ${references.join('; ')}. Remove references first.`,
        'CONFLICT',
      );
    }
    ctx.store.assets.assets = ctx.store.assets.assets.filter((a: Asset) => a.id !== asset.id);
    if (params.deleteFile && isSafeRelativePath(asset.path)) {
      await ctx.fs.remove(joinPath(ctx.store.root, asset.path));
    }
    ctx.changed({ kind: 'asset', id: asset.id, name: asset.name, path: asset.path, action: 'deleted' });
    return { assetId: asset.id, fileDeleted: params.deleteFile };
  },
});
