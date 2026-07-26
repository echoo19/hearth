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
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fsp, accessSync } from 'node:fs';
import {
  HearthSession,
  getCommand,
  createProject,
  slugify,
  PERMISSION_MODES,
  HEARTH_VERSION,
  JournalStore,
  type CommandResult,
  type RuntimeHooks,
  type DesktopBuildSpec,
  type DesktopBuildResult,
  type DesktopPlatform,
} from '@hearth/core';
import { NodeFileSystem, loadPlayerBundle } from '@hearth/core/node';
import { listTemplates, getTemplatePath, scaffoldFromTemplate } from '@hearth/templates';
import { isRequestAllowed } from './originGuard.js';
import { ensureHearthMcpConfig } from './mcpConfig.js';
import { readAppSettings, writeAppSettings, resolveApiKey } from './chat.js';
import { createChat, deleteChat, listChats, renameChat } from './chatStore.js';
import {
  planSweep,
  readCapabilities,
  sensesFromCapabilities,
  SweepBusyError,
  SweepRunner,
  type SweepDeps,
} from './probeSweep.js';
import { EVIDENCE_DIR } from './evidenceWatcher.js';
import { attachWebSocket, type ExportFrame, type ExportStage, type DesktopExportResult } from './ws.js';

export { attachWebSocket } from './ws.js';

// ---------------------------------------------------------------------------
// Static mounts
//
// The game pane iframes whatever web game the agent built, and the evidence
// rail shows screenshots the probe captured. Both are files inside the user's
// project folder, so they are served from mounts OUTSIDE /api/:
//
//   /game/<key>/<rel>       — the project folder
//   /evidence/<key>/<rel>   — the project's .hearth/evidence folder
//
// `<key>` is the base64url-encoded absolute project root. Encoding the root
// into the path (rather than a ?project= query) is what makes a game's own
// relative asset URLs — `./main.js`, `assets/sprite.png` — resolve correctly
// from inside the iframe, since they resolve against the mount as their base.
// ---------------------------------------------------------------------------

export const GAME_MOUNT = '/game/';
export const EVIDENCE_MOUNT = '/evidence/';

export function encodeRootKey(root: string): string {
  return Buffer.from(root, 'utf8').toString('base64url');
}

export function decodeRootKey(key: string): string | null {
  try {
    const decoded = Buffer.from(key, 'base64url').toString('utf8');
    return decoded.trim() === '' ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Paths this server owns. Both transports (the Vite dev-server middleware and
 * the Electron main process's http server) ask this before falling through to
 * their own static UI handling, so the mounts can never be shadowed by an
 * index.html fallback.
 */
export function isHearthServerPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith(GAME_MOUNT) || pathname.startsWith(EVIDENCE_MOUNT);
}

/**
 * Where a project's web game lives, in priority order. Zero required
 * conventions is the point: the agent builds however it likes, and Hearth
 * looks in the handful of places a web game plausibly lands.
 */
export const GAME_ENTRY_CANDIDATES = ['index.html', 'game/index.html', 'dist/index.html', 'public/index.html'];

/** Directories never walked when timestamping a game (noise, and potentially huge). */
const MTIME_SKIP_DIRS = new Set(['node_modules', '.git', '.hearth', 'dist-electron', '.next', 'release']);
/** Upper bound on files visited per mtime scan, so a fat project can't stall the poll. */
const MTIME_FILE_BUDGET = 600;

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

/**
 * The desktop packager, shaped like @hearth/shipping's `packageDesktop`.
 * Injectable so tests can stand in a stub that never spawns Electron.
 */
export type PackageDesktopFn = (opts: {
  spec: DesktopBuildSpec;
  onProgress?: (e: { platform: DesktopPlatform | null; stage: ExportStage; message: string }) => void;
}) => Promise<DesktopBuildResult[]>;

export interface ProjectServerOptions {
  /** Where the recent-projects list is persisted. Default: ~/.hearth/recent-projects.json */
  recentsFile?: string;
  /** Monorepo root (for example projects + agent docs). Auto-detected by default. */
  repoRoot?: string;
  /**
   * Test seam: override the desktop packager. Defaults to a lazy import of
   * @hearth/shipping's `packageDesktop` (which needs Node + Electron), so
   * suites can inject a stub and never touch the real toolchain.
   */
  packageDesktop?: PackageDesktopFn;
  /**
   * Test seam: override how a playtest sweep opens a game and runs. Defaults to
   * the real `@hearth/adapter-web` + `@hearth/probe-core` pair, which launches
   * headless Chromium — suites inject a fake game instead.
   */
  sweepDeps?: Partial<SweepDeps>;
}

/** Native desktop targets offered by exportDesktop, surfaced on the capability route. */
const DESKTOP_PLATFORMS: DesktopPlatform[] = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];

/**
 * Best-effort recovery of which platform a desktop-export failure belongs to.
 *
 * `session.execute()` (packages/core/src/session.ts) catches every error
 * `def.run()` throws and flattens it to a plain `{code, message}`
 * `CommandIssue` — any extra property on the thrown error (like
 * `DesktopPackageError.platform` from @hearth/shipping's `packageDesktop`,
 * see packages/shipping/src/package.ts) does not survive that boundary. The
 * platform id does survive as a substring of the message, though
 * (`DesktopPackageError`'s message is "packaging <platform> failed: ..."), so
 * recover it from there rather than widening the core CommandResult/CommandIssue
 * shape for one error source.
 */
function extractFailingPlatform(message: string | undefined): DesktopPlatform | undefined {
  if (!message) return undefined;
  // Anchor on DesktopPackageError's exact phrase: a bare substring scan
  // misattributes errors whose message merely mentions a platform id — the
  // zod enum-validation message for a bad `platforms` param enumerates all
  // four, and a user outDir could echo one via an fs error.
  const m = message.match(/packaging (\S+) failed:/);
  return DESKTOP_PLATFORMS.find((p) => p === m?.[1]);
}

/**
 * F-5 (L-118 export friction reaudit): the finished export-done result already
 * names each build's zip path but not its size — a near-empty example
 * project's darwin-arm64 zip weighs 254MB (almost entirely the bundled
 * Electron runtime), and the dialog gave a first-time exporter zero context
 * for that number. Stat each build's zip here, server-side, right before the
 * result goes out over the export bus, and attach the byte count so the
 * dialog can show it next to the path. A stat failure (disk hiccup, or a test
 * double's packageDesktop that never actually wrote the file) must not turn a
 * real success into an error — just leave that build's size unset.
 */
async function attachZipSizes(root: string, builds: DesktopBuildResult[]): Promise<void> {
  await Promise.all(
    builds.map(async (build) => {
      try {
        const stat = await fsp.stat(path.resolve(root, build.zip));
        build.zipBytes = stat.size;
      } catch {
        /* leave zipBytes unset — the row still renders fine without it */
      }
    }),
  );
}

interface RecentEntry {
  path: string;
  name: string;
  openedAt: string;
}

const CONTENT_TYPES: Record<string, string> = {
  // The static mounts serve whatever web game the agent built, so the full
  // browser-document set matters here, not just editor asset types.
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  mjs: 'text/javascript',
  wasm: 'application/wasm',
  ico: 'image/x-icon',
  map: 'application/json',
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

// ---------------------------------------------------------------------------
// Asset import (POST /api/assets/import)
// ---------------------------------------------------------------------------

/** File types the editor's Import accepts: images, audio, and fonts. */
export const IMPORT_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'svg',
  'webp',
  'gif',
  'wav',
  'mp3',
  'ogg',
  'ttf',
  'otf',
  'woff',
  'woff2',
]);

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** Uploads are staged here, then moved into assets/<type>/ by importAsset. */
const IMPORT_STAGING_DIR = 'assets/imported';

