/**
 * Hearth project server — a Vite plugin.
 *
 * This is how the editor talks to the local filesystem without a desktop
 * shell: `hearthProjectServer()` registers Connect middleware on the Vite dev
 * server (`configureServer`) that exposes a small JSON API under /api. The
 * browser UI never touches the disk directly; every project operation goes
 * through @hearth/core's command system via an open HearthSession, so the
 * editor uses the exact same operation vocabulary as the CLI and MCP server.
 *
 * Route handling lives in pure(ish) functions on a context object
 * (`createProjectServerContext`) so tests can exercise the API without
 * booting Vite or HTTP.
 */
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp, accessSync } from 'node:fs';
import {
  HearthSession,
  createProject,
  slugify,
  PERMISSION_MODES,
  HEARTH_VERSION,
  type CommandResult,
  type RuntimeHooks,
} from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface JsonResult {
  status: number;
  body: unknown;
}

export interface FileResult {
  status: number;
  /** Set when serving raw bytes. */
  contentType?: string;
  data?: Uint8Array;
  /** Set when returning a JSON error instead of bytes. */
  body?: unknown;
}

export interface ProjectServerOptions {
  /** Where the recent-projects list is persisted. Default: ~/.hearth/recent-projects.json */
  recentsFile?: string;
  /** Monorepo root (for example projects + agent docs). Auto-detected by default. */
  repoRoot?: string;
}

interface RecentEntry {
  path: string;
  name: string;
  openedAt: string;
}

const CONTENT_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  json: 'application/json',
  js: 'text/javascript',
  ts: 'text/javascript',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  txt: 'text/plain',
  md: 'text/markdown',
};

