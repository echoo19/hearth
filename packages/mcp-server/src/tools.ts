/**
 * Tool catalog: maps every MCP tool exposed by the Hearth MCP server to a
 * core command name plus a zod input shape mirroring that command's
 * `paramsSchema`. This is the single source of truth the server registers
 * tools from, so the tool list and the core command registry never drift.
 */
import { z } from 'zod';
import {
  ASSET_TYPES,
  SPRITE_SHAPES,
  SOUND_PRESETS,
  PlaytestStepSchema,
  type PermissionMode,
  type SpriteShape,
} from '@hearth/core';

export interface ToolSpec {
  /** MCP tool name (snake_case). */
  name: string;
  /** Core command name this tool dispatches to. */
  command: string;
  /** Crisp one-liner description (close to the core command's own description). */
  description: string;
  /** Minimum permission mode required to run the underlying command. */
  permission: PermissionMode;
  /** Zod raw shape mirroring the core command's paramsSchema. */
  inputShape: z.ZodRawShape;
}

const positionShape = z.object({ x: z.number(), y: z.number() });

export const TOOL_SPECS: ToolSpec[] = [
  // ---- inspect (read-only) -------------------------------------------------
  {
    name: 'get_project_info',
    command: 'inspectProject',
    description: 'Get project metadata: name, scenes, asset/script counts, input actions, build settings. (requires read-only)',
    permission: 'read-only',
    inputShape: {},
  },
  {
    name: 'list_scenes',
    command: 'listScenes',
    description: 'List all scenes with ids, names, and entity counts. (requires read-only)',
    permission: 'read-only',
    inputShape: {},
  },
  {
    name: 'inspect_scene',
    command: 'inspectScene',
    description:
      'Get a scene with its entity hierarchy. Set full=true to include all component data. (requires read-only)',
    permission: 'read-only',
    inputShape: {
      scene: z.string().min(1),
      full: z.boolean().optional(),
    },
  },
  {
    name: 'inspect_entity',
    command: 'inspectEntity',
    description: 'Get one entity with full component data. (requires read-only)',
    permission: 'read-only',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
    },
  },
  {
    name: 'list_components',
    command: 'inspectComponents',
    description:
      'List all available component types with docs and default values. Use before addComponent if unsure of properties. (requires read-only)',
    permission: 'read-only',
    inputShape: {},
  },
  {
    name: 'list_assets',
    command: 'inspectAssets',
    description: 'List all assets (id, name, type, path, metadata). (requires read-only)',
    permission: 'read-only',
    inputShape: {
      type: z.string().optional(),
    },
  },
  {
    name: 'list_scripts',
    command: 'inspectScripts',
    description: 'List all script files, with attachment info (which entities use them). (requires read-only)',
    permission: 'read-only',
    inputShape: {},
  },
  {
    name: 'read_script',
    command: 'readScript',
    description: 'Read the source of a script file (project-relative path). (requires read-only)',
    permission: 'read-only',
    inputShape: {
      path: z.string().min(1),
    },
  },
  {
    name: 'inspect_api',
    command: 'inspectApi',
    description:
      'Machine-readable reference for the script ctx API: every method and property, with signatures and Lua + JS examples. (requires read-only)',
    permission: 'read-only',
    inputShape: {},
  },
  {
    name: 'validate_project',
    command: 'validateProject',
    description: 'Validate the whole project: schemas, references, cameras, scripts, assets, playtests. (requires read-only)',
    permission: 'read-only',
    inputShape: {},
  },
  {
    name: 'inspect_path',
    command: 'inspectPath',
    description:
      'Find a walkable grid path between two world points in a scene (A* over solid tilemaps and static colliders). Returns waypoints or found=false.',
    permission: 'read-only',
    inputShape: {
      scene: z.string().min(1),
      from: positionShape,
      to: positionShape,
      diagonals: z.boolean().optional(),
    },
  },

  // ---- scenes ---------------------------------------------------------------
  {
    name: 'create_scene',
    command: 'createScene',
    description: 'Create a new scene. Optionally adds a default main camera entity. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      name: z.string().min(1),
      withCamera: z.boolean().optional(),
    },
  },
  {
    name: 'delete_scene',
    command: 'deleteScene',
    description: 'Delete a scene from the project (removes the scene file). (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
    },
  },
  {
    name: 'rename_scene',
    command: 'renameScene',
    description: 'Rename a scene (scene file keeps its path). (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      newName: z.string().min(1),
    },
  },
  {
    name: 'set_initial_scene',
    command: 'setInitialScene',
    description: "Set the project's initial scene (the one that runs first). (requires safe-edit)",
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
    },
  },

  // ---- entities ---------------------------------------------------------------
  {
    name: 'create_entity',
    command: 'createEntity',
    description:
      'Create an entity in a scene. Always gets a Transform. Pass components to add more, e.g. {"SpriteRenderer": {"color": "#ff0000"}}. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      name: z.string().min(1),
      parent: z.string().optional(),
      position: positionShape.optional(),
      tags: z.array(z.string()).optional(),
      components: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    },
  },
  {
    name: 'delete_entity',
    command: 'deleteEntity',
    description: "Delete an entity (children are re-parented to the deleted entity's parent). (requires safe-edit)",
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
    },
  },
  {
    name: 'rename_entity',
    command: 'renameEntity',
    description: 'Rename an entity. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      newName: z.string().min(1),
    },
  },
  {
    name: 'move_entity',
    command: 'moveEntity',
    description:
      'Move an entity: set position (Transform) and/or re-parent it. Position is in scene pixels. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      position: positionShape.optional(),
      parent: z.string().nullable().optional(),
    },
  },

  // ---- components ---------------------------------------------------------------
  {
    name: 'add_component',
    command: 'addComponent',
    description: 'Add a component to an entity with schema defaults plus optional property overrides. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      type: z.string().min(1),
      properties: z.record(z.string(), z.unknown()).optional(),
    },
  },
  {
    name: 'remove_component',
    command: 'removeComponent',
    description: 'Remove a component from an entity. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      type: z.string().min(1),
    },
  },
  {
    name: 'set_component_property',
    command: 'setComponentProperty',
    description:
      'Set a component property by dot path, e.g. property="Transform.position.x", value=100. The full component is re-validated against its schema. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      property: z.string().min(1),
      value: z.unknown(),
    },
  },
  {
    name: 'set_input_mapping',
    command: 'setInputMapping',
    description:
      'Set the key bindings for an input action, e.g. action="jump", keys=["Space","KeyW"]. Empty keys removes the action. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      action: z.string().min(1),
      keys: z.array(z.string()),
    },
  },

  // ---- settings ---------------------------------------------------------------
  {
    name: 'update_settings',
    command: 'updateSettings',
    description:
      'Update project settings: partial buildSettings (deep-merged, incl. the loading screen visuals), the initial scene, and input mappings (each listed action is replaced; empty keys removes it). (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      buildSettings: z
        .object({
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          backgroundColor: z.string().optional(),
          targetFps: z.number().int().positive().optional(),
          fixedTimestep: z.number().int().positive().optional(),
          title: z.string().optional(),
          loading: z
            .object({
              backgroundColor: z.string().optional(),
              image: z.string().nullable().optional(),
              spinner: z.boolean().optional(),
            })
            .optional(),
        })
        .optional(),
      initialScene: z.string().min(1).optional(),
      inputMappings: z.object({ actions: z.record(z.string(), z.array(z.string())) }).optional(),
    },
  },

  // ---- scripts ---------------------------------------------------------------
  {
    name: 'create_script',
    command: 'createScript',
    description:
      'Create a new script file in scripts/ from the standard template (or custom source). Lua by default; language "js" for JavaScript. Returns its path. (requires code-edit)',
    permission: 'code-edit',
    inputShape: {
      name: z.string().min(1),
      language: z.enum(['lua', 'js']).optional(),
      source: z.string().optional(),
    },
  },
  {
    name: 'edit_script',
    command: 'editScript',
    description: 'Replace the full source of an existing script file. (requires code-edit)',
    permission: 'code-edit',
    inputShape: {
      path: z.string().min(1),
      source: z.string(),
    },
  },
  {
    name: 'attach_script',
    command: 'attachScript',
    description:
      'Attach a script to an entity (adds or updates its Script component). Optional params are exposed to the script as ctx.params. (requires code-edit)',
    permission: 'code-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      script: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
    },
  },

  // ---- assets ---------------------------------------------------------------
  {
    name: 'import_asset',
    command: 'importAsset',
    description: 'Import an external file into the project assets/ directory and register it in the asset index. (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      sourcePath: z.string().min(1),
      name: z.string().optional(),
      type: z.enum(ASSET_TYPES).optional(),
    },
  },
  {
    name: 'create_sprite_asset',
    command: 'createSpriteAsset',
    description:
      `Create a procedural placeholder sprite (deterministic SVG). Shapes: ${SPRITE_SHAPES.join(', ')}. Colors: hex or named. (requires asset-edit)`,
    permission: 'asset-edit',
    inputShape: {
      name: z.string().min(1),
      shape: z.enum(SPRITE_SHAPES as [SpriteShape, ...SpriteShape[]]).optional(),
      color: z.string().optional(),
      width: z.number().int().positive().max(1024).optional(),
      height: z.number().int().positive().max(1024).optional(),
      accentColor: z.string().optional(),
      sides: z.number().int().min(3).max(12).optional(),
      strokeColor: z.string().optional(),
      strokeWidth: z.number().positive().optional(),
      cornerRadius: z.number().min(0).optional(),
    },
  },
  {
    name: 'create_tile_asset',
    command: 'createTileAsset',
    description: 'Create a procedural tile asset (square SVG with edge shading) for tilemaps. (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      name: z.string().min(1),
      color: z.string().optional(),
      size: z.number().int().positive().max(256).optional(),
    },
  },
  {
    name: 'create_sound',
    command: 'createSound',
    description:
      `Create a procedural sound effect asset (deterministic 16-bit PCM WAV). Presets: ${SOUND_PRESETS.join(', ')}. Same preset + seed always produces identical audio. (requires asset-edit)`,
    permission: 'asset-edit',
    inputShape: {
      name: z.string().min(1),
      preset: z.enum(SOUND_PRESETS),
      seed: z.number().int().min(0).optional(),
    },
  },
  {
    name: 'create_animation_asset',
    command: 'createAnimationAsset',
    description: 'Create an animation asset from existing sprite assets (frame ids or names, in order). (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      name: z.string().min(1),
      frames: z.array(z.string()).min(1),
      frameDuration: z.number().positive().optional(),
      loop: z.boolean().optional(),
    },
  },
  {
    name: 'slice_spritesheet',
    command: 'sliceSpritesheet',
    description:
      'Slice a spritesheet image into frames with configurable grid spacing. Stores frame metadata in asset.metadata for the player to resolve sheet refs. (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      asset: z.string().min(1),
      frameWidth: z.number().int().positive(),
      frameHeight: z.number().int().positive(),
      margin: z.number().int().nonnegative().optional(),
      spacing: z.number().int().nonnegative().optional(),
      namePrefix: z.string().optional(),
    },
  },
  {
    name: 'create_animation_from_sheet',
    command: 'createAnimationFromSheet',
    description:
      'Create an animation asset from named frames on a sliced spritesheet. Frame refs are written as "<sheetAssetId>#<frameName>". (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      name: z.string().min(1),
      sheet: z.string().min(1),
      frames: z.array(z.string()).min(1),
      frameDuration: z.number().positive().optional(),
      loop: z.boolean().optional(),
    },
  },

  // ---- history (undo/redo) ---------------------------------------------------------------
  {
    name: 'undo',
    command: 'undo',
    description: 'Undo the most recent recorded change (see list_history). (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {},
  },
  {
    name: 'redo',
    command: 'redo',
    description: 'Redo the most recently undone change (see list_history). (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {},
  },
  {
    name: 'list_history',
    command: 'listHistory',
    description:
      'List recorded undo/redo history entries, oldest first, marking which ones are currently undone (redoable). (requires read-only)',
    permission: 'read-only',
    inputShape: {},
  },

  // ---- diff / playtest / build ---------------------------------------------------------------
  {
    name: 'snapshot_project',
    command: 'snapshotProject',
    description:
      'Save the current project state as the diff baseline. Run this BEFORE making changes so the human can review your diff afterwards. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {},
  },
  {
    name: 'get_diff',
    command: 'diffProject',
    description:
      'Structural diff of the current project vs the last snapshot baseline: scenes, entities, components, properties, scripts, assets. (requires read-only)',
    permission: 'read-only',
    inputShape: {},
  },
  {
    name: 'revert_project',
    command: 'revertProject',
    description: 'Restore the project to the last snapshot baseline (undoes all model/script changes since snapshotProject). (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      confirm: z.boolean(),
    },
  },
  {
    name: 'create_playtest',
    command: 'createPlaytest',
    description:
      'Create a playtest definition: a scripted sequence of waits, input presses, and assertions run headlessly against a scene. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      name: z.string().min(1),
      scene: z.string().min(1),
      steps: z.array(PlaytestStepSchema).optional(),
      maxFrames: z.number().int().positive().optional(),
    },
  },
  {
    name: 'list_playtests',
    command: 'listPlaytests',
    description: 'List all playtest definitions. (requires read-only)',
    permission: 'read-only',
    inputShape: {},
  },
  {
    name: 'run_playtest',
    command: 'runPlaytest',
    description:
      'Run a playtest headlessly (simulated frames, scripted inputs, assertions). Returns pass/fail with per-step results. (requires read-only)',
    permission: 'read-only',
    inputShape: {
      playtest: z.string().min(1),
    },
  },
  {
    name: 'run_scene',
    command: 'runScene',
    description:
      'Run a scene headlessly for N frames and report script/runtime errors (a smoke test without assertions). (requires read-only)',
    permission: 'read-only',
    inputShape: {
      scene: z.string().min(1),
      frames: z.number().int().positive().max(36000).optional(),
    },
  },
  {
    name: 'build_project',
    command: 'buildProject',
    description:
      'Validate then export the project to build/: a self-contained copy of all project files plus a build manifest. (requires build)',
    permission: 'build',
    inputShape: {
      outDir: z.string().optional(),
    },
  },
  {
    name: 'export_web',
    command: 'exportWeb',
    description:
      'Export a production web build: a static, self-contained playable page (index.html + player + bundle + assets). ' +
      'singleFile=true inlines everything into one index.html. Validates first. (requires build)',
    permission: 'build',
    inputShape: {
      outDir: z.string().optional(),
      singleFile: z.boolean().optional(),
    },
  },
];
