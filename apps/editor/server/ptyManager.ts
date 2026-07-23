/**
 * PtyManager: spawns a real pseudo-terminal per session key for the
 * embedded agent panel's terminal (ws.ts multiplexes pty-* frames over the
 * per-project WebSocket channel; see attachWebSocket).
 *
 * Exactly one pty lives per key at a time: starting a new one for a key
 * that already has one kills the old one first (no orphaned processes), and
 * `kill()` is available for explicit teardown (socket close, project
 * switch).
 *
 * It always spawns the user's platform shell. Users launch `claude`, `codex`,
 * or any other CLI by typing into that shell, so normal shell resolution also
 * handles Windows `.cmd` shims. Hearth never parses or injects into the byte
 * stream beyond raw piping between the child process and browser terminal.
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
  onError(cb: (error: Error) => void): void;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(): void;
}

export function resolveShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } {
  const file = platform === 'win32' ? 'powershell.exe' : env.SHELL || '/bin/bash';
  return { file, args: [] };
}

// ---------------------------------------------------------------------------
// ScrollbackBuffer: the server-side tail of everything a pty emitted, kept so
// a client that reattaches after a socket drop (sleep/wake, network blip) can
// replay what it missed. Mirrors the client-side cap semantics in
// useAgentSocket.ts: appends are cheap (no copy per chunk) because trimming
// only happens once the buffer overshoots the cap by the slack, and every
// trim cuts back to exactly the cap.
// ---------------------------------------------------------------------------

export const SERVER_SCROLLBACK_CAP_BYTES = 200 * 1024;
export const SERVER_SCROLLBACK_TRIM_SLACK_BYTES = 16 * 1024;

export class ScrollbackBuffer {
  private data = '';
  private dropped = 0;

  constructor(
    private readonly cap: number = SERVER_SCROLLBACK_CAP_BYTES,
    private readonly slack: number = SERVER_SCROLLBACK_TRIM_SLACK_BYTES,
  ) {}

  append(chunk: string): void {
    this.data += chunk;
    if (this.data.length > this.cap + this.slack) {
      this.dropped += this.data.length - this.cap;
      this.data = this.data.slice(this.data.length - this.cap);
    }
  }

  /** The buffered tail plus how many earlier bytes the cap already evicted. */
  snapshot(): { data: string; dropped: number } {
    return { data: this.data, dropped: this.dropped };
  }
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
export function createLazyHandle(realHandlePromise: Promise<PtyHandle>): PtyHandle {
  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(e: { exitCode: number }) => void> = [];
  const errorCbs: Array<(error: Error) => void> = [];
  const pendingWrites: string[] = [];
  let pendingResize: { c: number; r: number } | null = null;
  let real: PtyHandle | null = null;
  let killedBeforeReady = false;
  let failure: Error | null = null;

  realHandlePromise.then(
    (handle) => {
      if (killedBeforeReady) {
        handle.kill();
        return;
      }
      real = handle;
      for (const cb of dataCbs) handle.onData(cb);
      for (const cb of exitCbs) handle.onExit(cb);
      for (const cb of errorCbs) handle.onError(cb);
      for (const data of pendingWrites) handle.write(data);
      pendingWrites.length = 0;
      if (pendingResize) handle.resize(pendingResize.c, pendingResize.r);
    },
    (err: unknown) => {
      failure = err instanceof Error ? err : new Error(String(err));
      for (const cb of errorCbs) cb(failure);
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
    onError(cb) {
      errorCbs.push(cb);
      if (failure) cb(failure);
      else if (real) real.onError(cb);
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
        loadNodePty().then((nodePty) => {
          const pty = nodePty.spawn(file, args, {
            cwd: opts.cwd,
            cols: opts.cols,
            rows: opts.rows,
            env: opts.env,
          });
          return {
            onData: (cb) => { pty.onData(cb); },
            onExit: (cb) => { pty.onExit(cb); },
            onError: () => {},
            write: (data) => { pty.write(data); },
            resize: (cols, rows) => { pty.resize(cols, rows); },
            kill: () => { pty.kill(); },
          } satisfies PtyHandle;
        }),
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

  /** Starts a pty for `key`, killing any existing one for that key first.
   * `opts.env` overrides the child environment (defaults to process.env); ws.ts
   * passes a PATH with the `hearth` shim dir prepended. */
  start(
    key: string,
    cwd: string,
    opts: { cols: number; rows: number; env?: NodeJS.ProcessEnv },
  ): PtyHandle {
    this.kill(key);
    const { file, args } = resolveShell(os.platform(), process.env);
    const handle = this.backend.spawn(file, args, {
      cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: opts.env ?? process.env,
    });
    this.ptys.set(key, handle);
    handle.onExit(() => {
      if (this.ptys.get(key) === handle) this.ptys.delete(key);
    });
    handle.onError(() => {
      if (this.ptys.get(key) === handle) this.ptys.delete(key);
    });
    return handle;
  }

  write(key: string, data: string): void {
    this.ptys.get(key)?.write(data);
  }

  resize(key: string, cols: number, rows: number): void {
    this.ptys.get(key)?.resize(cols, rows);
  }

  kill(key: string): void {
    const handle = this.ptys.get(key);
    if (!handle) return;
    this.ptys.delete(key);
    handle.kill();
  }

  /** Tears down every live pty. Used when the owning http server closes. */
  killAll(): void {
    for (const key of [...this.ptys.keys()]) this.kill(key);
  }
}
