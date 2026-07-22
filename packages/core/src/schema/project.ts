/**
 * Project-level schemas: hearth.json, assets.json, playtest files.
 */
import { z } from 'zod';
import { POST_EFFECT_TYPES, Vec2Schema, type ComponentMap } from './components.js';
import { EntitySchema } from './scene.js';

export const FORMAT_VERSION = 1;
export const HEARTH_VERSION = '1.1.0';

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
  /**
   * Sprite or tile (image) asset id used as the app/window icon for native
   * (desktop) exports, or null for none. Web export ignores it;
   * `exportDesktop` reads the asset's image bytes for the packaged shell's
   * icon conversion, which is agnostic to which of the two types they came
   * from.
   */
  icon: z.string().nullable().default(null),
  /**
   * Pixel-art rendering default for the whole project. When true (the
   * default), textures scale with NEAREST-neighbour filtering so upscaled
   * pixel art stays crisp instead of going blurry (linear). A single asset
   * can override this via its own `pixelArt` flag. Turning it off restores
   * linear filtering everywhere (smoother for photographic/gradient art).
   */
  pixelPerfect: z.boolean().default(true),
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

export const ASSET_TYPES = [
  'sprite',
  'tile',
  'audio',
  'animation',
  'prefab',
  'font',
  'data',
  'other',
  'stateMachine',
] as const;
export const AssetSchema = z.object({
  id: z.string().regex(/^ast_[a-z0-9]+$/),
  name: z.string().min(1),
  type: z.enum(ASSET_TYPES),
  /** Project-relative path, e.g. "assets/sprites/coin.svg". */
  path: z.string(),
  /**
   * Per-asset override of the project's `buildSettings.pixelPerfect` filtering
   * default for this texture. Absent/`null` inherits the project setting;
   * `true` forces NEAREST (crisp pixel art), `false` forces linear (smooth).
   * Only meaningful for image assets (sprite/tile). Left optional (no default)
   * so existing assets round-trip byte-for-byte — the field only appears once
   * an author sets an explicit override.
   */
  pixelArt: z.boolean().nullable().optional(),
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
// State machines
// ---------------------------------------------------------------------------

export const STATE_MACHINE_PARAM_TYPES = ['bool', 'number', 'trigger'] as const;
export const StateMachineParamSchema = z
  .object({
    type: z.enum(STATE_MACHINE_PARAM_TYPES),
    default: z.union([z.boolean(), z.number()]).optional(),
  })
  .strict();
export type StateMachineParam = z.infer<typeof StateMachineParamSchema>;

export const STATE_MACHINE_CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;
/**
 * `op`/`value` are optional at the shape level (a trigger condition is just
 * `{param}`) — whether they're required, and what `op` is allowed, depends
 * on the referenced param's type, so that cross-check lives in
 * `StateMachineDataSchema`'s superRefine (needs the params map for context),
 * not here.
 */
export const StateMachineConditionSchema = z
  .object({
    param: z.string().min(1),
    op: z.enum(STATE_MACHINE_CONDITION_OPS).optional(),
    value: z.union([z.boolean(), z.number()]).optional(),
  })
  .strict();
export type StateMachineCondition = z.infer<typeof StateMachineConditionSchema>;

export const StateMachineStateSchema = z
  .object({
    name: z.string().min(1),
    /** Animation asset id — validated against the asset index at command time (ASM_ANIMATION_NOT_FOUND), not here. */
    animation: z.string().min(1),
    speed: z.number().positive().default(1),
  })
  .strict();
export type StateMachineState = z.infer<typeof StateMachineStateSchema>;

export const StateMachineTransitionSchema = z
  .object({
    /** A state name, or the literal 'any' (matches from every state). */
    from: z.string().min(1),
    to: z.string().min(1),
    conditions: z.array(StateMachineConditionSchema).default([]),
    /** Clip progress (0..1) required before this transition is eligible. */
    exitTime: z.number().min(0).max(1).optional(),
  })
  .strict();
export type StateMachineTransition = z.infer<typeof StateMachineTransitionSchema>;

/** State machine asset payload (stored as the asset's JSON file). */
export const StateMachineDataSchema = z
  .object({
    params: z.record(z.string(), StateMachineParamSchema).default({}),
    states: z.array(StateMachineStateSchema).min(1),
    /** Name of the state the machine starts in. */
    initial: z.string().min(1),
    transitions: z.array(StateMachineTransitionSchema).default([]),
  })
  .strict()
  .superRefine((data, ctx) => {
    const stateNames = new Set<string>();
    data.states.forEach((state, index) => {
      if (stateNames.has(state.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate state name "${state.name}"`,
          path: ['states', index, 'name'],
        });
      }
      stateNames.add(state.name);
    });

    if (!stateNames.has(data.initial)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `initial "${data.initial}" does not name a state`,
        path: ['initial'],
      });
    }

    const paramTypes = new Map(Object.entries(data.params).map(([name, p]) => [name, p.type]));

    data.transitions.forEach((transition, tIndex) => {
      if (transition.from !== 'any' && !stateNames.has(transition.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Transition "from" does not name a state or 'any': "${transition.from}"`,
          path: ['transitions', tIndex, 'from'],
        });
      }
      if (!stateNames.has(transition.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Transition "to" does not name a state: "${transition.to}"`,
          path: ['transitions', tIndex, 'to'],
        });
      }

      transition.conditions.forEach((condition, cIndex) => {
        const paramType = paramTypes.get(condition.param);
        const condPath = ['transitions', tIndex, 'conditions', cIndex] as const;
        if (!paramType) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Condition references unknown param "${condition.param}"`,
            path: [...condPath, 'param'],
          });
          return;
        }
        if (paramType === 'trigger') {
          if (condition.op !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Trigger param "${condition.param}" conditions must be {param} only (no op)`,
              path: [...condPath, 'op'],
            });
          }
          if (condition.value !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Trigger param "${condition.param}" conditions must be {param} only (no value)`,
              path: [...condPath, 'value'],
            });
          }
          return;
        }
        if (condition.op === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Condition on "${condition.param}" requires op`,
            path: [...condPath, 'op'],
          });
        } else if (paramType === 'bool' && condition.op !== 'eq' && condition.op !== 'neq') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `bool param "${condition.param}" conditions only support eq/neq`,
            path: [...condPath, 'op'],
          });
        }
        if (condition.value === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Condition on "${condition.param}" requires value`,
            path: [...condPath, 'value'],
          });
        }
      });

      const hasGate = transition.conditions.length > 0 || transition.exitTime !== undefined;
      if (!hasGate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Transition needs at least one condition or an exitTime',
          path: ['transitions', tIndex],
        });
      }
      if (transition.from === 'any' && transition.conditions.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `from:'any' transitions need at least one condition`,
          path: ['transitions', tIndex, 'conditions'],
        });
      }
    });
  });
