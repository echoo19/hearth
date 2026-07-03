/**
 * The command system: every editor, CLI, and MCP operation is a named,
 * schema-validated command executed against a shared context. This is the
 * single choke point that makes Hearth legible to agents — one operation
 * vocabulary everywhere.
 */
import type { z } from 'zod';
import type { FsLike } from '../fs.js';
import type { ProjectStore } from '../project/store.js';
import type { PermissionMode } from '../permissions.js';

export interface ChangedRef {
  kind: 'project' | 'scene' | 'entity' | 'component' | 'asset' | 'script' | 'playtest' | 'file';
  id?: string;
  name?: string;
  path?: string;
  /** Scene id, for entity/component changes. */
  scene?: string;
  action: 'created' | 'modified' | 'deleted';
}

export interface CommandIssue {
  code: string;
  message: string;
}

export interface CommandResult<T = unknown> {
  success: boolean;
  command: string;
  data: T | null;
  errors: CommandIssue[];
  warnings: CommandIssue[];
  changed: ChangedRef[];
  /** Project-relative files written by this command. */
  files: string[];
  /** Hints for agents: sensible next commands. */
  suggestions: string[];
}

/**
 * Hooks that let core commands trigger runtime behavior (playtests) without
 * core depending on the runtime package. Injected by CLI / MCP / editor.
 */
export interface RuntimeHooks {
  runPlaytest?(store: ProjectStore, playtestIdOrName: string): Promise<unknown>;
  runSceneSmoke?(store: ProjectStore, sceneIdOrName: string, frames: number): Promise<unknown>;
}

/**
 * Host-provided resources that commands may need but core cannot locate
 * itself (built artifacts shipped outside the project). Injected by
 * CLI / MCP / editor.
 */
export interface CommandResources {
  /**
   * Source of the built web player (hearth-player.js) used by exportWeb.
   * Hosts resolve it from HEARTH_TOOLS_DIR or the runtime package's player/
   * directory; should reject when no bundle can be found.
   */
  getPlayerBundle(): Promise<string>;
}

export interface CommandContext {
  fs: FsLike;
  /** Absolute (or fs-root-relative) path of the open project. */
  root: string;
  store: ProjectStore;
  granted: PermissionMode[];
  runtime?: RuntimeHooks;
  resources?: CommandResources;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** Recorders used by command handlers. */
  changed(ref: ChangedRef): void;
  warn(code: string, message: string): void;
  suggest(...commands: string[]): void;
}

export interface CommandDefinition<P = any, R = any> {
  name: string;
  description: string;
  /** Minimum permission mode required to run. */
  permission: PermissionMode;
  /** Whether the command mutates the project (triggers auto-save). */
  mutates: boolean;
  paramsSchema: z.ZodType<P, any, any>;
  run(ctx: CommandContext, params: P): Promise<R>;
}

export function defineCommand<P, R>(def: CommandDefinition<P, R>): CommandDefinition<P, R> {
  return def;
}