function contentTypeFor(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Walk upward from `start` to find the hearth monorepo root. */
export function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    const marker = path.join(dir, 'packages', 'core', 'package.json');
    try {
      // Synchronous existence check is fine here: called once at startup.
      accessSync(marker);
      return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function errorEnvelope(command: string, code: string, message: string): CommandResult {
  return {
    success: false,
    command,
    data: null,
    errors: [{ code, message }],
    warnings: [],
    changed: [],
    files: [],
    suggestions: [],
  };
}

// ---------------------------------------------------------------------------
// Context: sessions + handlers
// ---------------------------------------------------------------------------

export function createProjectServerContext(options: ProjectServerOptions = {}) {
  const nodeFs = new NodeFileSystem();
  const sessions = new Map<string, HearthSession>();
  const recentsFile =
    options.recentsFile ?? path.join(os.homedir(), '.hearth', 'recent-projects.json');
  const repoRoot = options.repoRoot ?? findRepoRoot(process.cwd());

  let runtimeHooksPromise: Promise<RuntimeHooks | undefined> | null = null;
  function loadRuntimeHooks(): Promise<RuntimeHooks | undefined> {
    if (!runtimeHooksPromise) {
      runtimeHooksPromise = (async () => {
        try {
          const mod: any = await import('@hearth/playtest');
          return typeof mod.createRuntimeHooks === 'function' ? mod.createRuntimeHooks() : undefined;
        } catch {
          // @hearth/playtest not built yet — runScene/runPlaytest will return
          // their built-in "runtime not available" error. That's expected.
          return undefined;
        }
      })();
    }
    return runtimeHooksPromise;
  }

  async function readRecents(): Promise<RecentEntry[]> {
    try {
      const raw = await fsp.readFile(recentsFile, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function addRecent(projectPath: string, name: string): Promise<void> {
    const entries = (await readRecents()).filter((e) => e.path !== projectPath);
    entries.unshift({ path: projectPath, name, openedAt: new Date().toISOString() });
    await fsp.mkdir(path.dirname(recentsFile), { recursive: true });
    await fsp.writeFile(recentsFile, JSON.stringify(entries.slice(0, 12), null, 2) + '\n');
  }

  /** Open (or reuse) a session. Throws Error with .status on failure. */
  async function getSession(projectPath: string): Promise<HearthSession> {
    const root = path.resolve(projectPath);
    const existing = sessions.get(root);
    if (existing) return existing;
    if (!(await pathExists(path.join(root, 'hearth.json')))) {
      const err = new Error(
        `Not a Hearth project: ${root} has no hearth.json. ` +
          `Open the folder that contains hearth.json, or create a new project.`,
      ) as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const runtime = await loadRuntimeHooks();
    const session = await HearthSession.open(nodeFs, root, {
      granted: [...PERMISSION_MODES], // the editor is the human surface: full grant
      runtime,
    });
    sessions.set(root, session);
    return session;
  }

  /** Resolve a project-relative path, rejecting escapes. Returns null when unsafe. */
  function resolveInside(root: string, relPath: string): string | null {
    const abs = path.resolve(root, relPath);
    if (abs === root || abs.startsWith(root + path.sep)) return abs;
    return null;
  }

  const ctx = {
    repoRoot,
    sessions,

    async openProject(rawPath: unknown): Promise<JsonResult> {
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "path" (absolute project folder).' } };
      }
      try {
        const root = path.resolve(rawPath.trim());
        const session = await getSession(root);
        const result = await session.execute('inspectProject');
        if (!result.success) {
          return { status: 500, body: { ok: false, error: result.errors[0]?.message ?? 'inspectProject failed' } };
        }
        const info = result.data as { name?: string };
        await addRecent(root, info?.name ?? path.basename(root));
        return { status: 200, body: { ok: true, path: root, info: result.data } };
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        return { status, body: { ok: false, error: (err as Error).message } };
      }
    },

    async createNewProject(dir: unknown, name: unknown, description?: unknown): Promise<JsonResult> {
      if (typeof dir !== 'string' || dir.trim() === '' || typeof name !== 'string' || name.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Both "dir" and "name" are required.' } };
      }
      try {
        const baseDir = path.resolve(dir.trim());
        const slug = slugify(name.trim());
        const target = slug ? path.join(baseDir, slug) : baseDir;
        await createProject(nodeFs, target, {
          name: name.trim(),
          description: typeof description === 'string' ? description : undefined,
        });
        const session = await getSession(target);
        const result = await session.execute('inspectProject');
        const info = result.data as { name?: string };
        await addRecent(target, info?.name ?? name.trim());
        return { status: 200, body: { ok: true, path: target, info: result.data } };
      } catch (err) {
        const code = (err as { code?: string }).code;
        const status = code === 'CONFLICT' ? 409 : 500;
        return { status, body: { ok: false, error: (err as Error).message } };
      }
    },

    async recentProjects(): Promise<JsonResult> {
      const entries = await readRecents();
      const projects = await Promise.all(
        entries.map(async (e) => ({
          path: e.path,
          name: e.name,
          exists: await pathExists(path.join(e.path, 'hearth.json')),
        })),
      );
      return { status: 200, body: { ok: true, projects } };
    },

    async exampleProjects(): Promise<JsonResult> {
      const examplesDir = path.join(repoRoot, 'packages', 'examples');
      const examples: { path: string; name: string; description: string }[] = [];
      try {
        for (const entry of await fsp.readdir(examplesDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const projectDir = path.join(examplesDir, entry.name);
          const manifest = path.join(projectDir, 'hearth.json');
          if (!(await pathExists(manifest))) continue;
          try {
            const parsed = JSON.parse(await fsp.readFile(manifest, 'utf8'));
            examples.push({
              path: projectDir,
              name: typeof parsed.name === 'string' ? parsed.name : entry.name,
              description: typeof parsed.description === 'string' ? parsed.description : '',
            });
          } catch {
            /* unreadable example: skip */
          }
        }
      } catch {
        /* examples package may not exist yet */
      }
      return { status: 200, body: { ok: true, examples } };
    },

    /** Execute a core command. Always 200; the envelope carries errors. */
    async runCommand(project: unknown, name: unknown, params: unknown): Promise<JsonResult> {
      const commandName = typeof name === 'string' ? name : '(unknown)';
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 200,
          body: errorEnvelope(commandName, 'NO_PROJECT', 'No project path supplied with the command.'),
        };
      }
      if (typeof name !== 'string' || name.trim() === '') {
        return { status: 200, body: errorEnvelope('(unknown)', 'NO_COMMAND', 'Missing command name.') };
      }
      let session: HearthSession;
      try {
        session = await getSession(project);
      } catch (err) {
        return {
          status: 200,
          body: errorEnvelope(commandName, 'NO_PROJECT', (err as Error).message),
        };
      }
      const result = await session.execute(name, params ?? {});
      return { status: 200, body: result };
    },

    async listProjectCommands(project: unknown): Promise<JsonResult> {
      try {
        if (typeof project !== 'string' || project.trim() === '') {
          throw Object.assign(new Error('Missing "project" query parameter.'), { status: 400 });
        }
        const session = await getSession(project);
        return { status: 200, body: { ok: true, commands: session.listCommands() } };
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        return { status, body: { ok: false, error: (err as Error).message } };
      }
    },

    /** Serve a raw project file. Refuses anything outside the project root. */
    async readProjectFile(project: unknown, relPath: unknown): Promise<FileResult> {
      if (typeof project !== 'string' || typeof relPath !== 'string' || relPath === '') {
        return { status: 400, body: { ok: false, error: 'Requires "project" and "path" query params.' } };
      }
      const root = path.resolve(project);
      if (!sessions.has(root) && !(await pathExists(path.join(root, 'hearth.json')))) {
        return { status: 403, body: { ok: false, error: `Not an open Hearth project: ${root}` } };
      }
      const abs = resolveInside(root, relPath);
      if (!abs) {
        return { status: 403, body: { ok: false, error: 'Path escapes the project root.' } };
      }
      try {
        const stat = await fsp.stat(abs);
        if (stat.isDirectory()) {
          return { status: 400, body: { ok: false, error: 'Path is a directory.' } };
        }
        const data = new Uint8Array(await fsp.readFile(abs));
        return { status: 200, contentType: contentTypeFor(abs), data };
      } catch {
        return { status: 404, body: { ok: false, error: `File not found: ${relPath}` } };
      }
    },

    /** Minimal FS ops for the browser-side ProjectStore (read-only). */
    async fsOperation(project: unknown, op: unknown, relPath: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || typeof op !== 'string' || typeof relPath !== 'string') {
        return { status: 400, body: { ok: false, error: 'Requires "project", "op", and "path".' } };
      }
      const root = path.resolve(project);
      if (!sessions.has(root) && !(await pathExists(path.join(root, 'hearth.json')))) {
        return { status: 403, body: { ok: false, error: `Not an open Hearth project: ${root}` } };
      }
      const abs = resolveInside(root, relPath === '' ? '.' : relPath);
      if (!abs) {
        return { status: 403, body: { ok: false, error: 'Path escapes the project root.' } };
      }
      try {
        switch (op) {
          case 'read':
            return { status: 200, body: { ok: true, content: await fsp.readFile(abs, 'utf8') } };
          case 'exists':
            return { status: 200, body: { ok: true, exists: await pathExists(abs) } };
          case 'readdir':
            return { status: 200, body: { ok: true, entries: await fsp.readdir(abs) } };
          case 'stat': {
            const s = await fsp.stat(abs);
            return {
              status: 200,
              body: { ok: true, stat: { isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs } },
            };
          }
          default:
            return { status: 400, body: { ok: false, error: `Unknown fs op "${op}".` } };
        }
      } catch (err) {
        return { status: 404, body: { ok: false, error: (err as Error).message } };
      }
    },

    async meta(): Promise<JsonResult> {
      const runtimeAvailable =
        (await pathExists(path.join(repoRoot, 'packages', 'runtime', 'src', 'pixi', 'index.ts'))) ||
        (await pathExists(path.join(repoRoot, 'packages', 'runtime', 'dist', 'pixi', 'index.js')));
      return {
        status: 200,
        body: {
          ok: true,
          repoRoot,
          home: os.homedir(),
          hearthVersion: HEARTH_VERSION,
          runtimeAvailable,
        },
      };
    },
  };

  return ctx;
}

export type ProjectServerContext = ReturnType<typeof createProjectServerContext>;

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 10 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function route(ctx: ProjectServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams;
  const method = req.method ?? 'GET';
  const key = `${method} ${url.pathname}`;

  switch (key) {
    case 'POST /api/project/open': {
      const body = await readJsonBody(req);
      const result = await ctx.openProject(body.path);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/project/create': {
      const body = await readJsonBody(req);
      const result = await ctx.createNewProject(body.dir, body.name, body.description);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/project/recent': {
      const result = await ctx.recentProjects();
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/project/examples': {
      const result = await ctx.exampleProjects();
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/command': {
      const body = await readJsonBody(req);
      const result = await ctx.runCommand(body.project, body.name, body.params);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/commands': {
      const result = await ctx.listProjectCommands(q.get('project'));
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/file': {
      const result = await ctx.readProjectFile(q.get('project'), q.get('path'));
      if (result.data !== undefined) {
        res.statusCode = result.status;
        res.setHeader('Content-Type', result.contentType ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(Buffer.from(result.data));
        return;
      }
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/fs': {
      const result = await ctx.fsOperation(q.get('project'), q.get('op'), q.get('path'));
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/meta': {
      const result = await ctx.meta();
      return sendJson(res, result.status, result.body);
    }
    default:
      return sendJson(res, 404, { ok: false, error: `Unknown API route: ${key}` });
  }
}

/**
 * The Vite plugin. Add to `plugins` in vite.config.ts; the /api routes are
 * then served by the same dev server that serves the React app.
 */
export function hearthProjectServer(options: ProjectServerOptions = {}): Plugin {
  const ctx = createProjectServerContext(options);
  return {
    name: 'hearth-project-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        route(ctx, req, res).catch((err: unknown) => {
          sendJson(res, 500, { ok: false, error: (err as Error).message ?? 'Internal error' });
        });
      });
    },
  };
}
