/**
 * A deliberately tiny static file server (node:http only, zero dependencies).
 *
 * The web adapter has to point a browser at *some* origin. Many games the
 * agent builds are plain files on disk with no dev server of their own, and
 * `file://` breaks module scripts, fetch and wasm — so we serve the directory
 * on an ephemeral loopback port instead. Games that already have a dev server
 * (Vite, `npm start`, whatever) pass a ready URL and this module gets out of
 * the way entirely (`openStatic({ url })` returns a no-op handle).
 *
 * Scope, on purpose: GET/HEAD, no directory listings, no ranges, no
 * compression, no caching. Everything is served `no-store` so `reset()`'s
 * full page reload actually re-runs the game rather than replaying a cached
 * response.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/** Extension → content-type. Anything unlisted is served as octet-stream. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function contentTypeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export interface StaticServer {
  /** Base URL to navigate to, always with a trailing slash. */
  readonly url: string;
  /** 0 when this handle wraps an externally-owned URL. */
  readonly port: number;
  /** Whether this handle actually owns a listening server. */
  readonly serving: boolean;
  close(): Promise<void>;
}

/**
 * Resolve a request path against the served root, rejecting anything that
 * escapes it (`..`, absolute paths, encoded traversal) and anything with a
 * NUL byte. Returns null when the request must be refused.
 */
export function resolveRequestPath(root: string, rawUrl: string): string | null {
  const withoutQuery = rawUrl.split('?')[0]!.split('#')[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, rel);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null;
  return target;
}

async function resolveFile(target: string): Promise<string | null> {
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      const index = path.join(target, 'index.html');
      const indexInfo = await stat(index);
      return indexInfo.isFile() ? index : null;
    }
    return info.isFile() ? target : null;
  } catch {
    return null;
  }
}

/** Serve `dir` on an ephemeral loopback port. */
export async function serveDir(dir: string, host = '127.0.0.1'): Promise<StaticServer> {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const target = resolveRequestPath(root, req.url ?? '/');
      const file = target === null ? null : await resolveFile(target);
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      let body: Buffer;
      try {
        body = await readFile(file);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('read failed');
        return;
      }
      res.writeHead(200, {
        'content-type': contentTypeFor(file),
        'content-length': String(body.byteLength),
        // Never cache: reset() reloads the page and must re-run the game.
        'cache-control': 'no-store, max-age=0',
      });
      if (method === 'HEAD') res.end();
      else res.end(body);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  return {
    url: `http://${host}:${port}/`,
    port,
    serving: true,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A handle over a URL somebody else is already serving. close() is a no-op. */
export function useUrl(url: string): StaticServer {
  return { url, port: 0, serving: false, close: async () => {} };
}

/**
 * One entry point for both shapes: an existing `url` wins, otherwise `dir`
 * gets served. Exactly one of them must be provided.
 */
export async function openStatic(opts: { dir?: string; url?: string }): Promise<StaticServer> {
  if (opts.url) return useUrl(opts.url);
  if (opts.dir) return serveDir(opts.dir);
  throw new Error('openStatic: pass either a `dir` to serve or a ready `url`');
}
