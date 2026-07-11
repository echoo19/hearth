/**
 * The editor's WebSocket channel, mounted at /api/ws alongside the /api/*
 * HTTP routes (see projectServer.ts). It carries two kinds of frames over
 * the same socket:
 *
 *  - journal: external-change awareness (a CLI/MCP agent mutating the
 *    project makes the editor notice and refresh). Broadcast to every
 *    socket subscribed to that project root.
 *  - pty-*: the embedded terminal (a real shell, or the `claude`/`codex`
 *    CLI spawned interactively via PtyManager). A terminal is per-client,
 *    not broadcast: pty-data/pty-exit/pty-error only ever go back over the
 *    same socket whose pty-start (re)spawned the pty for that project root.
 *
 * One socket subscribes to exactly one project (?project=<absolute path> on
 * the upgrade request). Sockets sharing a project root share a single
 * journalWatcher; the watcher is torn down once the last socket for that
 * root disconnects, and all watchers (and any live pty) are torn down when
 * the http server closes.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import path from 'node:path';
import { type JournalEntry } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { startJournalWatcher } from './journalWatcher.js';
import type { ProjectServerContext } from './projectServer.js';
import { PtyManager, type PtyBackend, type PtyHandle } from './ptyManager.js';
import { isRequestAllowed } from './originGuard.js';

export type WsFrame =
  | { type: 'journal'; entries: JournalEntry[] }
  | { type: 'pty-data'; data: string }
  | { type: 'pty-exit'; code: number }
  | { type: 'pty-input'; data: string } // client -> server
  | { type: 'pty-resize'; cols: number; rows: number }
  | { type: 'pty-start'; command: 'claude' | 'codex' | 'shell'; mode?: string }
  | { type: 'pty-stop' } // client -> server: explicit kill (the panel's Stop button)
  | { type: 'pty-error'; message: string };

interface ProjectChannel {
  sockets: Set<WebSocket>;
  dispose: () => void;
}

/** Default initial terminal size; the client sends a real pty-resize as soon as it mounts. */
const DEFAULT_PTY_COLS = 80;
const DEFAULT_PTY_ROWS = 24;

/**
 * Mount the /api/ws upgrade handler on an existing http server. `ptyBackend`
 * is test-only: it injects a fake PtyBackend so suites never spawn a real
 * pseudo-terminal; production callers omit it and get the real
 * @lydell/node-pty-backed PtyManager.
 */
export function attachWebSocket(httpServer: HttpServer, ctx: ProjectServerContext, ptyBackend?: PtyBackend): void {
  const wss = new WebSocketServer({ noServer: true });
  const channels = new Map<string, ProjectChannel>(); // key: resolved project root
  const nodeFs = new NodeFileSystem();
  const ptyManager = new PtyManager(ptyBackend);
  // Tracks which socket currently "owns" the live pty for a root (the one
  // whose pty-start most recently (re)spawned it), so its output is routed
  // back to that socket only — a terminal is per-client, not broadcast —
  // and so closing that specific socket tears the pty down.
  const ptyOwners = new Map<string, WebSocket>();
  // The handle each root's *current* pty was spawned with. A killed pty's
  // real process exits asynchronously, so its onData/onExit callbacks can
  // still fire after a pty-stop or a superseding pty-start; comparing
  // against this map lets those stale callbacks be dropped instead of
  // sending a phantom pty-exit (or deleting ownership) for the session
  // that replaced it.
  const liveHandles = new Map<string, PtyHandle>();

  function send(socket: WebSocket, frame: WsFrame): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  function broadcast(sockets: Set<WebSocket>, frame: WsFrame): void {
    const text = JSON.stringify(frame);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
  }

  /** Starts a pty for `root` and routes its output back to `socket` only. */
  function startPty(root: string, socket: WebSocket, command: 'claude' | 'codex' | 'shell'): void {
    // Supersede the previous pty's callbacks BEFORE killing it (inside
    // ptyManager.start), so an exit that fires during/after the kill can't
    // masquerade as this new session's exit.
    liveHandles.delete(root);
    let handle: PtyHandle;
    try {
      handle = ptyManager.start(root, command, { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS });
    } catch (err) {
      send(socket, { type: 'pty-error', message: (err as Error).message });
      return;
    }
    ptyOwners.set(root, socket);
    liveHandles.set(root, handle);
    handle.onData((data) => {
      if (liveHandles.get(root) !== handle) return; // stale: this pty was stopped/superseded
      send(socket, { type: 'pty-data', data });
    });
    handle.onExit((e) => {
      if (liveHandles.get(root) !== handle) return; // stale: don't report or unclaim for the replacement
      liveHandles.delete(root);
      send(socket, { type: 'pty-exit', code: e.exitCode });
      if (ptyOwners.get(root) === socket) ptyOwners.delete(root);
    });
  }

  /** Kills the pty for `root` iff `socket` is the one that owns it. */
  function killOwnedPty(root: string, socket: WebSocket): void {
    if (ptyOwners.get(root) !== socket) return;
    ptyOwners.delete(root);
    // Mark superseded first: the real process exits asynchronously, and its
    // late exit event must not be delivered as if a live session ended.
    liveHandles.delete(root);
    ptyManager.kill(root);
  }

  /** A terminal is per-client: only the socket whose pty-start (re)spawned
   * the pty for `root` may feed it keystrokes/resizes or kill it. Every other
   * socket sharing the project (journal frames are broadcast to all of them)
   * gets a silent no-op instead of being able to inject input into, resize,
   * or stop a session it doesn't own. */
  function isPtyOwner(root: string, socket: WebSocket): boolean {
    return ptyOwners.get(root) === socket;
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
    killOwnedPty(root, socket);
    const channel = channels.get(root);
    if (!channel) return;
    channel.sockets.delete(socket);
    if (channel.sockets.size === 0) {
      channel.dispose();
      channels.delete(root);
      // Belt-and-suspenders: the project is fully closed (last socket gone),
      // so no pty for this root should survive it even if ownership
      // tracking above ever missed a case.
      liveHandles.delete(root);
      ptyManager.kill(root);
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
            // A new pty-start always kills whatever pty this root already
            // has (PtyManager.start's contract) and re-homes ownership to
            // this socket, so a stale socket stops receiving output.
            startPty(root, ws, frame.command);
            break;
          case 'pty-input':
            if (isPtyOwner(root, ws)) ptyManager.write(root, frame.data);
            break;
          case 'pty-resize':
            if (isPtyOwner(root, ws)) ptyManager.resize(root, frame.cols, frame.rows);
            break;
          case 'pty-stop':
            // Explicit kill from the panel's Stop button — the only other
            // way a pty dies client-side is a fresh pty-start superseding it.
            killOwnedPty(root, ws);
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
    for (const channel of channels.values()) channel.dispose();
    channels.clear();
    ptyOwners.clear();
    liveHandles.clear();
    ptyManager.killAll();
  });
}
