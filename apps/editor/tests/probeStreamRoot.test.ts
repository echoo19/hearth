/**
 * The probe stream's open-folder gate.
 *
 * This endpoint resolves a caller-supplied `?project=` and files the socket
 * under it, and it was the last place in the server that did so without asking
 * whether the folder was open. Nothing leaked through it (a sweep can only be
 * started for a folder that is already open, and frames are keyed by the root
 * they came from, so an invented root is a room nobody speaks in) but the
 * asymmetry is the bug: /api/ws was reasoned about the same way right up until
 * it handed out a shell.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { createProjectServerContext, type ProjectServerContext } from '../server/projectServer';
import { attachProbeStream, PROBE_STREAM_PATH, type ProbeBusMessage } from '../server/probeStream';

let tmp: string;
let opened: string;
let ctx: ProjectServerContext;
let server: http.Server;
let wsBase: string;
let bus: EventEmitter;

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-probe-root-'));
  opened = path.join(tmp, 'my-game');
  await fsp.mkdir(opened, { recursive: true });

  ctx = createProjectServerContext({
    recentsFile: path.join(tmp, 'recent-projects.json'),
    repoRoot: tmp,
  });
  await ctx.openWorkspace(opened);

  bus = ctx.probeBus;
  server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachProbeStream(server, bus, ctx.isOpenRoot);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  wsBase = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** Connect, and settle to either the first frame or the close that came first. */
function watch(project: string): Promise<{ closed?: number; frame?: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${wsBase}${PROBE_STREAM_PATH}?project=${encodeURIComponent(project)}`,
      { headers: { Origin: wsBase.replace('ws://', 'http://') } },
    );
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('neither a frame nor a close arrived'));
    }, 3000);
    socket.on('open', () => {
      // The sweep runner's emit, verbatim.
      const message: ProbeBusMessage = { root: path.resolve(project), frame: { type: 'probe-frame', data: 'JPEG' } };
      setTimeout(() => bus.emit('frame', message), 20);
    });
    socket.on('message', (raw) => {
      clearTimeout(timer);
      socket.close();
      resolve({ frame: JSON.parse(String(raw)) });
    });
    socket.on('close', (code) => {
      clearTimeout(timer);
      resolve({ closed: code });
    });
    socket.on('error', reject);
  });
}

describe('probe stream', () => {
  it('closes a viewer that names a folder nobody opened', async () => {
    const result = await watch(path.join(tmp, 'never-opened'));
    expect(result.closed).toBe(1008);
    expect(result.frame).toBeUndefined();
  });

  it('LEGITIMATE: an open folder gets its pictures', async () => {
    const result = await watch(opened);
    expect(result.frame).toEqual({ type: 'probe-frame', data: 'JPEG' });
  });
});
