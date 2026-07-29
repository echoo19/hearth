/**
 * Vite's /@fs/ route, and why the control-plane origin will not make a document
 * out of it.
 *
 * THE HOLE THIS PINS SHUT (dev mode only)
 *
 * `GET /api/file` was made inert as a document because the game frame carries
 * `allow-popups` WITHOUT `allow-popups-to-escape-sandbox`: a popup inherits
 * `allow-same-origin`, so `window.open` on any control-plane URL that answers
 * `text/html` runs agent-written script AS `http://localhost:5173`. That
 * satisfies originGuard.ts, which reaches `/api/ws?project=<an open root>`,
 * which reaches `pty-start`.
 *
 * The Vite middleware forwarded only `/api/*` to the guarded routes and let
 * everything else fall through, and `/@fs/<abs path>` serves any file under
 * `server.fs.allow`, configured as the whole hearth-engine repo because the
 * editor's aliases import packages/* from source. A user's project inside
 * `packages/examples/` is the ordinary case. So the same popup, pointed at
 * `/@fs/<repo>/<project>/pwn.html`, walked straight back in.
 *
 * Two things close it and both are pinned here:
 *   1. `/@fs/` refuses DOCUMENT requests outright (this file's first half). The
 *      editor never navigates there; it only fetches modules, and those are
 *      untouched, which the LEGITIMATE cases prove.
 *   2. Vite's dev CORS no longer echoes any loopback Origin (the second half),
 *      because it did, and that let the game just `fetch()` these bytes and
 *      read the reply with no popup at all.
 */
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { guardViteFs, fetchIntent, isViteFsPath } from '../server/projectServer';
import viteConfig from '../vite.config';

let server: http.Server;
let baseUrl: string;

/** The payload a repo file would carry if an agent wrote one. */
const PAYLOAD = '<script>THIS TEST INVENTED THIS PAYLOAD</script>';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    // Exactly the shape of the real middleware: our guard first, then Vite.
    if (guardViteFs(req, res)) return;
    // Stands in for Vite's static/transform middleware, which is what actually
    // answered `text/html` with no CSP and no nosniff.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end(PAYLOAD);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const fsUrl = '/@fs/Users/someone/projects/hearth-engine/packages/examples/mini-platformer/pwn.html';

function ask(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${url}`, { headers });
}

/**
 * `Sec-*` are forbidden header names, so node's own `fetch` refuses to send the
 * ones a browser attaches and quietly supplies `sec-fetch-mode: cors` instead.
 * Anything that needs to spell those headers exactly goes out over node:http.
 */
function raw(url: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${url}`, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

describe('/@fs/ will not become a document on the control plane', () => {
  it('THE ATTACK: the popup navigation is refused', async () => {
    // What a browser sends for `window.open(...)` out of the game frame.
    const res = await raw(fsUrl, { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('THIS TEST INVENTED');
  });

  it('and so are the other ways to get a document out of a URL', async () => {
    for (const dest of ['iframe', 'frame', 'embed', 'object']) {
      expect((await raw(fsUrl, { 'Sec-Fetch-Dest': dest })).status).toBe(403);
    }
    // A navigation whose destination the browser spelled differently.
    expect((await raw(fsUrl, { 'Sec-Fetch-Mode': 'navigate' })).status).toBe(403);
  });

  it('LEGITIMATE: the editor’s module graph is untouched, which is the whole of dev', async () => {
    // Every aliased import of packages/* comes through /@fs/ as a script fetch.
    // If this ever 403s or picks up a CSP, `npm run dev` is dead.
    const res = await ask('/@fs/Users/someone/projects/hearth-engine/packages/core/src/index.ts', {
      'Sec-Fetch-Dest': 'script',
      'Sec-Fetch-Mode': 'cors',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('LEGITIMATE: styles, images, wasm and workers come through too', async () => {
    for (const dest of ['style', 'image', 'empty', 'worker', 'font']) {
      const res = await ask('/@fs/Users/someone/projects/hearth-engine/packages/runtime/src/x', {
        'Sec-Fetch-Dest': dest,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toBeNull();
    }
  });

  it('a client that is not a browser gets its bytes, but inert as a document', async () => {
    // curl, the CLI, a test. Not the threat, so not refused; still given the
    // same headers /api/file uses in case something renders them.
    const res = await raw(fsUrl, {});
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('leaves every other path to Vite, including the editor’s own document', async () => {
    const res = await raw('/', { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' });
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

describe('the predicates themselves', () => {
  it('knows which paths are Vite’s escape hatch', () => {
    expect(isViteFsPath('/@fs/Users/x/y.html')).toBe(true);
    expect(isViteFsPath('/@vite/client')).toBe(false);
    expect(isViteFsPath('/api/meta')).toBe(false);
    expect(isViteFsPath('/src/main.tsx')).toBe(false);
  });

  it('reads a browser’s own declaration of what it is doing', () => {
    expect(fetchIntent({ 'sec-fetch-dest': 'document' })).toBe('document');
    expect(fetchIntent({ 'sec-fetch-dest': 'script' })).toBe('subresource');
    expect(fetchIntent({})).toBe('unknown');
    // node:http hands duplicated headers back as an array.
    expect(fetchIntent({ 'sec-fetch-dest': ['document', 'script'] })).toBe('document');
  });
});

describe('the dev server’s own settings', () => {
  const dev = (viteConfig as { server: { cors: unknown; fs: { allow: string[]; deny: string[] } } }).server;

  it('THE ATTACK: dev CORS no longer echoes whatever loopback origin asks', () => {
    // Vite's default is a loopback regex, which matches the GAME's port. With
    // it on, agent-written game code could fetch any repo file off the control
    // plane and READ the reply: no popup, no navigation, no sandbox trick.
    expect(dev.cors).toBe(false);
  });

  it('and Hearth’s own secret store is on the fs deny list', () => {
    // Belt to the mount's braces: .hearth/app.json holds the saved Anthropic
    // and OpenAI keys, and it sits inside a folder /@fs/ can otherwise reach.
    expect(dev.fs.deny).toContain('**/.hearth/**');
    expect(dev.fs.deny).toContain('**/.git/**');
  });

  it('LEGITIMATE: the repo is still allowed, because the aliases need it', () => {
    // Narrowing `allow` would break every `@hearth/*` import in the editor.
    expect(dev.fs.allow.length).toBe(1);
    // The repo ROOT, computed the same way vite.config.ts computes it, rather
    // than a basename. This asserted `endsWith('hearth-engine')`, which is the
    // name of one particular clone on one particular machine: CI checks out to
    // a directory named after the repository, so the test passed for whoever
    // wrote it and failed for everybody else, including the release build.
    // What matters is that the allowed root is the repo, not what it is called.
    expect(dev.fs.allow[0]).toBe(path.resolve(__dirname, '../../..'));
  });
});