export type StateMachineData = z.infer<typeof StateMachineDataSchema>;

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
export const STATEMACHINES_DIR = 'assets/statemachines';

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
    type: z.literal('setAction'),
    /** Input action name from project inputMappings; sticky hold/release, mirrors setAxis. */
    action: z.string(),
    /** true holds the action down until a later setAction releases it; false releases. */
    down: z.boolean(),
    /** Frames to advance after applying (default 1; 0 applies without stepping). */
    frames: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('setPointer'),
    /** Screen coordinates (buildSettings width×height space) the cursor moves to; drives ctx.input.pointer(). */
    x: z.number(),
    y: z.number(),
    /** Optional primary-button state: true presses, false releases; omitted just moves the cursor. */
    down: z.boolean().optional(),
    /** Frames to advance after setting the pointer (default 1), so scripts observe it. */
    frames: z.number().int().min(0).optional(),
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
  z.object({
    type: z.literal('assertPeak'),
    /** Entity id or name. Auto-enables tracing for this entity. */
    entity: z.string(),
    /**
     * 'x'/'y': peak amplitude = max absolute displacement from the entity's
     * first traced position. 'speed': peakSpeed (max per-frame displacement × fps).
     */
    property: z.enum(['x', 'y', 'speed']),
    op: z.enum(['greaterThan', 'lessThan']),
    value: z.number(),
  }),
  z.object({
    type: z.literal('assertRange'),
    /** Entity id or name. Auto-enables tracing for this entity. */
    entity: z.string(),
    property: z.enum(['x', 'y']),
    /** The entity's world position on this axis never leaves [min, max]; either bound optional. */
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    type: z.literal('assertSettledBy'),
    /** Entity id or name. Auto-enables tracing for this entity. */
    entity: z.string(),
    /** From this frame to the end of the run, per-frame displacement stays < epsilon. */
    frame: z.number().int().nonnegative(),
    epsilon: z.number().positive().default(0.1),
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
  if (step.type === 'assertRange' && step.min === undefined && step.max === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assertRange requires at least one of min or max',
    });
  }
});
export type PlaytestStep = z.infer<typeof PlaytestStepSchema>;

