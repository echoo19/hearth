import { z } from 'zod';
import { defineCommand } from './types.js';
import { generateId, slugify } from '../ids.js';
import { ProjectError, writeJson } from '../project/store.js';
import { joinPath } from '../fs.js';
import { STATEMACHINES_DIR, StateMachineDataSchema, type Asset, type StateMachineData } from '../schema/project.js';
import type { CommandContext } from './types.js';

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

/**
 * Every state's `animation` must resolve to an existing `animation` asset —
 * checked here (against the live asset index) rather than in
 * `StateMachineDataSchema`, since the schema has no store to check against.
 */
function requireAnimationAssets(ctx: CommandContext, data: StateMachineData): void {
  for (const state of data.states) {
    const asset = ctx.store.getAsset(state.animation);
    if (!asset || asset.type !== 'animation') {
      throw new ProjectError(
        `State "${state.name}" references an unknown animation asset: ${state.animation}`,
        'ASM_ANIMATION_NOT_FOUND',
      );
    }
  }
}

export const createStateMachineAsset = defineCommand({
  name: 'createStateMachineAsset',
  description:
    'Create an animation state machine asset (params, states, transitions) at assets/statemachines/<slug>.asm.json. ' +
    'Every state.animation must reference an existing animation asset.',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    name: z.string().min(1),
    data: StateMachineDataSchema,
  }),
  async run(ctx, params) {
    requireAnimationAssets(ctx, params.data);

    const relPath = joinPath(STATEMACHINES_DIR, `${slugify(params.name)}.asm.json`);
    const absPath = joinPath(ctx.store.root, relPath);
    if (await ctx.fs.exists(absPath)) {
      throw new ProjectError(`Asset file already exists: ${relPath}`, 'CONFLICT');
    }
    await writeJson(ctx.fs, absPath, params.data);

    const asset = registerAsset(ctx, {
      id: generateId('ast'),
      name: params.name,
      type: 'stateMachine',
      path: relPath,
      metadata: { stateCount: params.data.states.length, transitionCount: params.data.transitions.length },
    });

    return { assetId: asset.id, path: relPath };
  },
});

export const updateStateMachineAsset = defineCommand({
  name: 'updateStateMachineAsset',
  description:
    "Replace a state machine asset's payload document in place (same asset id/path). Every state.animation " +
    'must reference an existing animation asset.',
  permission: 'asset-edit',
  mutates: true,
  paramsSchema: z.object({
    assetId: z.string().min(1),
    data: StateMachineDataSchema,
  }),
  async run(ctx, params) {
    const asset = ctx.store.getAsset(params.assetId);
    if (!asset) throw new ProjectError(`State machine asset not found: ${params.assetId}`, 'NOT_FOUND');
    if (asset.type !== 'stateMachine') {
      throw new ProjectError(`Asset "${params.assetId}" is type ${asset.type}, expected stateMachine`, 'INVALID_INPUT');
    }

    requireAnimationAssets(ctx, params.data);

    const absPath = joinPath(ctx.store.root, asset.path);
    await writeJson(ctx.fs, absPath, params.data);

    asset.metadata = {
      ...asset.metadata,
      stateCount: params.data.states.length,
      transitionCount: params.data.transitions.length,
    };
    ctx.changed({ kind: 'asset', id: asset.id, name: asset.name, path: asset.path, action: 'modified' });

    return { assetId: asset.id };
  },
});
