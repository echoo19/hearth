/**
 * Project-level schemas: hearth.json, assets.json, playtest files.
 */
import { z } from 'zod';
import { POST_EFFECT_TYPES, Vec2Schema, type ComponentMap } from './components.js';
import { EntitySchema } from './scene.js';

export const FORMAT_VERSION = 1;
export const HEARTH_VERSION = '0.11.0';

export const SceneRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Project-relative path, e.g. "scenes/level_1.scene.json". */
  path: z.string(),
});
export type SceneRef = z.infer<typeof SceneRefSchema>;

export const GamepadAxisBindingSchema = z.object({
  axis: z.number().int().min(0),
  direction: z.union([z.literal(1), z.literal(-1)]),
  threshold: z.number().min(0).max(1).default(0.5),
});
export type GamepadAxisBinding = z.infer<typeof GamepadAxisBindingSchema>;

export const VirtualAxisSchema = z.object({
  gamepadAxis: z.number().int().min(0).optional(),
  negativeCodes: z.array(z.string()).default([]),
  positiveCodes: z.array(z.string()).default([]),
  deadzone: z.number().min(0).max(1).optional(),
});
export type VirtualAxis = z.infer<typeof VirtualAxisSchema>;

export const InputMappingsSchema = z.object({
  /** Action name -> list of KeyboardEvent.code values (e.g. "ArrowLeft", "KeyA", "Space"). */
  actions: z.record(z.string(), z.array(z.string())).default({}),
  gamepadButtons: z.record(z.string(), z.array(z.string())).default({}),
  gamepadAxes: z.record(z.string(), GamepadAxisBindingSchema).default({}),
  axes: z.record(z.string(), VirtualAxisSchema).default({}),
  deadzone: z.number().min(0).max(1).default(0.15),
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

/**
 * Fixed Hearth code style (StyLua for Lua, Prettier for JS) — not a build
 * concern, so it's top-level on ProjectFileSchema, siblings with
 * buildSettings rather than nested under it.
 */
export const CodeStyleSchema = z
  .object({
    formatOnSave: z.boolean().default(true),
  })
  .default({ formatOnSave: true });
export type CodeStyle = z.infer<typeof CodeStyleSchema>;

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
  codeStyle: CodeStyleSchema,
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export const ASSET_TYPES = ['sprite', 'tile', 'audio', 'animation', 'prefab', 'font', 'data', 'other'] as const;
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

/**
 * An entity inside a prefab asset: same shape as a scene `Entity`, but ids
 * are local to the prefab (`pfe_<n>`, assigned in BFS order at serialize
 * time) instead of scene-global `ent_*` ids, and the `prefab` marker itself
 * is never carried inside prefab data (nested prefab instances flatten to
 * plain entities on serialize — re-linking them to their own source prefab
 * is a non-goal for wave F).
 */
export const PrefabEntitySchema = EntitySchema.omit({ id: true, parentId: true, prefab: true }).extend({
  id: z.string().regex(/^pfe_[0-9]+$/, 'prefab entity ids look like pfe_1'),
  parentId: z
    .string()
    .regex(/^pfe_[0-9]+$/, 'prefab entity ids look like pfe_1')
    .nullable()
    .default(null),
});
export type PrefabEntity = Omit<z.infer<typeof PrefabEntitySchema>, 'components'> & {
  components: ComponentMap;
};

/** Prefab asset payload (stored as the asset's JSON file). */
export const PrefabDataSchema = z.object({
  name: z.string().min(1),
  entities: z.array(PrefabEntitySchema).min(1), // root first; ids `pfe_<n>`; root.parentId === null
});
export type PrefabData = Omit<z.infer<typeof PrefabDataSchema>, 'entities'> & {
  entities: PrefabEntity[];
};

export const PREFABS_DIR = 'assets/prefabs';

/** Spritesheet frame metadata. */
export const SpritesheetFrameSchema = z.object({
  name: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type SpritesheetFrame = z.infer<typeof SpritesheetFrameSchema>;

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
    type: z.literal('setAxis'),
    /** Virtual axis name from inputMappings.axes; sticky playtest override for ctx.input.axis(). */
    axis: z.string(),
    value: z.number().min(-1).max(1),
    frames: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('click'),
    /** Screen coordinates in the buildSettings width×height space. */
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal('drag'),
    /** Screen coordinates (buildSettings width×height space) for pointer down. */
    from: Vec2Schema,
    /** Screen coordinates for pointer up. */
    to: Vec2Schema,
    /** Interpolated pointer moves between from and to (default 5), one frame each. */
    frames: z.number().int().min(1).optional(),
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
  z.object({
    type: z.literal('assertAudioCount'),
    asset: z.string().optional(),
    action: z.enum(['play', 'stop']).optional(),
    music: z.boolean().optional(),
    equals: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    type: z.literal('assertCameraEffect'),
    effect: z.enum(['shake', 'flash', 'fade', 'zoomPunch']),
    equals: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    type: z.literal('assertFocus'),
    /** Expected focused entity id or name; null asserts nothing is focused. */
    entity: z.string().nullable(),
  }),
  z.object({
    type: z.literal('assertPostEffect'),
    /** Post-effect type to check for on the main camera's postEffects stack. */
    effect: z.enum(POST_EFFECT_TYPES),
    /** true: effect must be present; false: effect must be absent. */
    active: z.boolean().optional(),
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
  if (
    step.type === 'assertAudioCount' &&
    step.equals === undefined &&
    step.min === undefined &&
    step.max === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assertAudioCount requires at least one of equals, min, or max',
    });
  }
  if (
    step.type === 'assertCameraEffect' &&
    step.equals === undefined &&
    step.min === undefined &&
    step.max === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assertCameraEffect requires at least one of equals, min, or max',
    });
  }
  if (step.type === 'assertPostEffect' && step.active === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assertPostEffect requires active (boolean)',
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
export const HISTORY_DIR = '.hearth/history';
/** Trashed asset files, keyed by asset id: `.hearth/trash/<assetId>/<basename>`. */
export const TRASH_DIR = '.hearth/trash';
export const LOG_DIR = '.hearth/log';
/** Append-only command journal: one JSON `JournalEntry` per line (see `project/journal.ts`). */
export const JOURNAL_FILE = '.hearth/log/commands.jsonl';
