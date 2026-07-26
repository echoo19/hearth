/** The static server: mime types, index resolution, traversal refusal, close. */
import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  contentTypeFor,
  openStatic,
  resolveRequestPath,
  serveDir,
  useUrl,
  type StaticServer,
} from '../src/index.js';
import { BLANK_DIR, RUNNER_DIR } from './support.js';

let open: StaticServer | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe('contentTypeFor', () => {
  it('maps the extensions a web game actually ships', () => {
    expect(contentTypeFor('/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('/game.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('/mod.mjs')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('/style.CSS')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('/sprite.png')).toBe('image/png');
    expect(contentTypeFor('/engine.wasm')).toBe('application/wasm');
  });

  it('falls back to octet-stream for anything unknown', () => {
    expect(contentTypeFor('/level.dat')).toBe('application/octet-stream');
    expect(contentTypeFor('/no-extension')).toBe('application/octet-stream');
  });
});

describe('resolveRequestPath', () => {
  const root = '/srv/game';

  it('resolves paths inside the served root', () => {
    expect(resolveRequestPath(root, '/game.js')).toBe(path.resolve('/srv/game/game.js'));
    expect(resolveRequestPath(root, '/')).toBe(path.resolve('/srv/game'));
    expect(resolveRequestPath(root, '/index.html?variant=crash')).toBe(
      path.resolve('/srv/game/index.html'),
    );
  });

  it('refuses anything that escapes the root', () => {
    expect(resolveRequestPath(root, '/../secrets.env')).toBeNull();
    expect(resolveRequestPath(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveRequestPath(root, '/a/%00b')).toBeNull();
    expect(resolveRequestPath(root, '/%zz')).toBeNull();
  });
});

describe('serveDir', () => {
  it('serves index.html at the root with the right content type', async () => {
    open = await serveDir(RUNNER_DIR);
    expect(open.serving).toBe(true);
    expect(open.port).toBeGreaterThan(0);

    const res = await fetch(open.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toContain('<canvas');
  });

  it('serves sibling files byte-for-byte', async () => {
    open = await serveDir(RUNNER_DIR);
    const res = await fetch(`${open.url}game.js`);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const served = Buffer.from(await res.arrayBuffer());
    const onDisk = await readFile(path.join(RUNNER_DIR, 'game.js'));
    expect(served.equals(onDisk)).toBe(true);
  });

  it('404s missing files and refuses traversal', async () => {
    open = await serveDir(BLANK_DIR);
    expect((await fetch(`${open.url}nope.js`)).status).toBe(404);
    expect((await fetch(`${open.url}../runner/game.js`)).status).toBe(404);
  });

  it('stops answering once closed', async () => {
    const server = await serveDir(BLANK_DIR);
    const url = server.url;
    await server.close();
    await expect(fetch(url)).rejects.toBeTruthy();
  });
});

describe('useUrl / openStatic', () => {
  it('wraps an externally served URL without listening', async () => {
    const handle = useUrl('http://localhost:5173/');
    expect(handle.serving).toBe(false);
    expect(handle.port).toBe(0);
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('prefers an explicit url over a dir, and requires one of them', async () => {
    const handle = await openStatic({ url: 'http://localhost:1234/', dir: RUNNER_DIR });
    expect(handle.url).toBe('http://localhost:1234/');
    expect(handle.serving).toBe(false);
    await expect(openStatic({})).rejects.toThrow(/dir|url/);
  });
});
