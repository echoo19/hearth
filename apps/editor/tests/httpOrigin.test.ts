/**
 * HTTP-layer integration test for Origin/Host enforcement: a bare node:http
 * server wired to handleApiRequest (the same entry point vite dev middleware
 * and the Electron main process use), exercised with a real fetch client so
 * the guard is proven at the transport layer, not just as a pure function.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectServerContext, handleApiRequest, type ProjectServerContext } from '../server/projectServer';

let tmpDir: string;
let ctx: ProjectServerContext;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-http-origin-test-'));
  ctx = createProjectServerContext({
    recentsFile: path.join(tmpDir, 'recent-projects.json'),
    repoRoot: tmpDir,
  });

  server = http.createServer((req, res) => {
    handleApiRequest(ctx, req, res).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('Origin/Host enforcement on /api', () => {
  it('rejects a cross-origin POST with 403', async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ project: tmpDir, name: 'inspectProject', params: {} }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Forbidden');
  });

  it('rejects a cross-origin GET with 403', async () => {
    const res = await fetch(`${baseUrl}/api/meta`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects the opaque "null" Origin', async () => {
    const res = await fetch(`${baseUrl}/api/meta`, {
      headers: { Origin: 'null' },
    });
    expect(res.status).toBe(403);
  });

  it('allows a request with a localhost Origin', async () => {
    const res = await fetch(`${baseUrl}/api/meta`, {
      headers: { Origin: `http://localhost:${new URL(baseUrl).port}` },
    });
    expect(res.status).toBe(200);
  });

  it('allows a request with no Origin header (CLI/curl-style)', async () => {
    const res = await fetch(`${baseUrl}/api/meta`);
    expect(res.status).toBe(200);
  });
});