/**
 * Reduce a client-supplied filename to a safe basename: strip any directory
 * parts, collapse odd characters, refuse hidden/extension-less names.
 * Returns null when nothing usable is left.
 */
export function sanitizeImportFilename(raw: string): string | null {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const safe = base
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.\s-]+/, '');
  const dot = safe.lastIndexOf('.');
  if (dot <= 0 || dot === safe.length - 1) return null;
  return safe;
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

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Newest mtime (ms) anywhere under `dir`, ignoring the skip list and stopping
 * after MTIME_FILE_BUDGET entries. This is the game pane's reload signal: the
 * agent rewriting any source file bumps it, and the pane reloads the iframe.
 * Deliberately a timestamp rather than a content hash — cheap enough to poll,
 * and "something changed" is all the pane needs to know.
 */
export async function newestMtimeMs(dir: string): Promise<number> {
  let newest = 0;
  let budget = MTIME_FILE_BUDGET;
  const stack = [dir];
  while (stack.length > 0 && budget > 0) {
    const current = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget-- <= 0) break;
      if (entry.name.startsWith('.') && entry.name !== '.hearth') {
        if (entry.isDirectory()) continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!MTIME_SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      try {
        const stat = await fsp.stat(full);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return newest;
}

/**
 * Agent tool locations. In the packaged desktop app, single-file bundles
 * ship next to the Electron main (HEARTH_TOOLS_DIR is set by
 * electron/main.ts); from a repo checkout we point at the built packages
 * instead. Shared by `meta()` and the terminal PATH shim.
 */
export async function resolveToolPaths(repoRoot: string): Promise<{ cli: string; mcp: string; bundled: boolean }> {
  const toolsDir = process.env.HEARTH_TOOLS_DIR;
  const bundledCli = toolsDir ? path.join(toolsDir, 'hearth-cli.mjs') : null;
  const bundledMcp = toolsDir ? path.join(toolsDir, 'hearth-mcp.mjs') : null;
  if (bundledCli && bundledMcp && (await pathExists(bundledCli)) && (await pathExists(bundledMcp))) {
    return { cli: bundledCli, mcp: bundledMcp, bundled: true };
  }
  return {
    cli: path.join(repoRoot, 'packages', 'cli', 'dist', 'main.js'),
    mcp: path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'main.js'),
    bundled: false,
  };
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
  /**
   * Every folder this server has been asked to open this run — Hearth projects
   * AND plain folders (the app opens whatever folder the agent is going to
   * build in, which need not contain a hearth.json). It is the read jail for
   * the file routes and the static mounts: a request must name a root that was
   * deliberately opened, and every path is still resolved inside it.
   */
  const openedRoots = new Set<string>();
  // The on-disk journal seq each cached session had seen, last time we
  // checked or updated it — see getSession's self-healing reload below.
  const seenSeq = new Map<string, number>();
  // Per-project mutation mutex. A mutating command dispatch (open/reopen the
  // session → session.execute → sync the seen seq) is a read-modify-write on
  // shared per-project state — the undo-history cursor most acutely: undo/redo
  // read a `before` snapshot and advance index.json, so two dispatches that
  // interleave at an await point lose steps (the exact "rapid ⌘Z drops undos"
  // defect, and its cross-client twin: the editor and an embedded agent CLI
  // both POSTing /api/command at once). Chaining every mutating dispatch for a
  // given root through one promise serializes them; read-only commands skip the
  // lock and stay concurrent. In-process only — a CLI/MCP agent in a SEPARATE
  // process shares no part of this lock (that cross-process history race is the
  // pre-existing dup-journal-seq tail item, out of scope here).
  const mutationLocks = new Map<string, Promise<unknown>>();
  function withMutationLock<T>(root: string, task: () => Promise<T>): Promise<T> {
    const prev = mutationLocks.get(root) ?? Promise.resolve();
    // Run after the current tail regardless of its outcome; keep the chain
    // alive past a rejection so one failed dispatch doesn't wedge the queue.
    const run = prev.then(task, task);
    const tail = run.catch(() => undefined);
    mutationLocks.set(root, tail);
    // Drop the entry once this dispatch is the tail, so the map doesn't grow
    // one permanent promise per project touched this session.
    void tail.then(() => {
      if (mutationLocks.get(root) === tail) mutationLocks.delete(root);
    });
    return run;
  }
  const recentsFile =
    options.recentsFile ?? path.join(os.homedir(), '.hearth', 'recent-projects.json');
  const repoRoot = options.repoRoot ?? findRepoRoot(process.cwd());

  // Desktop packager: the injected stub in tests, else a lazy import of the
  // real (Electron-backed) @hearth/shipping entry point, so a plain editor
  // session never loads the packaging toolchain until a desktop export runs.
  const packageDesktopImpl: PackageDesktopFn =
    options.packageDesktop ??
    (async (opts) => {
      const { packageDesktop } = await import('@hearth/shipping');
      return packageDesktop(opts);
    });

  // Playtest sweeps. One runner for the whole server; it enforces one sweep at
  // a time per project root (see probeSweep.ts) the same way the mutation lock
  // above serializes command dispatch.
  const sweeps = new SweepRunner(options.sweepDeps ?? {});

  // Desktop-export progress bus. One export runs at a time; the running job
  // routes packageDesktop's onProgress and its terminal result onto this bus,
  // tagged with the project root, and ws.ts fans frames out to that root's
  // sockets. Emitting here (not straight to sockets) keeps projectServer
  // transport-agnostic — the same as the journal/pty split.
  const exportBus = new EventEmitter();
  interface ExportJob {
    jobId: string;
    root: string;
    done: boolean;
  }
  let activeExport: ExportJob | null = null;
  const emitExport = (root: string, frame: ExportFrame): void => {
    exportBus.emit('frame', { root, frame });
  };

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

  /**
   * The on-disk journal's last seq, or null if it can't be read right now.
   * A read error (transient fs hiccup, mid-rotation race) must not break
   * getSession — callers fall back to trusting the cached session rather
   * than treating "unreadable" as "disk is ahead".
   */
  async function diskJournalSeq(root: string): Promise<number | null> {
    try {
      return await new JournalStore(nodeFs, root).lastSeq();
    } catch {
      return null;
    }
  }

  /** Open a fresh session from disk, cache it, and record the journal seq it starts from. */
  async function openSessionFromDisk(root: string): Promise<HearthSession> {
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
      // exportWeb needs the built web player: HEARTH_TOOLS_DIR in the
      // packaged app, packages/runtime/player/ from a repo checkout.
      // exportDesktop additionally needs a desktop packager; its onProgress is
      // routed to the export bus as the running job's stream (one job at a
      // time, so `activeExport` unambiguously identifies whose progress it is).
      resources: {
        getPlayerBundle: () => loadPlayerBundle(repoRoot),
        packageDesktop: (spec) =>
          packageDesktopImpl({
            spec,
            onProgress: (e) => {
              if (!activeExport) return;
              emitExport(activeExport.root, {
                type: 'export-progress',
                jobId: activeExport.jobId,
                platform: e.platform,
                stage: e.stage,
                message: e.message,
              });
            },
          }),
      },
      source: 'editor',
    });
    sessions.set(root, session);
    seenSeq.set(root, (await diskJournalSeq(root)) ?? 0);
    return session;
  }

  /**
   * Open (or reuse) a session. Throws Error with .status on failure.
   *
   * Self-healing: the watcher-driven invalidation in ws.ts only fires while
   * a WebSocket is connected (see attachWebSocket's getChannel), so it's
   * blind to external agent/CLI edits made while the socket is closed, mid
   * reconnect, or the watcher never started at all. Every call here instead
   * does a cheap one-file read of the on-disk journal's last seq and
   * compares it against what this cached session has seen; if disk is
   * ahead, the cache is stale and gets dropped in favor of a fresh reopen —
   * regardless of whether any watcher was ever running. The session's own
   * mutations advance `seenSeq` right after they run (see the sync calls in
   * runCommandImpl/importAssetFile below), so a session that has been
   * exclusively driving its own edits never triggers a reload of itself.
   */
  async function getSession(projectPath: string): Promise<HearthSession> {
    const root = path.resolve(projectPath);
    const existing = sessions.get(root);
    if (existing) {
      const diskSeq = await diskJournalSeq(root);
      const seen = seenSeq.get(root) ?? 0;
      if (diskSeq === null || diskSeq <= seen) return existing;
      // Disk moved ahead of what this session has seen: an external
      // agent/CLI mutation landed with no watcher around to invalidate the
      // cache. Fall through to reopen from disk instead of serializing
      // stale memory over it on the next mutation.
    }
    return openSessionFromDisk(root);
  }

  /** Re-sync the tracked seq for `root` to current disk after running a command through its session, so the session's own journal appends don't look like an external change next time. Best-effort: an unreadable journal here just leaves the previous seen-seq in place. */
  async function syncSeenSeq(root: string): Promise<void> {
    const diskSeq = await diskJournalSeq(root);
    if (diskSeq !== null) seenSeq.set(root, diskSeq);
  }

  /** Resolve a project-relative path, rejecting escapes. Returns null when unsafe. */
  function resolveInside(root: string, relPath: string): string | null {
    const abs = path.resolve(root, relPath);
    if (abs === root || abs.startsWith(root + path.sep)) return abs;
    return null;
  }

  /** Execute a core command. Always 200; the envelope carries errors. */
  async function runCommandImpl(project: unknown, name: unknown, params: unknown): Promise<JsonResult> {
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
    const root = path.resolve(project);
    const dispatch = async (): Promise<JsonResult> => {
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
      await syncSeenSeq(root);
      return { status: 200, body: result };
    };
    // Serialize mutating dispatches per project root (read-modify-write on undo
    // history / project state); read-only queries stay concurrent. An unknown
    // command name is treated as mutating — a conservative default; core rejects
    // it inside the lock anyway.
    const def = getCommand(name);
    if (def && !def.mutates) return dispatch();
    return withMutationLock(root, dispatch);
  }

  /**
   * Best-effort: write the `hearth` MCP server entry into the project's
   * `.mcp.json` so an agent launched in the embedded terminal (e.g. `claude`)
   * finds Hearth's tools with no manual setup. Never throws — provisioning must
   * not block opening a project — and never spawns anything, so it can't
   * reintroduce the old launcher's silent spawn failures.
   */
  async function provisionAgentMcp(root: string): Promise<void> {
    try {
      const { mcp } = await resolveToolPaths(repoRoot);
      await ensureHearthMcpConfig(root, mcp, 'full');
    } catch (err) {
      console.warn(`[hearth] MCP auto-provisioning skipped: ${(err as Error).message}`);
    }
  }

  /** Is `root` readable through the file routes / static mounts? */
  function isOpenRoot(root: string): boolean {
    return openedRoots.has(root) || sessions.has(root);
  }

  /**
   * Where this folder's web game is, or null when it has none. One resolution
   * shared by the game pane's status poll and the playtest sweep, so what the
   * probe plays is exactly what the pane is showing.
   */
  async function resolveGameEntry(root: string): Promise<{ entry: string; abs: string } | null> {
    for (const candidate of GAME_ENTRY_CANDIDATES) {
      const abs = resolveInside(root, candidate);
      if (abs && (await pathExists(abs))) return { entry: candidate, abs };
    }
    return null;
  }

  /**
   * What the client is told about agent credentials: whether a usable key
   * exists and where it came from — never the key itself.
   */
  async function settingsSummary(root: string): Promise<JsonResult> {
    const stored = (await readAppSettings(root)).apiKey?.trim();
    const resolved = await resolveApiKey(root);
    return {
      status: 200,
      body: { ok: true, hasKey: resolved !== null, source: stored ? 'project' : resolved ? 'environment' : null },
    };
  }

  const ctx = {
    repoRoot,
    sessions,
    /** Desktop-export progress bus; ws.ts subscribes and fans frames to sockets. */
    exportBus,

    /**
     * Open any folder as the working folder. Unlike `openProject` this does
     * NOT require a hearth.json: the app's whole premise is that the agent
     * builds a game in a folder however it wants, so an empty folder is a
     * perfectly good starting point. A folder that also happens to be a Hearth
     * project reports `isHearthProject` so callers can offer more.
     */
    async openWorkspace(rawPath: unknown): Promise<JsonResult> {
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "path" (absolute folder).' } };
      }
      const root = path.resolve(rawPath.trim());
      if (!(await isDirectory(root))) {
        return { status: 400, body: { ok: false, error: `Not a folder: ${root}` } };
      }
      openedRoots.add(root);
      const name = path.basename(root) || root;
      const isHearthProject = await pathExists(path.join(root, 'hearth.json'));
      await addRecent(root, name);
      return { status: 200, body: { ok: true, path: root, name, isHearthProject } };
    },

    /** Recently opened folders, each flagged with whether it still exists. */
    async recentWorkspaces(): Promise<JsonResult> {
      const entries = await readRecents();
      const projects = await Promise.all(
        entries.map(async (e) => ({ path: e.path, name: e.name, exists: await isDirectory(e.path) })),
      );
      return { status: 200, body: { ok: true, projects } };
    },

    /**
     * Whether this folder currently holds a playable web game, where its entry
     * point is, and how fresh it is. The game pane polls this: a changed
     * `mtime` is its cue to reload the iframe.
     */
    async gameStatus(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "project".' } };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) return { status: 403, body: { ok: false, error: 'Folder is not open.' } };
      const found = await resolveGameEntry(root);
      if (!found) return { status: 200, body: { ok: true, present: false, entry: null, mtime: 0 } };
      const mtime = await newestMtimeMs(path.dirname(found.abs));
      return { status: 200, body: { ok: true, present: true, entry: found.entry, mtime } };
    },

    /**
     * What Hearth can currently sense about this game — a read-out, not a
     * feature list. Preview, errors and screenshots come free with any web game
     * the adapter can open; entities, events and scenes are claimed only when
     * the last sweep's adapter actually declared them (i.e. the game shipped a
     * probe shim). `playing` reports whether a sweep is running right now, so
     * the Playtest button survives a reload mid-sweep.
     */
    async probeStatus(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "project".' } };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) return { status: 403, body: { ok: false, error: 'Folder is not open.' } };
      const [game, record] = await Promise.all([resolveGameEntry(root), readCapabilities(root)]);
      return {
        status: 200,
        body: {
          ok: true,
          senses: sensesFromCapabilities(record, game !== null),
          playing: sweeps.isBusy(root),
          shimDetected: record?.shimDetected === true,
        },
      };
    },

    /**
     * Play the game. Resolves the same entry the pane is showing, hands its
     * folder to the web adapter, and runs a seeded sweep whose milestones land
     * in `.hearth/evidence/journal.jsonl` — already tailed by the evidence
     * watcher, so the rail fills while this is still running.
     *
     * The job runs off the request (a sweep takes tens of seconds and its
     * progress has its own channel); the response only says it started. A
     * second request while one is running is a 409, never a queue.
     */
    async startProbeSweep(project: unknown, request: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "project".' } };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) return { status: 403, body: { ok: false, error: 'Folder is not open.' } };
      const game = await resolveGameEntry(root);
      if (!game) {
        return { status: 400, body: { ok: false, error: 'No game to play yet — nothing in this folder runs.' } };
      }
      const plan = planSweep((request ?? {}) as Parameters<typeof planSweep>[0]);
      try {
        const job = sweeps.start({
          root,
          dir: path.dirname(game.abs),
          target: path.basename(root) || root,
          plan,
        });
        return {
          status: 200,
          body: { ok: true, started: true, policies: job.plan.policies, seeds: job.plan.seeds, maxSteps: job.plan.maxSteps },
        };
      } catch (err) {
        if (err instanceof SweepBusyError) {
          return { status: 409, body: { ok: false, error: err.message } };
        }
        return { status: 500, body: { ok: false, error: (err as Error).message } };
      }
    },

    /** The in-flight sweep for `root`, so callers (and tests) can await it. */
    sweepJob(root: string) {
      return sweeps.jobFor(path.resolve(root));
    },

    // --- Conversations ------------------------------------------------------

    /** Every conversation this folder holds, newest activity first. */
    async listProjectChats(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "project".' } };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) return { status: 403, body: { ok: false, error: 'Folder is not open.' } };
      return { status: 200, body: { ok: true, chats: await listChats(root) } };
    },

    async createProjectChat(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "project".' } };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) return { status: 403, body: { ok: false, error: 'Folder is not open.' } };
      const chat = await createChat(root);
      return { status: 200, body: { ok: true, chat, chats: await listChats(root) } };
    },

    async renameProjectChat(project: unknown, chatId: unknown, title: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || typeof chatId !== 'string' || typeof title !== 'string') {
        return { status: 400, body: { ok: false, error: 'Missing "project", "chatId" or "title".' } };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) return { status: 403, body: { ok: false, error: 'Folder is not open.' } };
      const chat = await renameChat(root, chatId, title);
      if (!chat) return { status: 404, body: { ok: false, error: 'No such conversation.' } };
      return { status: 200, body: { ok: true, chat, chats: await listChats(root) } };
    },

    async deleteProjectChat(project: unknown, chatId: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || typeof chatId !== 'string') {
        return { status: 400, body: { ok: false, error: 'Missing "project" or "chatId".' } };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) return { status: 403, body: { ok: false, error: 'Folder is not open.' } };
      const removed = await deleteChat(root, chatId);
      if (!removed) return { status: 404, body: { ok: false, error: 'No such conversation.' } };
      return { status: 200, body: { ok: true, chats: await listChats(root) } };
    },

    /**
     * Flat, read-only listing of the folder's files for the code peek. Skips
     * the noise directories, caps the result, and never leaves the root.
     */
    async listFiles(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "project".' } };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) return { status: 403, body: { ok: false, error: 'Folder is not open.' } };
      const files: { path: string; size: number }[] = [];
      const stack = [root];
      let budget = 2000;
      while (stack.length > 0 && budget > 0) {
        const dir = stack.pop()!;
        let entries: import('node:fs').Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (budget-- <= 0) break;
          if (entry.isDirectory()) {
            if (!MTIME_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(path.join(dir, entry.name));
            continue;
          }
          const abs = path.join(dir, entry.name);
          const rel = path.relative(root, abs).split(path.sep).join('/');
          try {
            files.push({ path: rel, size: (await fsp.stat(abs)).size });
          } catch {
            /* vanished mid-walk */
          }
        }
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { status: 200, body: { ok: true, files } };
    },

    /**
     * Agent settings for this folder. The key itself never leaves the server —
     * the client only learns whether one is configured, and where it came from.
     */
    async getAppSettings(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "project".' } };
      }
      return settingsSummary(path.resolve(project));
    },

    async setAppSettings(project: unknown, apiKey: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "project".' } };
      }
      if (typeof apiKey !== 'string') {
        return { status: 400, body: { ok: false, error: '"apiKey" must be a string.' } };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) return { status: 403, body: { ok: false, error: 'Folder is not open.' } };
      await writeAppSettings(root, { apiKey });
      return settingsSummary(root);
    },

    /**
     * Serve a file from one of the static mounts. `key` is the base64url
     * project root; `rel` is resolved inside it (or inside its evidence dir),
     * and anything escaping is refused.
     */
    async serveMounted(mount: 'game' | 'evidence', key: string, rel: string): Promise<FileResult> {
      const root = decodeRootKey(key);
      if (!root) return { status: 400, body: { ok: false, error: 'Malformed mount key.' } };
      const resolvedRoot = path.resolve(root);
      if (!isOpenRoot(resolvedRoot)) return { status: 403, body: { ok: false, error: 'Folder is not open.' } };
      const base = mount === 'evidence' ? path.join(resolvedRoot, EVIDENCE_DIR) : resolvedRoot;
      const abs = path.resolve(base, rel === '' ? '.' : rel);
      if (abs !== base && !abs.startsWith(base + path.sep)) {
        return { status: 403, body: { ok: false, error: 'Path escapes the mount.' } };
      }
      try {
        const stat = await fsp.stat(abs);
        if (stat.isDirectory()) return { status: 404, body: { ok: false, error: 'Not a file.' } };
        return { status: 200, contentType: contentTypeFor(abs), data: new Uint8Array(await fsp.readFile(abs)) };
      } catch {
        return { status: 404, body: { ok: false, error: `Not found: ${rel}` } };
      }
    },

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
        openedRoots.add(root);
        await addRecent(root, info?.name ?? path.basename(root));
        await provisionAgentMcp(root);
        return { status: 200, body: { ok: true, path: root, info: result.data } };
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        return { status, body: { ok: false, error: (err as Error).message } };
      }
    },

    async createNewProject(
      dir: unknown,
      name: unknown,
      description?: unknown,
      template?: unknown,
    ): Promise<JsonResult> {
      if (typeof dir !== 'string' || dir.trim() === '' || typeof name !== 'string' || name.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Both "dir" and "name" are required.' } };
      }
      if (template !== undefined && template !== null && template !== '') {
        if (typeof template !== 'string' || !listTemplates().some((t) => t.name === template)) {
          const valid = listTemplates()
            .map((t) => t.name)
            .join(', ');
          return {
            status: 400,
            body: { ok: false, error: `Unknown template "${String(template)}". Available templates: ${valid}.` },
          };
        }
      }
      try {
        const baseDir = path.resolve(dir.trim());
        const slug = slugify(name.trim());
        const target = slug ? path.join(baseDir, slug) : baseDir;
        const useTemplate = typeof template === 'string' && template !== '';
        if (useTemplate) {
          if (await pathExists(path.join(target, 'hearth.json'))) {
            const err = new Error(`A Hearth project already exists at ${target}`) as Error & { code: string };
            err.code = 'CONFLICT';
            throw err;
          }
          await scaffoldFromTemplate(nodeFs, getTemplatePath(template), target, {
            name: name.trim(),
            description: typeof description === 'string' ? description : undefined,
          });
        } else {
          await createProject(nodeFs, target, {
            name: name.trim(),
            description: typeof description === 'string' ? description : undefined,
          });
        }
        const session = await getSession(target);
        const result = await session.execute('inspectProject');
        const info = result.data as { name?: string };
        openedRoots.add(target);
        await addRecent(target, info?.name ?? name.trim());
        await provisionAgentMcp(target);
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
      return runCommandImpl(project, name, params);
    },

    /**
     * Run the exportWeb command (static playable web build). Always 200; the
     * CommandResult envelope carries success/errors, like /api/command. When
     * `zip` is true and the export succeeds, the output folder is archived to
     * `<slug>-web.zip` next to it (mirrors the CLI's `export web --zip`
     * naming), and the project-relative zip path is added to the result.
     */
    async exportWebBuild(project: unknown, outDir: unknown, singleFile: unknown, zip?: unknown): Promise<JsonResult> {
      const params: Record<string, unknown> = {};
      if (typeof outDir === 'string' && outDir.trim() !== '') params.outDir = outDir;
      if (typeof singleFile === 'boolean') params.singleFile = singleFile;
      const jsonResult = await runCommandImpl(project, 'exportWeb', params);

      if (zip === true && typeof project === 'string') {
        const body = jsonResult.body as CommandResult<{
          outDir: string;
          slug: string;
          zip?: string;
          files: string[];
        }>;
        if (body.success && body.data) {
          const root = path.resolve(project);
          const outAbs = path.resolve(root, body.data.outDir);
          // Next to (not inside) the out dir, so index.html sits at the zip
          // root — what itch.io expects. Same layout as the CLI helper.
          const zipAbs = path.join(path.dirname(outAbs), `${body.data.slug}-web.zip`);
          // The export itself has already succeeded and been persisted by
          // the time we get here; a failure zipping it (disk full,
          // permissions) must not turn that into a failed result — same
          // reasoning as session.ts's HISTORY_RECORD_FAILED /
          // JOURNAL_RECORD_FAILED warnings for a post-mutation step that
          // fails after the real work is done. Report it as a warning on
          // the normal envelope instead of letting the exception escape to
          // the transport's top-level catch (mirrors the MCP server's fix).
          try {
            const { zipDirectory } = await import('@hearth/shipping');
            await zipDirectory(outAbs, zipAbs);
            const zipRel = path.relative(root, zipAbs).split(path.sep).join('/');
            body.data.zip = zipRel;
            body.data.files.push(zipRel);
            body.files.push(zipRel);
          } catch (err) {
            body.warnings.push({
              code: 'ZIP_FAILED',
              message: `Export succeeded, but zipping the output failed: ${(err as Error).message}`,
            });
          }
        }
      }
      return jsonResult;
    },

    /**
     * GET /api/export/capability: the signing rung this environment selects
     * (adhoc / identity / identity+notarize) plus the desktop platform ids the
     * export dialog offers. Read-only; drives the dialog's pre-run summary.
     */
    async exportCapability(): Promise<JsonResult> {
      const { describeSigningCapability } = await import('@hearth/shipping');
      return {
        status: 200,
        body: { ok: true, capability: describeSigningCapability(), platforms: DESKTOP_PLATFORMS },
      };
    },

    /**
     * POST /api/export/desktop: start ONE desktop export job. Returns
     * `{ ok, jobId }` immediately; the job runs off-request and streams
     * progress over the ws (export-progress) then a terminal export-done /
     * export-error. A second start while one is running is refused with a
     * 409 (the caller should wait for the running job to finish).
     */
    async startDesktopExport(project: unknown, outDir: unknown, platforms: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return { status: 400, body: { ok: false, error: 'Missing "project" (absolute project folder).' } };
      }
      if (activeExport && !activeExport.done) {
        return {
          status: 409,
          body: {
            ok: false,
            error: 'A desktop export is already running. Wait for it to finish before starting another.',
            jobId: activeExport.jobId,
          },
        };
      }
      let session: HearthSession;
      try {
        session = await getSession(project);
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        return { status, body: { ok: false, error: (err as Error).message } };
      }

      const root = path.resolve(project);
      const jobId = randomUUID();
      const job: ExportJob = { jobId, root, done: false };
      activeExport = job;

      const params: Record<string, unknown> = {};
      if (typeof outDir === 'string' && outDir.trim() !== '') params.outDir = outDir;
      if (Array.isArray(platforms) && platforms.length > 0) params.platforms = platforms;

      // Fire-and-forget: the response returns now with the jobId; results land
      // on the export bus. Any throw is turned into an export-error frame.
      void (async () => {
        try {
          const result = await session.execute('exportDesktop', params);
          await syncSeenSeq(root);
          if (result.success) {
            const data = result.data as DesktopExportResult;
            await attachZipSizes(root, data.builds);
            emitExport(root, { type: 'export-done', jobId, result: data });
          } else {
            const message = result.errors[0]?.message ?? 'Desktop export failed.';
            const platform = extractFailingPlatform(message);
            emitExport(root, {
              type: 'export-error',
              jobId,
              ...(platform ? { platform } : {}),
              message,
            });
          }
        } catch (err) {
          const message = (err as Error).message;
          const platform = (err as { platform?: DesktopPlatform }).platform ?? extractFailingPlatform(message);
          emitExport(root, {
            type: 'export-error',
            jobId,
            ...(platform ? { platform } : {}),
            message,
          });
        } finally {
          job.done = true;
          if (activeExport === job) activeExport = null;
        }
      })();

      return { status: 200, body: { ok: true, jobId } };
    },

    /**
     * Import an uploaded file (base64 body) as a project asset. The bytes are
     * staged under assets/imported/, then registered through the importAsset
     * command (which copies them to the canonical assets/<type>/ folder), and
     * the staging file is removed. Always 200; the CommandResult envelope
     * carries success/errors, like /api/command.
     */
    async importAssetFile(project: unknown, filename: unknown, dataBase64: unknown): Promise<JsonResult> {
      const fail = (code: string, message: string): JsonResult => ({
        status: 200,
        body: errorEnvelope('importAsset', code, message),
      });
      if (typeof project !== 'string' || project.trim() === '') {
        return fail('NO_PROJECT', 'No project path supplied with the import.');
      }
      if (typeof filename !== 'string' || typeof dataBase64 !== 'string' || dataBase64 === '') {
        return fail('INVALID_INPUT', 'Import requires "filename" and "dataBase64".');
      }
      const safeName = sanitizeImportFilename(filename);
      if (!safeName) {
        return fail('INVALID_INPUT', `Cannot import "${filename}": the filename has no usable name or extension.`);
      }
      const ext = safeName.split('.').pop()!.toLowerCase();
      if (!IMPORT_EXTENSIONS.has(ext)) {
        return fail(
          'INVALID_INPUT',
          `Cannot import .${ext} files. Supported: ${[...IMPORT_EXTENSIONS].map((e) => `.${e}`).join(', ')}.`,
        );
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(dataBase64, 'base64');
      } catch {
        return fail('INVALID_INPUT', 'dataBase64 is not valid base64.');
      }
      if (bytes.length === 0) {
        return fail('INVALID_INPUT', `"${safeName}" decoded to zero bytes.`);
      }
      if (bytes.length > MAX_IMPORT_BYTES) {
        const mb = (bytes.length / (1024 * 1024)).toFixed(1);
        return fail('INVALID_INPUT', `"${safeName}" is ${mb} MB; imports are limited to 25 MB.`);
      }

      let session: HearthSession;
      try {
        session = await getSession(project);
      } catch (err) {
        return fail('NO_PROJECT', (err as Error).message);
      }
      const root = path.resolve(project);
      const stagedAbs = resolveInside(root, path.join(IMPORT_STAGING_DIR, safeName));
      if (!stagedAbs) {
        return fail('INVALID_INPUT', 'Import path escapes the project root.');
      }
      try {
        await fsp.mkdir(path.dirname(stagedAbs), { recursive: true });
        await fsp.writeFile(stagedAbs, bytes);
        const result = await session.execute('importAsset', { sourcePath: stagedAbs });
        await syncSeenSeq(root);
        return { status: 200, body: result };
      } catch (err) {
        return fail('INTERNAL', (err as Error).message);
      } finally {
        // The staging copy is only a hand-off to importAsset; drop it whether
        // or not the command succeeded so retries start clean.
        await fsp.rm(stagedAbs, { force: true }).catch(() => {});
        // Remove the staging dir when it ends up empty (rmdir refuses otherwise).
        await fsp.rmdir(path.dirname(stagedAbs)).catch(() => {});
      }
    },

    /**
     * Import a batch of uploaded files (base64 bodies) as project assets in
     * ONE atomic importAssets call: every file is staged under
     * assets/imported/, importAssets runs once (one journal/undo entry
     * covering the whole batch), then every staging copy is removed. A file
     * that fails to decode/stage never reaches core — it's reported as a
     * skip directly, alongside whatever core itself skips (unknown
     * extension, etc). `imported`/`skipped` entries come back with `path`
     * rewritten from the internal staged path to the original filename the
     * browser sent, so the editor can report against what the user dragged
     * in. Always 200; the CommandResult envelope carries success/errors.
     */
    async importAssetsBatch(project: unknown, filesRaw: unknown, type: unknown): Promise<JsonResult> {
      const fail = (code: string, message: string): JsonResult => ({
        status: 200,
        body: errorEnvelope('importAssets', code, message),
      });
      if (typeof project !== 'string' || project.trim() === '') {
        return fail('NO_PROJECT', 'No project path supplied with the import.');
      }
      if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
        return fail('INVALID_INPUT', 'Import requires a non-empty "files" array.');
      }
      let typeOverride: string | undefined;
      if (type !== undefined) {
        if (typeof type !== 'string' || type.trim() === '') {
          return fail('INVALID_INPUT', '"type" must be a non-empty string.');
        }
        typeOverride = type;
      }

      let session: HearthSession;
      try {
        session = await getSession(project);
      } catch (err) {
        return fail('NO_PROJECT', (err as Error).message);
      }
      const root = path.resolve(project);

      const preSkipped: { path: string; code: string; message: string }[] = [];
      const sourcePaths: string[] = [];
      const stagedAbsPaths: string[] = [];
      const originalNameByStaged = new Map<string, string>();
      const usedStagedNames = new Set<string>();

      for (const raw of filesRaw) {
        const f = (raw ?? {}) as { filename?: unknown; dataBase64?: unknown };
        const displayName = typeof f.filename === 'string' ? f.filename : '(unnamed file)';
        if (typeof f.filename !== 'string' || typeof f.dataBase64 !== 'string' || f.dataBase64 === '') {
          preSkipped.push({ path: displayName, code: 'INVALID_INPUT', message: 'Each file requires "filename" and "dataBase64".' });
          continue;
        }
        const safeName = sanitizeImportFilename(f.filename);
        if (!safeName) {
          preSkipped.push({
            path: displayName,
            code: 'INVALID_INPUT',
            message: `Cannot import "${displayName}": the filename has no usable name or extension.`,
          });
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(f.dataBase64, 'base64');
        } catch {
          preSkipped.push({ path: displayName, code: 'INVALID_INPUT', message: `"${displayName}": dataBase64 is not valid base64.` });
          continue;
        }
        if (bytes.length === 0) {
          preSkipped.push({ path: displayName, code: 'INVALID_INPUT', message: `"${displayName}" decoded to zero bytes.` });
          continue;
        }
        if (bytes.length > MAX_IMPORT_BYTES) {
          const mb = (bytes.length / (1024 * 1024)).toFixed(1);
          preSkipped.push({ path: displayName, code: 'INVALID_INPUT', message: `"${displayName}" is ${mb} MB; imports are limited to 25 MB.` });
          continue;
        }

        // Distinct staging basenames within this batch — separate from
        // core's asset-name collision handling, this is just "don't let two
        // uploads clobber the same staging path before core ever sees them".
        let stagedName = safeName;
        if (usedStagedNames.has(stagedName)) {
          const dot = stagedName.lastIndexOf('.');
          const stem = dot > 0 ? stagedName.slice(0, dot) : stagedName;
          const ext = dot > 0 ? stagedName.slice(dot) : '';
          let n = 2;
          while (usedStagedNames.has(`${stem}-${n}${ext}`)) n++;
          stagedName = `${stem}-${n}${ext}`;
        }
        usedStagedNames.add(stagedName);

        const stagedAbs = resolveInside(root, path.join(IMPORT_STAGING_DIR, stagedName));
        if (!stagedAbs) {
          preSkipped.push({ path: displayName, code: 'INVALID_INPUT', message: 'Import path escapes the project root.' });
          continue;
        }
        try {
          await fsp.mkdir(path.dirname(stagedAbs), { recursive: true });
          await fsp.writeFile(stagedAbs, bytes);
        } catch (err) {
          preSkipped.push({ path: displayName, code: 'INTERNAL', message: (err as Error).message });
          continue;
        }
        stagedAbsPaths.push(stagedAbs);
        originalNameByStaged.set(stagedAbs, displayName);
        sourcePaths.push(stagedAbs);
      }

      try {
        if (sourcePaths.length === 0) {
          return {
            status: 200,
            body: {
              success: true,
              command: 'importAssets',
              data: { imported: [], skipped: preSkipped },
              errors: [],
              warnings: [],
              changed: [],
              files: [],
              suggestions: [],
            },
          };
        }
        const params: Record<string, unknown> = { sourcePaths };
        if (typeOverride) params.type = typeOverride;
        const result = (await session.execute('importAssets', params)) as CommandResult<{
          imported: { path: string; assetId: string; name: string; type: string }[];
          skipped: { path: string; code: string; message: string }[];
        }>;
        await syncSeenSeq(root);
        if (result.data) {
          result.data.imported = result.data.imported.map((i) => ({
            ...i,
            path: originalNameByStaged.get(i.path) ?? i.path,
          }));
          result.data.skipped = [
            ...result.data.skipped.map((s) => ({ ...s, path: originalNameByStaged.get(s.path) ?? s.path })),
            ...preSkipped,
          ];
        }
        return { status: 200, body: result };
      } finally {
        // The staging copies are only a hand-off to importAssets; drop them
        // whether or not the command succeeded so retries start clean.
        for (const abs of stagedAbsPaths) {
          await fsp.rm(abs, { force: true }).catch(() => {});
        }
        await fsp.rmdir(path.join(root, IMPORT_STAGING_DIR)).catch(() => {});
      }
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
      if (!isOpenRoot(root) && !(await pathExists(path.join(root, 'hearth.json')))) {
        return { status: 403, body: { ok: false, error: `Not an open Hearth folder: ${root}` } };
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
      if (!isOpenRoot(root) && !(await pathExists(path.join(root, 'hearth.json')))) {
        return { status: 403, body: { ok: false, error: `Not an open Hearth folder: ${root}` } };
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
      const toolPaths = await resolveToolPaths(repoRoot);

      return {
        status: 200,
        body: {
          ok: true,
          repoRoot,
          home: os.homedir(),
          hearthVersion: HEARTH_VERSION,
          runtimeAvailable,
          toolPaths,
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

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 10 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/**
 * Transport-agnostic API request handler: used by the Vite dev-server plugin
 * below and by the Electron main process (which serves the same routes from
 * a plain node:http server).
 */
export async function handleApiRequest(
  ctx: ProjectServerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return route(ctx, req, res);
}

async function route(ctx: ProjectServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const originCheck = isRequestAllowed({
    origin: req.headers.origin,
    host: req.headers.host,
  });
  if (!originCheck.ok) {
    return sendJson(res, 403, { ok: false, error: 'Forbidden: cross-origin request rejected' });
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams;
  const method = req.method ?? 'GET';
  const key = `${method} ${url.pathname}`;

  // Static mounts come before the route table: their paths are open-ended
  // (`/game/<key>/whatever/the/game/ships`), not a fixed set of endpoints.
  for (const [mount, prefix] of [
    ['game', GAME_MOUNT],
    ['evidence', EVIDENCE_MOUNT],
  ] as const) {
    if (!url.pathname.startsWith(prefix)) continue;
    const rest = url.pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    const rootKey = slash === -1 ? rest : rest.slice(0, slash);
    const relRaw = slash === -1 ? '' : rest.slice(slash + 1);
    let rel: string;
    try {
      rel = decodeURIComponent(relRaw);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Malformed path.' });
    }
    const result = await ctx.serveMounted(mount, rootKey, rel === '' ? 'index.html' : rel);
    if (result.data !== undefined) {
      res.statusCode = result.status;
      res.setHeader('Content-Type', result.contentType ?? 'application/octet-stream');
      // Never cached: the whole point of the pane is that it shows what the
      // agent just wrote, and a reload must fetch the new bytes.
      res.setHeader('Cache-Control', 'no-store');
      res.end(Buffer.from(result.data));
      return;
    }
    return sendJson(res, result.status, result.body);
  }

  switch (key) {
    case 'POST /api/workspace/open': {
      const body = await readJsonBody(req);
      const result = await ctx.openWorkspace(body.path);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/workspace/recent': {
      const result = await ctx.recentWorkspaces();
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/game/status': {
      const result = await ctx.gameStatus(q.get('project'));
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/probe/status': {
      const result = await ctx.probeStatus(q.get('project'));
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/probe/sweep': {
      const body = await readJsonBody(req);
      const result = await ctx.startProbeSweep(body.project, body);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/chats': {
      const result = await ctx.listProjectChats(q.get('project'));
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/chats/new': {
      const body = await readJsonBody(req);
      const result = await ctx.createProjectChat(body.project);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/chats/rename': {
      const body = await readJsonBody(req);
      const result = await ctx.renameProjectChat(body.project, body.chatId, body.title);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/chats/delete': {
      const body = await readJsonBody(req);
      const result = await ctx.deleteProjectChat(body.project, body.chatId);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/files': {
      const result = await ctx.listFiles(q.get('project'));
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/app/settings': {
      const result = await ctx.getAppSettings(q.get('project'));
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/app/settings': {
      const body = await readJsonBody(req);
      const result = await ctx.setAppSettings(body.project, body.apiKey);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/project/open': {
      const body = await readJsonBody(req);
      const result = await ctx.openProject(body.path);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/project/create': {
      const body = await readJsonBody(req);
      const result = await ctx.createNewProject(body.dir, body.name, body.description, body.template);
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
    case 'POST /api/assets/import': {
      // Base64 inflates the 25 MB file limit by ~4/3, plus JSON overhead.
      const body = await readJsonBody(req, 36 * 1024 * 1024);
      const result = await ctx.importAssetFile(body.project, body.filename, body.dataBase64);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/assets/import-batch': {
      // Each file is still capped at 25 MB client-side; this just bounds the
      // whole multi-file request body (base64 + JSON overhead) generously.
      const body = await readJsonBody(req, 256 * 1024 * 1024);
      const result = await ctx.importAssetsBatch(body.project, body.files, body.type);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/export/web': {
      const body = await readJsonBody(req);
      const result = await ctx.exportWebBuild(body.project, body.outDir, body.singleFile, body.zip);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/export/desktop': {
      const body = await readJsonBody(req);
      const result = await ctx.startDesktopExport(body.project, body.outDir, body.platforms);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/export/capability': {
      const result = await ctx.exportCapability();
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
        // /api/* plus the /game/ and /evidence/ static mounts; everything else
        // is Vite's (the editor UI itself).
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (!isHearthServerPath(pathname)) return next();
        route(ctx, req, res).catch((err: unknown) => {
          sendJson(res, 500, { ok: false, error: (err as Error).message ?? 'Internal error' });
        });
      });
      // Absent in middleware mode (Vite embedded in another server); the /api
      // routes above still work there, just without the WS channel. Vite's
      // httpServer type also covers http2's secure server (HTTPS dev
      // certs), which this dev server never uses; attachWebSocket only
      // needs the plain node:http surface (`.on('upgrade'/'close', ...)`).
      if (server.httpServer) {
        attachWebSocket(server.httpServer as import('node:http').Server, ctx);
      }
    },
  };
}
