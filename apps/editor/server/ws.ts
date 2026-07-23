/**
 * The editor's WebSocket channel, mounted at /api/ws alongside the /api/*
 * HTTP routes (see projectServer.ts). It carries two kinds of frames over
 * the same socket:
 *
 *  - journal: external-change awareness (a CLI/MCP agent mutating the
 *    project makes the editor notice and refresh). Broadcast to every
 *    socket subscribed to that project root.
 *  - pty-*: the embedded project shell spawned via PtyManager. A terminal is per-client,
 *    not broadcast: pty-data/pty-exit/pty-error only ever go back over the
 *    same socket whose pty-start spawned (or reattached) that connection's pty.
 *
 * One socket subscribes to exactly one project (?project=<absolute path> on
 * the upgrade request). Sockets sharing a project root share a single
 * journalWatcher; the watcher is torn down once the last socket for that
 * root disconnects, and all watchers (and all live ptys) are torn down when
 * the http server closes.
 *
 * Pty lifetime is decoupled from socket lifetime: a pty-start carrying a
 * sessionId token survives its socket dropping (sleep/wake, network blips) —
 * the session detaches, buffers output, and a later pty-start with the same
 * token reattaches to it with a pty-attach replay (tmux-style). Explicit
 * teardown (pty-stop, a superseding pty-start on the same socket, server
 * close) still kills, and a linger timeout reaps abandoned detached ptys.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import path from 'node:path';
import { type JournalEntry, type DesktopPlatform, type DesktopBuildResult } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { startJournalWatcher } from './journalWatcher.js';
import { type ProjectServerContext, resolveToolPaths } from './projectServer.js';
import { PtyManager, ScrollbackBuffer, type PtyBackend, type PtyHandle } from './ptyManager.js';
import { ensureHearthShim, hearthPtyEnv } from './hearthShim.js';
import { loginShellPathEnv } from './shellEnv.js';
import { isRequestAllowed } from './originGuard.js';

/** Desktop-packaging stages, mirroring @hearth/shipping's PackageStage. */
export type ExportStage = 'stage' | 'download' | 'package' | 'sign' | 'notarize' | 'zip';

/** Result payload carried by an export-done frame (exportDesktop's data). */
export interface DesktopExportResult {
  outDir: string;
  slug: string;
  builds: DesktopBuildResult[];
}

/**
 * Server->client frames for a running desktop export job (see
 * ctx.startDesktopExport). Progress streams as export-progress, then exactly
 * one terminal frame: export-done on success or export-error on failure. A
 * per-platform failure carries the `platform` it failed on.
 */
export type ExportFrame =
  | { type: 'export-progress'; jobId: string; platform: DesktopPlatform | null; stage: ExportStage; message: string }
  | { type: 'export-done'; jobId: string; result: DesktopExportResult }
  | { type: 'export-error'; jobId: string; platform?: DesktopPlatform; message: string };

export type WsFrame =
  | { type: 'journal'; entries: JournalEntry[] }
  | { type: 'pty-data'; data: string }
  | { type: 'pty-exit'; code: number }
  | { type: 'pty-input'; data: string } // client -> server
  | { type: 'pty-resize'; cols: number; rows: number }
  // sessionId (an unguessable client-generated token) makes the session
  // resumable: if a detached pty with this token is still alive for the same
  // project root, pty-start reattaches to it instead of spawning.
  | { type: 'pty-start'; sessionId?: string }
  | { type: 'pty-stop' } // client -> server: explicit kill (the panel's Stop button)
  | { type: 'pty-error'; message: string }
  // Reply to a pty-start that reattached: `replay` is the server-buffered
  // tail of everything the pty emitted (capped — `dropped` counts evicted
  // earlier bytes), sent before live pty-data streaming resumes.
  | { type: 'pty-attach'; replay: string; dropped: number }
  | ExportFrame;

interface ProjectChannel {
  sockets: Set<WebSocket>;
  dispose: () => void;
}

interface PtySession {
  key: string;
  root: string;
  /** Resumable-session token from pty-start; null = kill on socket close. */
  sessionId: string | null;
  /** The attached socket, or null while detached (owner dropped, pty lives). */
  socket: WebSocket | null;
  handle?: PtyHandle;
  pendingInput: string[];
  pendingResize?: { cols: number; rows: number };
  /** Everything the pty emitted (capped tail) — the reattach replay source. */
  scrollback: ScrollbackBuffer;
  /** Last size actually applied, so a same-size reattach resize can jiggle. */
  lastSize: { cols: number; rows: number };
  /**
   * Set on reattach: full-screen TUIs repaint only on SIGWINCH, and a resize
   * to the unchanged size delivers none — so the first post-reattach resize
   * jiggles (rows+1 then rows) to force a clean repaint over the raw replay.
   */
  nudgeOnNextResize: boolean;
  /** Kills a detached pty nobody reattached to (crashed/abandoned client). */
  lingerTimer?: ReturnType<typeof setTimeout>;
}

