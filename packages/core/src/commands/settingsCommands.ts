/**
 * Project settings commands. `updateSettings` is the structured way agents
 * reach buildSettings (including the no-chrome loading visuals), the initial
 * scene, and input mappings — no hand-editing hearth.json.
 */
import { z } from 'zod';
import { defineCommand } from './types.js';
import { ProjectError } from '../project/store.js';
import { BuildSettingsSchema } from '../schema/project.js';

const LoadingSettingsPatchSchema = z.object({
  backgroundColor: z.string().optional(),
  /** Sprite asset id shown centered while loading, or null for none. */
  image: z.string().nullable().optional(),
  spinner: z.boolean().optional(),
});

const BuildSettingsPatchSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  backgroundColor: z.string().optional(),
  targetFps: z.number().int().positive().optional(),
  fixedTimestep: z.number().int().positive().optional(),
  title: z.string().optional(),
  /** Deep-merged: only the loading fields you pass change. */
  loading: LoadingSettingsPatchSchema.optional(),
});

/** Shallow copy without keys whose value is undefined. */
function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export const updateSettings = defineCommand({
  name: 'updateSettings',
  description:
    'Update project settings: partial buildSettings (deep-merged, incl. the loading screen visuals), ' +
    'the initial scene, and input mappings (each listed action is replaced; empty keys removes it).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    /** Partial buildSettings; unspecified fields keep their current values. */
    buildSettings: BuildSettingsPatchSchema.optional(),
    /** Scene id or name that runs first (validated to exist). */
    initialScene: z.string().min(1).optional(),
    inputMappings: z
      .object({
        /** Action name -> KeyboardEvent.code list. Replaced per action; [] removes the action. */
        actions: z.record(z.string(), z.array(z.string())),
      })
      .optional(),
  }),
  async run(ctx, params) {
    const project = ctx.store.project;

    // Validate everything up front so a failure never leaves the in-memory
    // project half-mutated.
    let initialSceneId: string | undefined;
    if (params.initialScene !== undefined) {
      const scene = ctx.store.getScene(params.initialScene);
      if (!scene) throw new ProjectError(`Scene not found: ${params.initialScene}`, 'NOT_FOUND');
      initialSceneId = scene.id;
    }
    let mergedBuildSettings: typeof project.buildSettings | undefined;
    if (params.buildSettings) {
      const { loading, ...rest } = params.buildSettings;
      mergedBuildSettings = BuildSettingsSchema.parse({
        ...project.buildSettings,
        ...definedOnly(rest),
        loading: { ...project.buildSettings.loading, ...definedOnly(loading ?? {}) },
      });
    }

    if (mergedBuildSettings) project.buildSettings = mergedBuildSettings;
    if (initialSceneId !== undefined) project.initialScene = initialSceneId;
    if (params.inputMappings) {
      for (const [action, keys] of Object.entries(params.inputMappings.actions)) {
        if (keys.length === 0) delete project.inputMappings.actions[action];
        else project.inputMappings.actions[action] = keys;
      }
    }

    ctx.changed({ kind: 'project', id: project.id, action: 'modified' });
    return {
      buildSettings: project.buildSettings,
      initialScene: project.initialScene,
      inputActions: project.inputMappings.actions,
    };
  },
});
