/**
 * @hearth/core — the shared heart of the Hearth engine.
 *
 * Everything the editor, CLI, MCP server, and runtime agree on lives here:
 * schemas, the project store, the command system, validation, diffing,
 * permissions, and procedural asset generation.
 *
 * This entry point is browser-safe. Node file access lives in
 * `@hearth/core/node`.
 */

// Schemas & types
export * from './schema/components.js';
export * from './schema/scene.js';
export * from './schema/project.js';
export * from './input/gamepad.js';

// Formatting (fixed Hearth style; deps load lazily via `await import()` so
// this stays safe to include in the browser bundle — see format.ts).
export { formatSource, FormatError, setFormatterModules, type FormatResult } from './format.js';

// Project model
export { ProjectStore, ProjectError, readJson, writeJson, type ProjectSnapshot } from './project/store.js';
export { createProject, DEFAULT_INPUT_ACTIONS, type CreateProjectOptions } from './project/create.js';
export {
  collectSubtree,
  serializePrefab,
  instantiatePrefabData,
  validatePrefabLocalIds,
  type InstantiateOptions,
} from './project/prefabData.js';
export { HistoryStore, type HistoryEntryMeta, type HistoryIndex } from './project/history.js';
export { applySnapshot, type RestoreContext } from './project/restore.js';
export {
  JournalStore,
  shouldJournal,
  JOURNAL_ALLOWLIST,
  JOURNAL_ROTATE_MAX,
  JOURNAL_ROTATE_KEEP,
  type JournalEntry,
} from './project/journal.js';

// Command system
export { COMMANDS, getCommand, listCommands } from './commands/registry.js';
export {
  defineCommand,
  type CommandDefinition,
  type CommandContext,
  type CommandResources,
  type CommandResult,
  type CommandIssue,
  type ChangedRef,
  type RuntimeHooks,
} from './commands/types.js';
export { type WebExportBundle } from './commands/exportCommands.js';
export { HearthSession, extractJournalDetail, type SessionOptions } from './session.js';
export { SCRIPT_TEMPLATE, LUA_SCRIPT_TEMPLATE, resolveScriptsPath } from './commands/scriptCommands.js';
export { HISTORY_EXEMPT } from './commands/historyCommands.js';
export { CTX_API, type CtxApiEntry } from './ctxApi.js';

// Validation & diff
export {
  validateProject,
  checkScriptSource,
  type ValidationReport,
  type ValidationIssue,
  type ScriptDiagnostic,
} from './validate.js';
export {
  diffSnapshots,
  diffValues,
  type ProjectDiff,
  type SceneDiff,
  type EntityDiff,
  type ComponentDiff,
  type PropertyChange,
  type AssetDiffEntry,
  type ScriptDiffEntry,
} from './diff/diff.js';

// Permissions
export {
  PERMISSION_MODES,
  PERMISSION_DOCS,
  DEFAULT_MODES,
  PermissionError,
  hasPermission,
  parseModes,
  type PermissionMode,
} from './permissions.js';

// Procedural assets
export {
  generateSpriteSvg,
  generateTileSvg,
  resolveColor,
  SPRITE_SHAPES,
  NAMED_COLORS,
  type SpriteSpec,
  type SpriteShape,
} from './assets/procedural.js';
export {
  generateSoundWav,
  SOUND_PRESETS,
  SOUND_SAMPLE_RATE,
  type SoundPreset,
} from './assets/sounds.js';
export {
  probeImage,
  type ImageInfo,
} from './assets/imageInfo.js';
export {
  getSheetFrames,
  findSheetFrame,
} from './assets/sheetFrames.js';

// Agent integration files
export { generateAgentsMd, generateClaudeMd, generateAgentConfig } from './agentFiles.js';

// Autotile (blob47 resolver)
export {
  computeMask,
  canonicalMask,
  maskToShape,
  resolveTileFrame,
  resolvedMapping,
  AUTOTILE_SHAPES,
  BLOB47_TEMPLATE,
  type AutotileRule,
} from './tilemap/autotile.js';

// Pathfinding
export {
  collectNavSolids,
  buildNavGrid,
  findPath,
  type NavRect,
  type NavGrid,
  type NavEntityInput,
} from './pathfinding.js';

// Utilities
export {
  generateId,
  slugify,
  setIdRandomSource,
  createSeededRng,
  type IdPrefix,
} from './ids.js';
export {
  type FsLike,
  MemoryFileSystem,
  joinPath,
  dirnamePath,
  basenamePath,
  isSafeRelativePath,
  isSafeOut,
} from './fs.js';
