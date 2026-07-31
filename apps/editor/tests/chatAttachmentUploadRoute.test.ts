import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectServerContext, handleApiRequest, type ProjectServerContext } from '../server/projectServer';

let tmp: string;
let project: string;
let unopened: string;
let ctx: ProjectServerContext;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-upload-route-'));
  project = path.join(tmp, 'open');
  unopened = path.join(tmp, 'not-open');
  await Promise.all([fsp.mkdir(project), fsp.mkdir(unopened)]);
  ctx = createProjectServerContext({
    recentsFile: path.join(tmp, 'recents.json'),
    repoRoot: tmp,
  });
  await ctx.openWorkspace(project);
  server = http.createServer((req, res) => {
    void handleApiRequest(ctx, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(tmp, { recursive: true, force: true });
});

function upload(root: string, bytes: BodyInit): Promise<Response> {
  const q = new URLSearchParams({
    project: root,
    name: '../../shot.png',
    mimeType: 'image/png',
  });
  return fetch(`${baseUrl}/api/chat/attachments?${q}`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'image/png' },
    body: bytes,
  });
}

describe('POST /api/chat/attachments', () => {
  it('streams an original into an opaque project-scoped token', async () => {
    const response = await upload(project, Buffer.from('unchanged original'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.name).toBe('shot.png');
    expect(body.uploadToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(body).not.toHaveProperty('path');
    expect(JSON.stringify(body)).not.toContain(project);
  });

  it('cannot stage into an arbitrary folder that was never opened', async () => {
    const response = await upload(unopened, Buffer.from('do not write me'));
    expect(response.status).toBe(403);
    expect(await fsp.readdir(unopened)).toEqual([]);
  });
});
