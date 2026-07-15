/**
 * PtyManager: spawns a real pseudo-terminal per project root for the
 * embedded agent panel's terminal (ws.ts multiplexes pty-* frames over the
 * per-project WebSocket channel; see attachWebSocket).
 *
 * Exactly one pty lives per root at a time: starting a new one for a root
 * that already has one kills the old one first (no orphaned processes), and
 * `kill()` is available for explicit teardown (socket close, project
 * switch).
 *
 * SUBSCRIPTION-SAFETY: when `command` is 'claude', this spawns the genuine
 * `claude` binary interactively — PATH-resolved, bare, no arguments. This
 * module must NEVER add `-p`/`--print` or any other flag that would change
 * it from an interactive session, and it never parses or injects into the
 * pty's byte stream beyond raw piping between the child process and the
 * browser terminal. Same rule for the other agent CLIs ('codex', 'opencode',
 * 'hermes'): each runs bare and interactive, PATH-resolved.
 *
 * The pty's environment is whatever the caller passes as `opts.env` (ws.ts
 * hands it a PATH with the `hearth` CLI shim prepended — see hearthShim.ts —
 * so every session finds a working `hearth`); it defaults to process.env.
 */
import os from 'node:os';

export interface PtyBackend {
  spawn(
    file: string,
    args: string[],
    opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
  ): PtyHandle;
}

export interface PtyHandle {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(): void;
}

export type PtyCommand = 'claude' | 'codex' | 'opencode' | 'hermes' | 'shell';

/** Resolve the (file, args) to spawn for a given pty command. No args ever for
 * the agent CLIs: they run bare and interactive, PATH-resolved. */
function resolveCommand(command: PtyCommand): { file: string; args: string[] } {
  if (command === 'shell') {
    const file = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');
    return { file, args: [] };
  }
  return { file: command, args: [] };
}

// ---------------------------------------------------------------------------
// Default backend: real @lydell/node-pty, imported lazily so that browser
// bundles and non-pty test/server paths never load the native module.
// ---------------------------------------------------------------------------

type NodePtyModule = typeof import('@lydell/node-pty');

let nodePtyModulePromise: Promise<NodePtyModule> | null = null;

function loadNodePty(): Promise<NodePtyModule> {
  if (!nodePtyModulePromise) {
    nodePtyModulePromise = import('@lydell/node-pty');
  }
  return nodePtyModulePromise;
}

/**
 * Wraps a promise of a real PtyHandle so `spawn()` can return a PtyHandle
 * synchronously (matching PtyBackend's interface) even though loading the
 * native module is async. Callbacks registered before the real pty exists
 * are queued and attached once it resolves; writes/resizes issued in that
 * window are buffered and flushed in order.
 */
function createLazyHandle(realHandlePromise: Promise<PtyHandle>): PtyHandle {
  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(e: { exitCode: number }) => void> = [];
  const pendingWrites: string[] = [];
  let pendingResize: { c: number; r: number } | null = null;
  let real: PtyHandle | null = null;
  let killedBeforeReady = false;

  realHandlePromise.then(
    (handle) => {
      if (killedBeforeReady) {
        handle.kill();
        return;
      }
      real = handle;
      for (const cb of dataCbs) handle.onData(cb);
      for (const cb of exitCbs) handle.onExit(cb);
      for (const data of pendingWrites) handle.write(data);
      pendingWrites.length = 0;
      if (pendingResize) handle.resize(pendingResize.c, pendingResize.r);
    },
    (err: unknown) => {
      // The pty could never be spawned (e.g. node-pty failed to load, or
      // the binary doesn't exist) — surface it the same way a process exit
      // would, so callers don't need a separate error path.
      const message = err instanceof Error ? err.message : String(err);
      for (const cb of exitCbs) cb({ exitCode: -1 });
      if (exitCbs.length === 0) {
        // No listener yet: at least don't lose the error silently.
        console.error(`[ptyManager] failed to spawn: ${message}`);
      }
    },
  );

  return {
    onData(cb) {
      dataCbs.push(cb);
      if (real) real.onData(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
      if (real) real.onExit(cb);
    },
    write(d) {
      if (real) real.write(d);
      else pendingWrites.push(d);
    },
    resize(c, r) {
      if (real) real.resize(c, r);
      else pendingResize = { c, r };
    },
    kill() {
      if (real) real.kill();
      else killedBeforeReady = true;
    },
  };
}

function createDefaultBackend(): PtyBackend {
  return {
    spawn(file, args, opts) {
      return createLazyHandle(
        loadNodePty().then((nodePty) =>
          nodePty.spawn(file, args, {
            cwd: opts.cwd,
            cols: opts.cols,
            rows: opts.rows,
            env: opts.env,
          }),
        ),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// PtyManager
// ---------------------------------------------------------------------------

export class PtyManager {
  private readonly backend: PtyBackend;
  private readonly ptys = new Map<string, PtyHandle>();

  constructor(backend?: PtyBackend) {
    this.backend = backend ?? createDefaultBackend();
  }

  /** Starts a pty for `root`, killing any existing one for that root first.
   * `opts.env` overrides the child environment (defaults to process.env); ws.ts
   * passes a PATH with the `hearth` shim dir prepended. */
  start(
    root: string,
    command: PtyCommand,
    opts: { cols: number; rows: number; env?: NodeJS.ProcessEnv },
  ): PtyHandle {
    this.kill(root);
    const { file, args } = resolveCommand(command);
    const handle = this.backend.spawn(file, args, {
      cwd: root,
      cols: opts.cols,
      rows: opts.rows,
      env: opts.env ?? process.env,
    });
    this.ptys.set(root, handle);
    handle.onExit(() => {
      if (this.ptys.get(root) === handle) this.ptys.delete(root);
    });
    return handle;
  }

  write(root: string, data: string): void {
    this.ptys.get(root)?.write(data);
  }

  resize(root: string, cols: number, rows: number): void {
    this.ptys.get(root)?.resize(cols, rows);
  }

  kill(root: string): void {
    const handle = this.ptys.get(root);
    if (!handle) return;
    this.ptys.delete(root);
    handle.kill();
  }

  /** Tears down every live pty. Used when the owning http server closes. */
  killAll(): void {
    for (const root of [...this.ptys.keys()]) this.kill(root);
  }
}
