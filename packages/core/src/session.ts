/**
 * HearthSession: an open project plus a permission grant, with `execute()`
 * as the single entry point for running commands. Used by the CLI, the MCP
 * server, and the editor's project server.
 */
import { ZodError } from 'zod';
import type { FsLike } from './fs.js';
import { ProjectStore, ProjectError, type ProjectSnapshot } from './project/store.js';
import { HistoryStore } from './project/history.js';
import { JournalStore, shouldJournal } from './project/journal.js';
import { HISTORY_EXEMPT } from './commands/historyCommands.js';
import { getCommand, listCommands } from './commands/registry.js';
import type { ChangedRef, CommandIssue, CommandResources, CommandResult, RuntimeHooks } from './commands/types.js';
import { hasPermission, PermissionError, type PermissionMode, DEFAULT_MODES } from './permissions.js';

/**
 * A short human-readable label for a history entry: the command name plus
 * the most identifying string param present, if any (in that priority
 * order — the first one that resolves to a non-empty string wins).
 */
function summarizeCommand(name: string, params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>;
  const candidate = p.name ?? p.id ?? p.scene ?? '';
  const ident = typeof candidate === 'string' ? candidate.trim() : '';
  return ident ? `${name} ${ident}` : name;
}

/**
 * `detail` for the journal entry of a small set of read-only-but-journaled
 * commands: small, defensively-extracted facts, never the full result. Any
 * shape mismatch (missing/wrong-typed field) omits `detail` entirely rather
 * than recording a partial/garbled fact.
 */
function extractJournalDetail(name: string, data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (name === 'runPlaytest') {
    if (typeof d.passed !== 'boolean' || !Array.isArray(d.steps)) return undefined;
    const failures = d.steps.filter((s) => s && typeof s === 'object' && (s as any).passed === false).length;
    return { passed: d.passed, assertions: d.steps.length, failures };
  }
  if (name === 'validateProject') {
    if (!Array.isArray(d.errors) || !Array.isArray(d.warnings)) return undefined;
    return { errors: d.errors.length, warnings: d.warnings.length };
  }
  return undefined;
}

export interface SessionOptions {
  granted?: PermissionMode[];
  runtime?: RuntimeHooks;
  resources?: CommandResources;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Where commands executed through this session originate from, recorded on every journal entry. Defaults to 'unknown'. */
  source?: string;
}

export class HearthSession {
  private constructor(
    public readonly fs: FsLike,
    public readonly root: string,
    public readonly store: ProjectStore,
    public granted: PermissionMode[],
    private runtime: RuntimeHooks | undefined,
    private resources: CommandResources | undefined,
    private onLog: SessionOptions['onLog'],
    private source: string,
  ) {}

  static async open(fs: FsLike, root: string, options: SessionOptions = {}): Promise<HearthSession> {
    const store = await ProjectStore.load(fs, root);
    return new HearthSession(
      fs,
      root,
      store,
      options.granted ?? [...DEFAULT_MODES],
      options.runtime,
      options.resources,
      options.onLog,
      options.source ?? 'unknown',
    );
  }

  static fromStore(store: ProjectStore, options: SessionOptions = {}): HearthSession {
    return new HearthSession(
      store.fs,
      store.root,
      store,
      options.granted ?? [...DEFAULT_MODES],
      options.runtime,
      options.resources,
      options.onLog,
      options.source ?? 'unknown',
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
      resources: this.resources,
      log: (level: 'info' | 'warn' | 'error', message: string) => this.onLog?.(level, message),
      changed: (ref: ChangedRef) => changed.push(ref),
      warn: (code: string, message: string) => warnings.push({ code, message }),
      suggest: (...cmds: string[]) => suggestions.push(...cmds),
    };

    const capturesHistory = def.mutates && !HISTORY_EXEMPT.has(name);
    let before: ProjectSnapshot | undefined;
    if (capturesHistory) {
      before = await this.store.toSnapshot();
    }

    let data: T | undefined;
    let failure: { code: string; message: string } | undefined;

    try {
      data = (await def.run(ctx, params2 as any)) as T;
      if (def.mutates) {
        files = await this.store.save();
      }
      if (capturesHistory && before) {
        // The mutation has already run and been persisted; a broken history
        // store (corrupt index, disk-write failure) must not turn that into
        // a failed result — a retrying caller would duplicate the mutation.
        try {
          const history = new HistoryStore(this.fs, this.root);
          const currentAssetIds = this.store.assets.assets.map((a) => a.id);
          await history.record(name, summarizeCommand(name, params2), before, currentAssetIds);
        } catch (historyErr) {
          warnings.push({
            code: 'HISTORY_RECORD_FAILED',
            message: `Change applied, but recording it to undo history failed: ${(historyErr as Error).message}`,
          });
        }
      }
    } catch (err) {
      if (err instanceof ProjectError) {
        failure = { code: err.code, message: err.message };
      } else if (err instanceof ZodError) {
        const detail = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        failure = { code: 'SCHEMA_ERROR', message: detail };
      } else {
        failure = { code: 'INTERNAL_ERROR', message: `${name} failed: ${(err as Error).message}` };
      }
    }

    // Journal every mutating (or explicitly allowlisted) command, success or
    // failure — never `listJournal` itself. Isolated the same way as history
    // recording above: a broken journal must not turn an applied mutation
    // into a failed result.
    if (name !== 'listJournal' && shouldJournal(name, def.mutates)) {
      try {
        const journal = new JournalStore(this.fs, this.root);
        await journal.append({
          ts: new Date().toISOString(),
          source: this.source,
          command: name,
          summary: summarizeCommand(name, params2),
          ok: !failure,
          error: failure?.code,
          detail: extractJournalDetail(name, data),
        });
      } catch (journalErr) {
        warnings.push({
          code: 'JOURNAL_RECORD_FAILED',
          message: `Command finished, but recording it to the command journal failed: ${(journalErr as Error).message}`,
        });
      }
    }

    if (failure) {
      return fail(failure.code, failure.message);
    }
    return { success: true, command: name, data: data as T, errors, warnings, changed, files, suggestions };
  }
}