/**
 * Opt-in per-frame motion tracing for a playtest. Summaries (envelope, peak
 * speed, settle time) are always cheap and always returned when tracing is
 * on; raw per-frame samples are gated behind `raw` to keep results token-frugal.
 */
export const PlaytestTraceSchema = z.object({
  /** Entity names/ids to trace — explicit list only, no 'all' sugar. */
  entities: z.array(z.string()),
  /** Also trace the active camera's world x/y. */
  camera: z.boolean().optional(),
  /** Include per-frame {frame,x,y} samples in the result (default false). */
  raw: z.boolean().optional(),
});
export type PlaytestTrace = z.infer<typeof PlaytestTraceSchema>;

export const PlaytestSchema = z.object({
  formatVersion: z.literal(FORMAT_VERSION).default(FORMAT_VERSION),
  id: z.string().regex(/^ptt_[a-z0-9]+$/),
  name: z.string().min(1),
  /** Scene id or name to run. */
  scene: z.string(),
  steps: z.array(PlaytestStepSchema).default([]),
  /** Optional per-frame motion tracing; see PlaytestTraceSchema. */
  trace: PlaytestTraceSchema.optional(),
  /** Hard stop so playtests always terminate. */
  maxFrames: z.number().int().positive().default(600),
  /** Seed for ctx.random / Lua math.random — same seed, same run. */
  seed: z.number().int().nonnegative().default(0),
});
export type Playtest = z.infer<typeof PlaytestSchema>;

// ---------------------------------------------------------------------------
// Objectives — shared by sweeps and baked playtests (see bots/objectives.ts)
// ---------------------------------------------------------------------------

/**
 * Declared success/failure criteria for a bot run. `entity` defaults to the
 * avatar when omitted. Objectives are evaluated per frame post-step; see the
 * playtest package for evaluation and verdict precedence.
 */
export const ObjectiveSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('reach'),
    target: z.union([z.string(), Vec2Schema]),
    entity: z.string().optional(),
    tolerance: z.number().positive().default(24),
  }),
  z.object({
    type: z.literal('survive'),
    /** Alive and enabled through this frame. */
    frames: z.number().int().positive(),
    entity: z.string().optional(),
  }),
  z.object({
    type: z.literal('event'),
    /** Checked against session.eventCounts. */
    event: z.string().min(1),
    count: z.number().int().positive().default(1),
  }),
  z.object({
    type: z.literal('property'),
    entity: z.string(),
    property: z.string(),
    equals: z.unknown().optional(),
    greaterThan: z.number().optional(),
    lessThan: z.number().optional(),
  }),
]).superRefine((objective, ctx) => {
  if (
    objective.type === 'property' &&
    objective.equals === undefined &&
    objective.greaterThan === undefined &&
    objective.lessThan === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'property objective requires at least one of equals, greaterThan, or lessThan',
    });
  }
});
export type Objective = z.infer<typeof ObjectiveSchema>;

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
/**
 * Engine-generated state digest (see `project/digest.ts`): a compact, always-current
 * markdown snapshot regenerated after every mutating command. Derived state — gitignored.
 */
export const DIGEST_FILE = '.hearth/digest.md';
/**
 * Agent-managed durable memory (see `project/memory.ts`): decisions, todos, and gotchas
 * that survive across sessions. Authored intent — committed, not gitignored.
 */
export const MEMORY_FILE = '.hearth/memory.md';
