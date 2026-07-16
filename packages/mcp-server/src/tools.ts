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
  StateMachineDataSchema,
  type PermissionMode,
  type SpriteShape,
  type DesktopPlatform,
} from '@hearth/core';

// Mirrors core's exportCommands.ts DESKTOP_PLATFORMS (not exported from
// @hearth/core, since it's private to the exportDesktop command definition).
const DESKTOP_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'] as const satisfies readonly DesktopPlatform[];

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
    description:
      'Get project metadata: name, scenes, asset/script counts, input actions, build settings, code style. (requires read-only)',
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
  {
    name: 'duplicate_scene',
    command: 'duplicateScene',
    description:
      'Duplicate a scene (all entities get fresh ids). With withPlaytests, also clones every playtest ' +
      'targeting the source scene, retargeted to the copy. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      newName: z.string().min(1),
      withPlaytests: z.boolean().optional(),
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
    name: 'duplicate_entity',
    command: 'duplicateEntity',
    description:
      "Duplicate an entity and its full descendant subtree (fresh ids). The root copy's position is " +
      'offset from the original (default 16,16); descendants keep their relative position. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      newName: z.string().optional(),
      offset: positionShape.optional(),
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
  {
    name: 'set_entity_enabled',
    command: 'setEntityEnabled',
    description: 'Enable or disable an entity (disabled entities are skipped by the runtime). (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      enabled: z.boolean(),
    },
  },
  {
    name: 'set_entity_tags',
    command: 'setEntityTags',
    description:
      "Replace an entity's tags (tags support script queries like scene.findByTag). (requires safe-edit)",
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      tags: z.array(z.string()),
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
    name: 'set_properties',
    command: 'setProperties',
    description:
      'Set multiple component properties on one entity in a single undo step, e.g. properties={' +
      '"Transform.position.x": 100, "SpriteRenderer.width": 64}. Keys are "<ComponentType>.<path.to.property>", ' +
      'same as set_component_property. All-or-nothing: every key is validated (path + resulting schema) before ' +
      'anything is written. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      properties: z.record(z.string(), z.unknown()),
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
      'Update project settings: partial buildSettings (deep-merged, incl. the loading screen visuals), the initial scene, input mappings (actions are replaced per action, empty keys removes one; gamepadButtons/gamepadAxes/axes/deadzone each replace that key wholesale), and codeStyle (deep-merged, e.g. formatOnSave). (requires safe-edit)',
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
      inputMappings: z
        .object({
          actions: z.record(z.string(), z.array(z.string())).optional(),
          gamepadButtons: z.record(z.string(), z.array(z.string())).optional(),
          gamepadAxes: z
            .record(
              z.string(),
              z.object({
                axis: z.number().int().min(0),
                direction: z.union([z.literal(1), z.literal(-1)]),
                threshold: z.number().min(0).max(1).optional(),
              }),
            )
            .optional(),
          axes: z
            .record(
              z.string(),
              z.object({
                gamepadAxis: z.number().int().min(0).optional(),
                negativeCodes: z.array(z.string()).optional(),
                positiveCodes: z.array(z.string()).optional(),
                deadzone: z.number().min(0).max(1).optional(),
              }),
            )
            .optional(),
          deadzone: z.number().min(0).max(1).optional(),
        })
        .optional(),
      codeStyle: z
        .object({
          formatOnSave: z.boolean().optional(),
        })
        .optional(),
    },
  },

  // ---- tilemap ---------------------------------------------------------------
  {
    name: 'paint_tiles',
    command: 'paintTiles',
    description:
      'Paint a batch of tile cells onto a Tilemap component in one undo step. x is the column, y is the row ' +
      '(0-based, row 0 = the top of the grid). char must be "." / " " (empty) or a key of tileAssets. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      cells: z.array(z.object({ x: z.number().int(), y: z.number().int(), char: z.string() })).min(1),
    },
  },
  {
    name: 'fill_tilemap_rect',
    command: 'fillTilemapRect',
    description:
      'Fill a rectangular region of a Tilemap with one tile char in one undo step. x/y is the top-left corner. ' +
      'char must be "." / " " (empty) or a key of tileAssets. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      char: z.string(),
    },
  },
  {
    name: 'resize_tilemap',
    command: 'resizeTilemap',
    description:
      'Resize a Tilemap\'s grid to width x height. Growing pads new cells/rows with "." (empty); shrinking crops ' +
      'from the right and bottom edges. anchor is reserved for future anchor points; only "top-left" exists today. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      width: z.number().int().min(1).max(1024),
      height: z.number().int().min(1).max(1024),
      anchor: z.enum(['top-left']).optional(),
    },
  },
  {
    name: 'set_tile_autotile',
    command: 'setTileAutotile',
    description:
      'Bind a Tilemap tile char to an autotile rule: the char picks its per-cell sheet frame from its 8 ' +
      'neighbours at render time (blob47 47-shape standard). sheet must be a sliced spritesheet whose frames ' +
      'are named blob_<shapeKey>; mapping overrides individual shape keys with custom frame names. Pass ' +
      'clear:true to remove an existing rule for char. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      char: z.string(),
      sheet: z.string().min(1).optional(),
      template: z.literal('blob47').optional(),
      mapping: z.record(z.string(), z.string()).optional(),
      clear: z.boolean().optional(),
    },
  },

  // ---- scripts ---------------------------------------------------------------
  {
    name: 'create_script',
    command: 'createScript',
    description:
      'Create a new script file under scripts/ from the standard template (or custom source). Lua by default; language "js" for JavaScript. Pass dir to create under a subdirectory such as lib. Reformats to Hearth house style on save unless format:false. Returns its path. (requires code-edit)',
    permission: 'code-edit',
    inputShape: {
      name: z.string().min(1),
      dir: z.string().optional(),
      language: z.enum(['lua', 'js']).optional(),
      source: z.string().optional(),
      format: z.boolean().optional(),
    },
  },
  {
    name: 'edit_script',
    command: 'editScript',
    description:
      'Replace the full source of an existing script file. Reformats to Hearth house style on save unless format:false. (requires code-edit)',
    permission: 'code-edit',
    inputShape: {
      path: z.string().min(1),
      source: z.string(),
      format: z.boolean().optional(),
    },
  },
  {
    name: 'format_script',
    command: 'formatScript',
    description:
      "Reformat script(s) to Hearth house style; agents normally don't need this — edit_script formats " +
      'automatically unless format:false. Pass path for one script, or all:true for every .lua/.js under scripts/. (requires code-edit)',
    permission: 'code-edit',
    inputShape: {
      path: z.string().optional(),
      all: z.boolean().optional(),
    },
  },
  {
    name: 'check_script',
    command: 'checkScript',
    description:
      'Check a script for syntax errors without saving it: pass source text directly to check a draft, or ' +
      'path (a scripts/ file) to check an existing project script from disk. Read-only, never writes — ' +
      'pre-flight a script before edit_script. Provide at least one of source or path. (requires read-only)',
    permission: 'read-only',
    inputShape: {
      source: z.string().optional(),
      path: z.string().optional(),
      language: z.enum(['lua', 'js']).optional(),
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
  {
    name: 'search_scripts',
    command: 'searchScripts',
    description:
      'Search script source across scripts/ for a plain-text or regex query, returning 1-based line/column plus ' +
      'a preview (≤120 chars, centered on the match) per hit. Matching is line-based — patterns never span ' +
      'multiple lines. Case-insensitive by default; set caseSensitive:true to narrow. Narrow the file set with ' +
      'pathGlob (e.g. "scripts/enemies/*"). Capped at 500 matches. (requires read-only)',
    permission: 'read-only',
    inputShape: {
      query: z.string().min(1),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      pathGlob: z.string().optional(),
    },
  },
  {
    name: 'replace_in_scripts',
    command: 'replaceInScripts',
    description:
      'Find-and-replace across script files: plain-text or regex query, with $1-style capture-group references ' +
      'in the replacement when regex:true. Matching is line-based. Surgical: results are written verbatim, NOT ' +
      're-formatted — call format_script afterward for cleanup. RECOMMENDED WORKFLOW: call with dryRun:true ' +
      'first to preview per-file counts with nothing written, inspect the result, then call again without ' +
      'dryRun to apply. (requires code-edit)',
    permission: 'code-edit',
    inputShape: {
      query: z.string().min(1),
      replacement: z.string(),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      pathGlob: z.string().optional(),
      dryRun: z.boolean().optional(),
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
    name: 'import_assets',
    command: 'importAssets',
    description:
      'Import multiple external files into the project assets/ directory and register them in one atomic ' +
      'undo/journal step. Every path is validated up front; bad ones are reported in `skipped` (with a code and ' +
      'message) instead of failing the batch. Name/path collisions are auto-suffixed (-2, -3, ...). (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      sourcePaths: z.array(z.string().min(1)).min(1),
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
    name: 'remove_asset',
    command: 'removeAsset',
    description:
      'Unregister an asset from the index. The file on disk is kept unless deleteFile=true. ' +
      'Fails if any entity still references the asset. (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      asset: z.string().min(1),
      deleteFile: z.boolean().optional(),
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
  {
    name: 'create_prefab',
    command: 'createPrefab',
    description:
      "Serialize an entity's full descendant subtree into a reusable prefab asset " +
      '(assets/prefabs/<slug>.prefab.json). The source root entity becomes an instance of the new prefab. (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      name: z.string().min(1),
    },
  },
  {
    name: 'instantiate_prefab',
    command: 'instantiatePrefab',
    description:
      'Instantiate a prefab asset into a scene as a fresh entity subtree (fresh ids), optionally overriding ' +
      "position/name. The new root entity gains a prefab marker linking it back to the asset. (requires asset-edit)",
    permission: 'asset-edit',
    inputShape: {
      prefab: z.string().min(1),
      scene: z.string().min(1),
      position: positionShape.optional(),
      name: z.string().optional(),
    },
  },
  {
    name: 'update_prefab',
    command: 'updatePrefab',
    description:
      "Re-serialize a modified prefab instance's subtree back over the prefab asset's payload file (same path, " +
      'same asset id). The entity must be a marked instance of that exact prefab. (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      prefab: z.string().min(1),
      scene: z.string().min(1),
      entity: z.string().min(1),
    },
  },
  {
    name: 'sync_prefab_instances',
    command: 'syncPrefabInstances',
    description:
      'Merge-sync every marked instance of a prefab (all scenes, or one scene via `scene`) from the current prefab ' +
      "asset payload: each instance keeps its scene ids (new prefab locals get fresh ids, removed locals are " +
      "deleted), preserves its root name/Transform.position/enabled, and re-applies its recorded per-instance " +
      'overrides on top. Stale overrides are dropped. (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      prefab: z.string().min(1),
      scene: z.string().optional(),
    },
  },
  {
    name: 'revert_prefab_override',
    command: 'revertPrefabOverride',
    description:
      'Revert per-instance prefab overrides on an instance member back to the prefab asset values. `entity` may be ' +
      'any member (root or descendant). Scope: `component` + `path` reverts one field; `component` alone reverts all ' +
      "of that component's overrides; neither reverts every override on that entity. A no-op success when nothing " +
      'is overridden. (requires safe-edit)',
    permission: 'safe-edit',
    inputShape: {
      scene: z.string().min(1),
      entity: z.string().min(1),
      component: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
    },
  },

  // ---- state machines ---------------------------------------------------------------
  {
    name: 'create_state_machine_asset',
    command: 'createStateMachineAsset',
    description:
      'Create an animation state machine asset (params/states/transitions) at assets/statemachines/<slug>.asm.json. ' +
      'Every state.animation must reference an existing animation asset. (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      name: z.string().min(1),
      data: StateMachineDataSchema,
    },
  },
  {
    name: 'update_state_machine_asset',
    command: 'updateStateMachineAsset',
    description:
      "Replace a state machine asset's payload document in place (same asset id/path). Every state.animation " +
      'must reference an existing animation asset. (requires asset-edit)',
    permission: 'asset-edit',
    inputShape: {
      assetId: z.string().min(1),
      data: StateMachineDataSchema,
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
  {
    name: 'list_journal',
    command: 'listJournal',
    description:
      'List recorded command journal entries (.hearth/log/commands.jsonl): every mutation plus read-only playtest/validate ' +
      'runs, successes and failures alike, never rewound by undo/redo. Without since, returns the newest `limit` entries; ' +
      'with since, pages forward from that cursor. (requires read-only)',
    permission: 'read-only',
    inputShape: {
      since: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
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
      'singleFile=true inlines everything into one index.html. zip=true also writes <project-slug>-web.zip next to ' +
      'the output folder (itch.io-ready). Validates first. If zip=true but zipping fails after a successful export ' +
      "(disk full, permissions), the result still reports success with the export's outDir/files intact, no data.zip, " +
      'and a ZIP_FAILED entry in warnings. (requires build)',
    permission: 'build',
    inputShape: {
      outDir: z.string().optional(),
      singleFile: z.boolean().optional(),
      zip: z.boolean().optional(),
    },
  },
  {
    name: 'export_desktop',
    command: 'exportDesktop',
    description:
      'Export native desktop builds: wraps the web build in an Electron shell and zips one app per platform ' +
      `(${DESKTOP_PLATFORMS.join(', ')} — all four by default; pass platforms to narrow). Output goes to ` +
      'export/desktop by default. macOS builds are ad-hoc signed unless HEARTH_MAC_IDENTITY is set (real identity), ' +
      'and notarized when HEARTH_APPLE_ID/HEARTH_APPLE_PASSWORD/HEARTH_TEAM_ID are also present; Windows/Linux are ' +
      'never signed. Validates first. (requires build)',
    permission: 'build',
    inputShape: {
      outDir: z.string().optional(),
      platforms: z.array(z.enum(DESKTOP_PLATFORMS)).min(1).optional(),
    },
  },
];
