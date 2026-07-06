/**
 * The editor's WebSocket channel, mounted at /api/ws alongside the /api/*
 * HTTP routes (see projectServer.ts). Today it only carries journal frames
 * (external-change awareness: a CLI/MCP agent mutating the project makes the
 * editor notice and refresh); the `pty-*` frame variants are defined here so
 * a later task can multiplex terminal I/O over the same socket without
 * reshaping this union.
 *
 * One socket subscribes to exactly one project (?project=<absolute path> on
 * the upgrade request). Sockets sharing a project root share a single
 * journalWatcher; the watcher is torn down once the last socket for that
 * root disconnects, and all watchers are torn down when the http server
 * closes.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import path from 'node:path';
import { type JournalEntry } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { startJournalWatcher } from './journalWatcher.js';
import type { ProjectServerContext } from './projectServer.js';

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

/** Mount the /api/ws upgrade handler on an existing http server. */
export function attachWebSocket(httpServer: HttpServer, ctx: ProjectServerContext): void {
  const wss = new WebSocketServer({ noServer: true });
  const channels = new Map<string, ProjectChannel>(); // key: resolved project root
  const nodeFs = new NodeFileSystem();

  function broadcast(sockets: Set<WebSocket>, frame: WsFrame): void {
    const text = JSON.stringify(frame);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      const projectParam = url.searchParams.get('project');
      if (!projectParam) {
        ws.close(1008, 'Missing "project" query parameter');
        return;
      }
      const root = path.resolve(projectParam);
      const channel = getChannel(root);
      channel.sockets.add(ws);

      // PTY frame handling (pty-input/pty-resize/pty-start) lands in a later
      // task; this task only wires the journal side of the channel.
      ws.on('message', () => {});

      ws.on('close', () => releaseSocket(root, ws));
      ws.on('error', () => releaseSocket(root, ws));
    });
  });

  httpServer.on('close', () => {
    for (const channel of channels.values()) channel.dispose();
    channels.clear();
  });
}
