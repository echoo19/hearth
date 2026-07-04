/**
 * Project-level schemas: hearth.json, assets.json, playtest files.
 */
import { z } from 'zod';

export const FORMAT_VERSION = 1;
export const HEARTH_VERSION = '0.4.0';

export const SceneRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Project-relative path, e.g. "scenes/level_1.scene.json". */
  path: z.string(),
});
export type SceneRef = z.infer<typeof SceneRefSchema>;

export const InputMappingsSchema = z.object({
  /** Action name -> list of KeyboardEvent.code values (e.g. "ArrowLeft", "KeyA", "Space"). */
  actions: z.record(z.string(), z.array(z.string())).default({}),
});
export type InputMappings = z.infer<typeof InputMappingsSchema>;

/**
 * What the player shows while an exported game loads. Neutral by design:
 * shipped games contain zero engine chrome — everything visible is either
 * the user's own scene or these user-controlled loading settings.
 */
export const LoadingSettingsSchema = z.object({
  backgroundColor: z.string().default('#000000'),
  /** Sprite asset id shown centered while loading, or null for none. */
  image: z.string().nullable().default(null),
  /** Show a minimal neutral spinner while loading. */
  spinner: z.boolean().default(false),
});
export type LoadingSettings = z.infer<typeof LoadingSettingsSchema>;

export const BuildSettingsSchema = z.object({
  width: z.number().int().positive().default(800),
  height: z.number().int().positive().default(600),
  backgroundColor: z.string().default('#1a1a2e'),
  targetFps: z.number().int().positive().default(60),
  /** Fixed physics/update timestep in Hz. */
  fixedTimestep: z.number().int().positive().default(60),
  title: z.string().default(''),
  loading: LoadingSettingsSchema.default({}),
});
export type BuildSettings = z.infer<typeof BuildSettingsSchema>;

export const ProjectFileSchema = z.object({
  formatVersion: z.literal(FORMAT_VERSION).default(FORMAT_VERSION),
  hearthVersion: z.string().default(HEARTH_VERSION),
  id: z.string().regex(/^prj_[a-z0-9]+$/),
  name: z.string().min(1),
  description: z.string().default(''),
  /** Scene id of the scene that runs first. */
  initialScene: z.string().nullable().default(null),
  scenes: z.array(SceneRefSchema).default([]),
  inputMappings: InputMappingsSchema.default({ actions: {} }),
  buildSettings: BuildSettingsSchema.default({}),
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export const ASSET_TYPES = ['sprite', 'tile', 'audio', 'animation', 'font', 'data', 'other'] as const;
export const AssetSchema = z.object({
  id: z.string().regex(/^ast_[a-z0-9]+$/),
  name: z.string().min(1),
  type: z.enum(ASSET_TYPES),
  /** Project-relative path, e.g. "assets/sprites/coin.svg". */
  path: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type Asset = z.infer<typeof AssetSchema>;

export const AssetIndexSchema = z.object({
  formatVersion: z.literal(FORMAT_VERSION).default(FORMAT_VERSION),
  assets: z.array(AssetSchema).default([]),
});
export type AssetIndex = z.infer<typeof AssetIndexSchema>;

/** Animation asset payload (stored as the asset's JSON file). */
export const AnimationDataSchema = z.object({
  frames: z.array(z.string()).min(1), // sprite asset ids
  frameDuration: z.number().positive().default(0.15), // seconds per frame
  loop: z.boolean().default(true),
});
export type AnimationData = z.infer<typeof AnimationDataSchema>;

// ---------------------------------------------------------------------------
// Playtests
// ---------------------------------------------------------------------------

const PlaytestStepUnionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wait'), frames: z.number().int().positive() }),
  z.object({
    type: z.literal('press'),
    /** Input action name from project inputMappings. */
    action: z.string(),
    frames: z.number().int().positive().default(1),
  }),
  z.object({ type: z.literal('release'), action: z.string() }),
  z.object({
    type: z.literal('click'),
    /** Screen coordinates in the buildSettings width×height space. */
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal('assertEntityExists'),
    entity: z.string(), // id or name
    exists: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('assertProperty'),
    entity: z.string(),
    /** e.g. "Transform.position.x" */
    property: z.string(),
    equals: z.unknown().optional(),
    greaterThan: z.number().optional(),
    lessThan: z.number().optional(),
  }),
  z.object({
    type: z.literal('assertPositionNear'),
    entity: z.string(),
    x: z.number(),
    y: z.number(),
    tolerance: z.number().positive().default(5),
  }),
  z.object({ type: z.literal('assertNoErrors') }),
  z.object({
    type: z.literal('assertScene'),
    /** Expected current scene id or name (after any ctx.scenes.load switches). */
    scene: z.string(),
  }),
  z.object({
    type: z.literal('assertParticleCount'),
    entity: z.string(), // id or name; must have a ParticleEmitter
    equals: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    type: z.literal('assertEventCount'),
    event: z.string().min(1),
    equals: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
]);

export const PlaytestStepSchema = PlaytestStepUnionSchema.superRefine((step, ctx) => {
  if (
    step.type === 'assertParticleCount' &&
    step.equals === undefined &&
    step.min === undefined &&
    step.max === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assertParticleCount requires at least one of equals, min, or max',
    });
  }
  if (
    step.type === 'assertEventCount' &&
    step.equals === undefined &&
    step.min === undefined &&
    step.max === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assertEventCount requires at least one of equals, min, or max',
    });
  }
});
export type PlaytestStep = z.infer<typeof PlaytestStepSchema>;

export const PlaytestSchema = z.object({
  formatVersion: z.literal(FORMAT_VERSION).default(FORMAT_VERSION),
  id: z.string().regex(/^ptt_[a-z0-9]+$/),
  name: z.string().min(1),
  /** Scene id or name to run. */
  scene: z.string(),
  steps: z.array(PlaytestStepSchema).default([]),
  /** Hard stop so playtests always terminate. */
  maxFrames: z.number().int().positive().default(600),
  /** Seed for ctx.random / Lua math.random — same seed, same run. */
  seed: z.number().int().nonnegative().default(0),
});
export type Playtest = z.infer<typeof PlaytestSchema>;

// ---------------------------------------------------------------------------
// Well-known project paths
// ---------------------------------------------------------------------------

export const PROJECT_FILE = 'hearth.json';
export const ASSET_INDEX_FILE = 'assets.json';
export const SCENES_DIR = 'scenes';
export const ASSETS_DIR = 'assets';
export const SCRIPTS_DIR = 'scripts';
export const PLAYTESTS_DIR = 'playtests';
export const HEARTH_DIR = '.hearth';
export const BASELINE_FILE = '.hearth/baseline.json';
export const AGENT_CONFIG_FILE = '.hearth/agent-config.json';