/** Default initial terminal size; the client sends a real pty-resize as soon as it mounts. */
const DEFAULT_PTY_COLS = 80;
const DEFAULT_PTY_ROWS = 24;

/**
 * How long a detached pty survives with no client attached. Sleep/wake never
 * races this: timers don't advance while the machine sleeps, so the window
 * only burns down while the machine is awake with the editor gone — and a
 * live editor reattaches within seconds of the socket dropping.
 */
export const PTY_DETACH_LINGER_MS = 60 * 60_000;

/**
 * Mount the /api/ws upgrade handler on an existing http server. `ptyBackend`
 * is test-only: it injects a fake PtyBackend so suites never spawn a real
 * pseudo-terminal; production callers omit it and get the real
 * @lydell/node-pty-backed PtyManager. `ptyEnvForTests` is a deterministic
 * seam for exercising the pending-start state.
 */
export function attachWebSocket(
  httpServer: HttpServer,
  ctx: ProjectServerContext,
  ptyBackend?: PtyBackend,
  ptyEnvForTests?: () => Promise<NodeJS.ProcessEnv>,
  opts?: { detachLingerMs?: number },
): void {
  const wss = new WebSocketServer({ noServer: true });
  const channels = new Map<string, ProjectChannel>(); // key: resolved project root
  const nodeFs = new NodeFileSystem();
  const ptyManager = new PtyManager(ptyBackend);
  const detachLingerMs = opts?.detachLingerMs ?? PTY_DETACH_LINGER_MS;
  const ptySessions = new Map<WebSocket, PtySession>(); // attached sessions
  const detachedPtys = new Map<string, PtySession>(); // key: root NUL sessionId
  let nextPtyKey = 0;

  function detachedKey(root: string, sessionId: string): string {
    return `${root}\u0000${sessionId}`;
  }

  // The pty environment, resolved once and memoized: process.env with PATH
  // widened by the user's login-shell PATH (a Finder/GUI-launched app only
  // gets the minimal system PATH — without this, `claude`/`codex` typed in
  // the shell are not found even though the user has them installed; see
  // loginShellPathEnv in shellEnv.ts) and with the `hearth` CLI shim dir
  // prepended, so every embedded-terminal session (bare shell or agent CLI)
  // finds a working `hearth`. Each half degrades independently to process.env
  // — the terminal always works, `hearth`/agent CLIs just aren't guaranteed.
  // Resolution is async (login shell + locate the packaged/standalone CLI +
  // write the shim), so callers await it before spawning.
  let ptyEnvPromise: Promise<NodeJS.ProcessEnv> | null = null;
  function getPtyEnv(): Promise<NodeJS.ProcessEnv> {
    if (ptyEnvForTests) return ptyEnvForTests();
    if (!ptyEnvPromise) {
      ptyEnvPromise = (async () => {
        const baseEnv = (await loginShellPathEnv()) ?? process.env; // never throws
        try {
          const toolPaths = await resolveToolPaths(ctx.repoRoot);
          const shimDir = await ensureHearthShim(toolPaths.cli);
          return hearthPtyEnv(baseEnv, shimDir);
        } catch {
          return baseEnv;
        }
      })();
    }
    return ptyEnvPromise;
  }

  async function getPtyEnvWithinTimeout(): Promise<NodeJS.ProcessEnv> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        getPtyEnv(),
        new Promise<NodeJS.ProcessEnv>((resolve) => {
          timer = setTimeout(() => resolve(process.env), 10_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function send(socket: WebSocket, frame: WsFrame): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  function broadcast(sockets: Set<WebSocket>, frame: WsFrame): void {
    const text = JSON.stringify(frame);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
  }

  // Desktop export progress: ctx.startDesktopExport runs the job off-request
  // and emits frames on ctx.exportBus tagged with the project root. Fan them
  // out to every socket subscribed to that root (like journal frames).
  const onExportFrame = ({ root, frame }: { root: string; frame: ExportFrame }): void => {
    const channel = channels.get(root);
    if (channel) broadcast(channel.sockets, frame);
  };
  ctx.exportBus.on('frame', onExportFrame);

  /** Removes `session` from every registry (maps, linger timer) without
   * touching the pty process itself. */
  function forgetSession(session: PtySession): void {
    if (session.lingerTimer) {
      clearTimeout(session.lingerTimer);
      session.lingerTimer = undefined;
    }
    if (session.socket && ptySessions.get(session.socket) === session) {
      ptySessions.delete(session.socket);
    }
    if (session.sessionId) {
      const key = detachedKey(session.root, session.sessionId);
      if (detachedPtys.get(key) === session) detachedPtys.delete(key);
    }
    session.socket = null;
    // Cutting `handle` is what makes late data/exit events from this pty
    // stale (the callbacks guard on it) — a killed process always exits
    // asynchronously, and its tail must not reach a replacement session.
    session.handle = undefined;
  }

  function killSession(session: PtySession): void {
    forgetSession(session);
    ptyManager.kill(session.key);
  }

  function stopPty(socket: WebSocket): void {
    const session = ptySessions.get(socket);
    if (session) killSession(session);
  }

  /**
   * The socket dropped without an explicit stop (sleep/wake, network blip,
   * crashed renderer). A session-tokened pty survives detached — buffering
   * output for a reattach — until the linger timeout reaps it; an untokened
   * one dies with its socket, as does a session still waiting to spawn.
   */
  function detachPty(socket: WebSocket): void {
    const session = ptySessions.get(socket);
    if (!session) return;
    if (!session.sessionId || !session.handle) {
      killSession(session);
      return;
    }
    ptySessions.delete(socket);
    session.socket = null;
    const key = detachedKey(session.root, session.sessionId);
    // A same-token collision (two windows minted the same UUID — effectively
    // impossible, but don't leak a process on it): the older loser dies.
    const displaced = detachedPtys.get(key);
    if (displaced && displaced !== session) killSession(displaced);
    detachedPtys.set(key, session);
    session.lingerTimer = setTimeout(() => {
      session.lingerTimer = undefined;
      killSession(session);
    }, detachLingerMs);
    // Never hold the process open for a reap timer (Node server contexts).
    session.lingerTimer.unref?.();
  }

  /** Reattaches `socket` to a live detached pty, replaying the buffered tail.
   * Returns false when no such session exists (caller spawns fresh). */
  function reattachPty(root: string, socket: WebSocket, sessionId: string): boolean {
    const session = detachedPtys.get(detachedKey(root, sessionId));
    if (!session?.handle) return false;
    detachedPtys.delete(detachedKey(root, sessionId));
    if (session.lingerTimer) {
      clearTimeout(session.lingerTimer);
      session.lingerTimer = undefined;
    }
    session.socket = socket;
    session.nudgeOnNextResize = true;
    ptySessions.set(socket, session);
    const snap = session.scrollback.snapshot();
    send(socket, { type: 'pty-attach', replay: snap.data, dropped: snap.dropped });
    return true;
  }

  /** Starts (or reattaches) a pty for this connection and routes its output
   * back to it only. */
  async function startPty(root: string, socket: WebSocket, sessionId?: string): Promise<void> {
    stopPty(socket);
    if (sessionId && reattachPty(root, socket, sessionId)) return;
    const session: PtySession = {
      key: `pty-${++nextPtyKey}`,
      root,
      sessionId: sessionId ?? null,
      socket,
      pendingInput: [],
      scrollback: new ScrollbackBuffer(),
      lastSize: { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS },
      nudgeOnNextResize: false,
    };
    ptySessions.set(socket, session);

    let env: NodeJS.ProcessEnv;
    try {
      env = await getPtyEnvWithinTimeout();
    } catch (err) {
      if (ptySessions.get(socket) === session) {
        ptySessions.delete(socket);
        send(socket, { type: 'pty-error', message: (err as Error).message });
      }
      return;
    }
    if (ptySessions.get(socket) !== session || socket.readyState !== WebSocket.OPEN) return;

    let handle: PtyHandle;
    try {
      handle = ptyManager.start(session.key, root, {
        cols: DEFAULT_PTY_COLS,
        rows: DEFAULT_PTY_ROWS,
        env,
      });
    } catch (err) {
      ptySessions.delete(socket);
      send(socket, { type: 'pty-error', message: (err as Error).message });
      return;
    }
    // Routing closes over the session, not the socket: `session.socket` is
    // reassigned on detach/reattach, and output produced while detached goes
    // to the scrollback only. `session.handle !== handle` marks staleness
    // (killSession cut it) — late events from a dead pty are dropped.
    session.handle = handle;
    handle.onData((data) => {
      if (session.handle !== handle) return;
      session.scrollback.append(data);
      if (session.socket) send(session.socket, { type: 'pty-data', data });
    });
    handle.onExit((e) => {
      if (session.handle !== handle) return;
      const socketAtExit = session.socket;
      forgetSession(session);
      if (socketAtExit) send(socketAtExit, { type: 'pty-exit', code: e.exitCode });
    });
    handle.onError((error) => {
      if (session.handle !== handle) return;
      const socketAtError = session.socket;
      forgetSession(session);
      if (socketAtError) send(socketAtError, { type: 'pty-error', message: error.message });
    });
    for (const data of session.pendingInput) ptyManager.write(session.key, data);
    session.pendingInput.length = 0;
    if (session.pendingResize) {
      ptyManager.resize(session.key, session.pendingResize.cols, session.pendingResize.rows);
      session.lastSize = session.pendingResize;
      session.pendingResize = undefined;
    }
  }

  function getChannel(root: string): ProjectChannel {
    const existing = channels.get(root);
    if (existing) return existing;
    const sockets = new Set<WebSocket>();
    const dispose = startJournalWatcher(root, nodeFs, (entries) => {
      // External change: the on-disk project moved without this context's
      // cached session knowing. Drop the cache BEFORE broadcasting, so any
      // /api/command that arrives after the frame re-opens from disk.
      if (entries.some((entry) => entry.source !== 'editor')) {
        ctx.sessions.delete(root);
      }
      broadcast(sockets, { type: 'journal', entries });
    });
    const channel: ProjectChannel = { sockets, dispose };
    channels.set(root, channel);
    return channel;
  }

  function releaseSocket(root: string, socket: WebSocket): void {
    detachPty(socket);
    const channel = channels.get(root);
    if (!channel) return;
    channel.sockets.delete(socket);
    if (channel.sockets.size === 0) {
      channel.dispose();
      channels.delete(root);
    }
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/ws') return; // not ours: leave it for any other upgrade listener

    const originCheck = isRequestAllowed({ origin: req.headers.origin, host: req.headers.host });
    if (!originCheck.ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const projectParam = url.searchParams.get('project');
      if (!projectParam) {
        ws.close(1008, 'Missing "project" query parameter');
        return;
      }
      const root = path.resolve(projectParam);
      const channel = getChannel(root);
      channel.sockets.add(ws);

      ws.on('message', (raw) => {
        let frame: WsFrame;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return; // not a frame we understand; ignore rather than crash the socket
        }
        switch (frame.type) {
          case 'pty-start':
            // Supersede this connection's prior live or pending session.
            // Other sockets on the same project keep their independent ptys.
            void startPty(root, ws, typeof frame.sessionId === 'string' ? frame.sessionId : undefined);
            break;
          case 'pty-input':
            {
              const session = ptySessions.get(ws);
              if (session?.handle) ptyManager.write(session.key, frame.data);
              else if (session) session.pendingInput.push(frame.data);
            }
            break;
          case 'pty-resize':
            {
              const session = ptySessions.get(ws);
              if (session?.handle) {
                const { cols, rows } = frame;
                if (session.nudgeOnNextResize) {
                  session.nudgeOnNextResize = false;
                  // Unchanged size delivers no SIGWINCH, so the reattached
                  // TUI would never repaint over the raw replay bytes —
                  // jiggle through rows+1 to force one. A genuinely changed
                  // size triggers the repaint by itself.
                  if (session.lastSize.cols === cols && session.lastSize.rows === rows) {
                    ptyManager.resize(session.key, cols, rows + 1);
                  }
                }
                ptyManager.resize(session.key, cols, rows);
                session.lastSize = { cols, rows };
              } else if (session) session.pendingResize = { cols: frame.cols, rows: frame.rows };
            }
            break;
          case 'pty-stop':
            // Explicit kill from the panel's Stop button — the only other
            // way a pty dies client-side is a fresh pty-start superseding it.
            stopPty(ws);
            break;
          default:
            break; // journal/pty-data/pty-exit/pty-error are server->client only
        }
      });

      ws.on('close', () => releaseSocket(root, ws));
      ws.on('error', () => releaseSocket(root, ws));
    });
  });

  httpServer.on('close', () => {
    ctx.exportBus.off('frame', onExportFrame);
    for (const channel of channels.values()) channel.dispose();
    channels.clear();
    // Detached sessions hold linger timers and live ptys; app quit reaps
    // both (killAll covers every spawned pty, attached or detached).
    for (const session of detachedPtys.values()) {
      if (session.lingerTimer) clearTimeout(session.lingerTimer);
    }
    detachedPtys.clear();
    ptySessions.clear();
    ptyManager.killAll();
  });
}
