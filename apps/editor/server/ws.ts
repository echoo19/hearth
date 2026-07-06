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

export type WsFrame =
  | { type: 'journal'; entries: JournalEntry[] }
  | { type: 'pty-data'; data: string }
  | { type: 'pty-exit'; code: number }
  | { type: 'pty-input'; data: string } // client -> server
  | { type: 'pty-resize'; cols: number; rows: number }
  | { type: 'pty-start'; command: 'claude' | 'codex' | 'shell'; mode?: string }
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
    let handle: PtyHandle;
    try {
      handle = ptyManager.start(root, command, { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS });
    } catch (err) {
      send(socket, { type: 'pty-error', message: (err as Error).message });
      return;
    }
    ptyOwners.set(root, socket);
    handle.onData((data) => send(socket, { type: 'pty-data', data }));
    handle.onExit((e) => {
      send(socket, { type: 'pty-exit', code: e.exitCode });
      if (ptyOwners.get(root) === socket) ptyOwners.delete(root);
    });
  }

  /** Kills the pty for `root` iff `socket` is the one that owns it. */
  function killOwnedPty(root: string, socket: WebSocket): void {
    if (ptyOwners.get(root) !== socket) return;
    ptyOwners.delete(root);
    ptyManager.kill(root);
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
      ptyManager.kill(root);
    }
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/ws') return; // not ours: leave it for any other upgrade listener

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
            ptyManager.write(root, frame.data);
            break;
          case 'pty-resize':
            ptyManager.resize(root, frame.cols, frame.rows);
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
    ptyManager.killAll();
  });
}
