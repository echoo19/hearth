/**
 * A live picture of the probe's browser, streamed to whoever is watching.
 *
 * The playtest sweep drives its own headless Chromium (it has to: the game in
 * the pane is the person's own session, and a bot mashing keys in it would be
 * playing over their shoulder). That left the pane glowing around a game that
 * was not moving, which is a worse lie than saying nothing. So the sweep now
 * carries frames out with it, and the stage shows the session that is actually
 * being played.
 *
 * Its own socket, on its own path, rather than a frame on the editor's shared
 * channel:
 *
 *  - It only exists while a sweep does. The client connects on the first
 *    frame's worth of interest and drops the moment the sweep ends, so a
 *    window that never playtests never carries the cost.
 *  - The shared channel's frames all end up in the app's store, and ten JPEGs
 *    a second do not belong in application state, where every one of them would
 *    re-render the whole window. These go straight to an <img> instead.
 *
 * Frames are base64 as CDP hands them over and stay that way to the <img>'s
 * `src`. Decoding to bytes here would save a third of the traffic on a
 * loopback socket, and cost a decode on both ends to do it.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { EventEmitter } from 'node:events';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import path from 'node:path';
import { isRequestAllowed } from './originGuard.js';

/** Where a viewer connects: /api/probe/stream?project=<absolute path>. */
export const PROBE_STREAM_PATH = '/api/probe/stream';

/**
 * `probe-frame` carries one base64 JPEG. `probe-end` says the run this was a
 * picture of is over, so a viewer can put the person's own game back without
 * waiting to notice that frames stopped arriving.
 */
export type ProbeStreamFrame = { type: 'probe-frame'; data: string } | { type: 'probe-end' };

/** What the sweep runner emits on the bus, tagged with the folder it ran in. */
export interface ProbeBusMessage {
  root: string;
  frame: ProbeStreamFrame;
}

/**
 * Mount the viewer endpoint and pump `bus` into it. Nothing is retained: a
 * frame is only worth sending to someone already watching, and a viewer that
 * joins mid-sweep is a tenth of a second from the next one.
 */
export function attachProbeStream(httpServer: HttpServer, bus: EventEmitter): void {
  const wss = new WebSocketServer({ noServer: true });
  const viewers = new Map<string, Set<WebSocket>>(); // key: resolved project root

  const onFrame = ({ root, frame }: ProbeBusMessage): void => {
    const sockets = viewers.get(root);
    if (!sockets || sockets.size === 0) return;
    const text = JSON.stringify(frame);
    for (const socket of sockets) {
      // Never queue: a frame that could not go out now is already stale, and a
      // backed-up socket would grow a buffer of pictures nobody will see.
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount === 0) socket.send(text);
    }
  };
  bus.on('frame', onFrame);

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== PROBE_STREAM_PATH) return; // not ours; leave it for the other upgrade listeners

    if (!isRequestAllowed({ origin: req.headers.origin, host: req.headers.host }).ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const project = url.searchParams.get('project');
      if (!project) {
        ws.close(1008, 'Missing "project" query parameter');
        return;
      }
      const root = path.resolve(project);
      let sockets = viewers.get(root);
      if (!sockets) {
        sockets = new Set();
        viewers.set(root, sockets);
      }
      sockets.add(ws);

      const release = (): void => {
        const current = viewers.get(root);
        if (!current) return;
        current.delete(ws);
        if (current.size === 0) viewers.delete(root);
      };
      // Nothing is ever sent the other way: this channel is one picture at a
      // time in one direction. An unexpected message is not worth a reply.
      ws.on('close', release);
      ws.on('error', release);
    });
  });

  httpServer.on('close', () => {
    bus.off('frame', onFrame);
    for (const sockets of viewers.values()) {
      for (const socket of sockets) socket.close();
    }
    viewers.clear();
  });
}
