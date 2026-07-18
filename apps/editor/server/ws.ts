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
 *    same socket whose pty-start spawned that connection's pty.
 *
 * One socket subscribes to exactly one project (?project=<absolute path> on
 * the upgrade request). Sockets sharing a project root share a single
 * journalWatcher; the watcher is torn down once the last socket for that
 * root disconnects, and all watchers (and all live ptys) are torn down when
 * the http server closes.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import path from 'node:path';
import { type JournalEntry, type DesktopPlatform, type DesktopBuildResult } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { startJournalWatcher } from './journalWatcher.js';
import { type ProjectServerContext, resolveToolPaths } from './projectServer.js';
import { PtyManager, type PtyBackend, type PtyHandle } from './ptyManager.js';
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
  | { type: 'pty-start' }
  | { type: 'pty-stop' } // client -> server: explicit kill (the panel's Stop button)
  | { type: 'pty-error'; message: string }
  | ExportFrame;

interface ProjectChannel {
  sockets: Set<WebSocket>;
  dispose: () => void;
}

interface PtySession {
  key: string;
  handle?: PtyHandle;
  pendingInput: string[];
  pendingResize?: { cols: number; rows: number };
}

/** Default initial terminal size; the client sends a real pty-resize as soon as it mounts. */
const DEFAULT_PTY_COLS = 80;
const DEFAULT_PTY_ROWS = 24;

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
): void {
  const wss = new WebSocketServer({ noServer: true });
  const channels = new Map<string, ProjectChannel>(); // key: resolved project root
  const nodeFs = new NodeFileSystem();
  const ptyManager = new PtyManager(ptyBackend);
  const ptySessions = new Map<WebSocket, PtySession>();
  let nextPtyKey = 0;

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

  function stopPty(socket: WebSocket): void {
    const session = ptySessions.get(socket);
    if (!session) return;
    ptySessions.delete(socket);
    ptyManager.kill(session.key);
  }

  /** Starts a pty for this connection and routes its output back to it only. */
  async function startPty(root: string, socket: WebSocket): Promise<void> {
    stopPty(socket);
    const session: PtySession = {
      key: `pty-${++nextPtyKey}`,
      pendingInput: [],
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
    session.handle = handle;
    handle.onData((data) => {
      if (ptySessions.get(socket)?.handle !== handle) return;
      send(socket, { type: 'pty-data', data });
    });
    handle.onExit((e) => {
      if (ptySessions.get(socket)?.handle !== handle) return;
      ptySessions.delete(socket);
      send(socket, { type: 'pty-exit', code: e.exitCode });
    });
    handle.onError((error) => {
      if (ptySessions.get(socket)?.handle !== handle) return;
      ptySessions.delete(socket);
      send(socket, { type: 'pty-error', message: error.message });
    });
    for (const data of session.pendingInput) ptyManager.write(session.key, data);
    session.pendingInput.length = 0;
    if (session.pendingResize) {
      ptyManager.resize(session.key, session.pendingResize.cols, session.pendingResize.rows);
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
    stopPty(socket);
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
            void startPty(root, ws);
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
              if (session?.handle) ptyManager.resize(session.key, frame.cols, frame.rows);
              else if (session) session.pendingResize = { cols: frame.cols, rows: frame.rows };
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
    ptySessions.clear();
    ptyManager.killAll();
  });
}
