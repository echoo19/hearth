/**
 * HearthSession: an open project plus a permission grant, with `execute()`
 * as the single entry point for running commands. Used by the CLI, the MCP
 * server, and the editor's project server.
 */
import { ZodError } from 'zod';
import type { FsLike } from './fs.js';
import { ProjectStore, ProjectError } from './project/store.js';
import { getCommand, listCommands } from './commands/registry.js';
import type { ChangedRef, CommandIssue, CommandResult, RuntimeHooks } from './commands/types.js';
import { hasPermission, PermissionError, type PermissionMode, DEFAULT_MODES } from './permissions.js';

export interface SessionOptions {
  granted?: PermissionMode[];
  runtime?: RuntimeHooks;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class HearthSession {
  private constructor(
    public readonly fs: FsLike,
    public readonly root: string,
    public readonly store: ProjectStore,
    public granted: PermissionMode[],
    private runtime: RuntimeHooks | undefined,
    private onLog: SessionOptions['onLog'],
  ) {}

  static async open(fs: FsLike, root: string, options: SessionOptions = {}): Promise<HearthSession> {
    const store = await ProjectStore.load(fs, root);
    return new HearthSession(fs, root, store, options.granted ?? [...DEFAULT_MODES], options.runtime, options.onLog);
  }

  static fromStore(store: ProjectStore, options: SessionOptions = {}): HearthSession {
    return new HearthSession(
      store.fs,
      store.root,
      store,
      options.granted ?? [...DEFAULT_MODES],
      options.runtime,
      options.onLog,
    );
  }

  listCommands() {
    return listCommands();
  }

  async execute<T = unknown>(name: string, params: unknown = {}): Promise<CommandResult<T>> {
    const errors: CommandIssue[] = [];
    const warnings: CommandIssue[] = [];
    const changed: ChangedRef[] = [];
    const suggestions: string[] = [];
    let files: string[] = [];

    const fail = (code: string, message: string): CommandResult<T> => ({
      success: false,
      command: name,
      data: null,
      errors: [...errors, { code, message }],
      warnings,
      changed,
      files,
      suggestions,
    });

    const def = getCommand(name);
    if (!def) {
      const known = listCommands().map((c) => c.name);
      return fail(
        'UNKNOWN_COMMAND',
        `Unknown command "${name}". Known commands: ${known.join(', ')}`,
      );
    }

    if (!hasPermission(this.granted, def.permission)) {
      const err = new PermissionError(def.permission, this.granted, name);
      return fail('PERMISSION_DENIED', err.message);
    }

    let params2: unknown;
    try {
      params2 = def.paramsSchema.parse(params ?? {});
    } catch (err) {
      if (err instanceof ZodError) {
        const detail = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        return fail('INVALID_PARAMS', `Invalid parameters for ${name}: ${detail}`);
      }
      throw err;
    }

    const ctx = {
      fs: this.fs,
      root: this.root,
      store: this.store,
      granted: this.granted,
      runtime: this.runtime,
      log: (level: 'info' | 'warn' | 'error', message: string) => this.onLog?.(level, message),
      changed: (ref: ChangedRef) => changed.push(ref),
      warn: (code: string, message: string) => warnings.push({ code, message }),
      suggest: (...cmds: string[]) => suggestions.push(...cmds),
    };

    try {
      const data = (await def.run(ctx, params2 as any)) as T;
      if (def.mutates) {
        files = await this.store.save();
      }
      return { success: true, command: name, data, errors, warnings, changed, files, suggestions };
    } catch (err) {
      if (err instanceof ProjectError) {
        return fail(err.code, err.message);
      }
      if (err instanceof ZodError) {
        const detail = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return fail('SCHEMA_ERROR', detail);
      }
      return fail('INTERNAL_ERROR', `${name} failed: ${(err as Error).message}`);
    }
  }
}
