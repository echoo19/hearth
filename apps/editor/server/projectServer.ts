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
import os from 'node:os';
import path from 'node:path';
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
import { GAME_ENTRY_CANDIDATES } from './agentFacts.js';
import { ensureHearthMcpConfig } from './mcpConfig.js';
import { hearthHome } from './skills.js';
import {
  createChatDriver,
  readAppSettings,
  writeAppSettings,
  resolveApiKey,
  StubDriver,
  type AppSettings,
  type ChatDriver,
} from './chat.js';
import { framesDir, listSessions, nextSessionId as nextTesterSessionId, readMemory } from './tester/memory.js';
import { approvalSeed, frameFile } from './tester/report.js';
import {
  runTesterSession,
  DEFAULT_MAX_STEPS,
  MAX_MAX_STEPS,
  type TesterGame,
  type TesterPhase,
} from './tester/session.js';
import { readProjectIdentity, writeProjectIdentity } from './projectIdentity.js';
import {
  contextDir,
  deleteContextFile,
  listContextFiles,
  readContextFile,
  saveContextFiles,
} from './projectContext.js';
import { announceProviders, beginOpenAiLogin, readChatProviders } from './chatProviders.js';
import { createChat, deleteChat, getChat, listChats, renameChat, safeChatId, type ChatKind } from './chatStore.js';
import { deleteDevTeamArtifacts } from './devTeamStore.js';
import { ChatAttachmentStager } from './chatAttachments.js';
import { resolveProjectsHome, slugFromName, slugFromPrompt, uniqueFolderName } from './workspaceSlug.js';
import { readCapabilities, sensesFromCapabilities } from './probeCapabilities.js';
import { EVIDENCE_DIR } from './evidenceWatcher.js';
import { collectUsage } from './usage.js';
import {
  attachWebSocket,
  type ExportFrame,
  type ExportStage,
  type DesktopExportResult,
  type TesterFrame,
} from './ws.js';
import { attachProbeStream, type ProbeBusMessage } from './probeStream.js';
import { startGameServer, type GameServerHandle } from './gameServer.js';

export { attachWebSocket } from './ws.js';

// ---------------------------------------------------------------------------
// Static mounts
//
// The game pane iframes whatever web game the agent built, and the evidence
// rail shows screenshots the probe captured. Both are files inside the user's
// project folder, served from two mounts:
//
//   /game/<key>/<rel>       — the project folder
//   /evidence/<key>/<rel>   — the project's .hearth/evidence folder
//
// `<key>` is the base64url-encoded absolute project root. Encoding the root
// into the path (rather than a ?project= query) is what makes a game's own
// relative asset URLs — `./main.js`, `assets/sprite.png` — resolve correctly
// from inside the iframe, since they resolve against the mount as their base.
//
// Both mounts are served by server/gameServer.ts on a SEPARATE loopback port,
// not by this server. `serveMounted` below is still where the rules live (the
// folder must be open, the path must not escape it); only the transport moved.
// Read gameServer.ts's header for why: bytes the agent wrote must never be
// handed to a browser on the same origin as the API that spawns shells.
// ---------------------------------------------------------------------------

export { GAME_MOUNT, EVIDENCE_MOUNT } from './gameServer.js';

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
 * Does this mount-relative path go through a hidden (dot-prefixed) name?
 *
 * WHY THE MOUNTS REFUSE THESE, AND WHY THE MOUNT BASE IS STILL THE PROJECT ROOT
 *
 * `/game/<key>/<rel>` resolves `rel` against the project ROOT and hands the
 * bytes to the GAME's origin, where the code reading them is whatever the agent
 * wrote. The root is the right base and must stay the right base: a game that
 * builds to `dist/index.html` and points back at `../assets/atlas.png`, or that
 * keeps shared art one folder up from its entry, is an ordinary game, and
 * re-basing the mount on the entry's own directory would break it. (For the
 * common `index.html` entry that re-basing also fixes nothing, since the entry's
 * directory IS the root.) So the reach stays and the rule goes on the NAME.
 *
 * What must never be in that reach is `.hearth/`: `app.json` holds the user's
 * saved Anthropic and OpenAI keys, `chats/` holds every conversation. The mount
 * key is sitting in the game's own `location.pathname`, so
 * `fetch(location.pathname.split('/').slice(0,3).join('/') + '/.hearth/app.json')`
 * was a two-line credential read with nothing to guess.
 *
 * Generalized to every dot-prefixed segment rather than to `.hearth` alone,
 * because the same reach covers `.git/config` (push credentials), `.env`,
 * `.npmrc`, `.mcp.json`, and whatever the next hidden thing to land in a project
 * folder turns out to be. This costs no legitimate game anything: no web game
 * loads a dot-prefixed asset, and every static file server already hides them.
 * Do not narrow this back to `.hearth`, and do not "simplify" the mount base.
 *
 * Takes an ALREADY-RESOLVED relative path (`path.relative(base, abs)`), so `..`
 * and `./` are gone before they get here and a caller cannot spell a hidden
 * segment around the check.
 */
export function hasHiddenSegment(relFromBase: string): boolean {
  return relFromBase.split(path.sep).some((segment) => segment.startsWith('.'));
}

/**
 * Paths this server owns. Both transports (the Vite dev-server middleware and
 * the Electron main process's http server) ask this before falling through to
 * their own static UI handling, so the API can never be shadowed by an
 * index.html fallback.
 *
 * The /game/ and /evidence/ mounts used to be claimed here too. They are not
 * any more, and must not come back: this origin runs the control plane, and a
 * project's own HTML executing on it is the exact hole gameServer.ts exists to
 * close. A stray /game/ request to this origin now falls through to the SPA
 * fallback and gets the editor's own index.html, which is inert.
 */
export function isHearthServerPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

/**
 * Vite's own escape hatch: `/@fs/<absolute path>` serves anything under
 * `server.fs.allow`, which vite.config.ts sets to the whole hearth-engine repo
 * because the editor's aliases import `packages/*` straight from source. Dev
 * only; the packaged Electron server has no such route.
 */
export function isViteFsPath(pathname: string): boolean {
  return pathname.startsWith('/@fs/');
}

/**
 * Fetch destinations that produce a DOCUMENT: something with an origin, a
 * script context, and therefore the ability to open `/api/ws`.
 */
const DOCUMENT_DESTINATIONS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

/**
 * What a request wants to become, as the browser itself declares it.
 * `'unknown'` is anything that sent no `Sec-Fetch-*` at all, which in practice
 * means it is not a browser (curl, the CLI, a test).
 */
export function fetchIntent(headers: {
  'sec-fetch-dest'?: string | string[];
  'sec-fetch-mode'?: string | string[];
}): 'document' | 'subresource' | 'unknown' {
  const first = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  const dest = first(headers['sec-fetch-dest']);
  const mode = first(headers['sec-fetch-mode']);
  if (dest === null && mode === null) return 'unknown';
  if (dest !== null && DOCUMENT_DESTINATIONS.has(dest)) return 'document';
  if (mode === 'navigate') return 'document';
  return 'subresource';
}

/**
 * May this `/@fs/` request go through to Vite, and with what headers?
 *
 * THE HOLE THIS CLOSES (dev only)
 *
 * `GET /api/file` was made inert as a document (`Content-Security-Policy:
 * sandbox`) because the game frame carries `allow-popups` WITHOUT
 * `allow-popups-to-escape-sandbox`, so a popup inherits `allow-same-origin`:
 * `window.open` on a control-plane URL that answers `text/html` runs
 * agent-written script AS the editor, which satisfies originGuard.ts, which
 * reaches `/api/ws?project=<an open root>`, which reaches `pty-start`.
 * `/@fs/` re-opened exactly that: it answers `text/html` for any `.html` under
 * the repo, with no CSP and no nosniff, and a user's project inside
 * `packages/examples/` is the ordinary case, not a contrived one.
 *
 * A document is the only thing that can do this, and the editor NEVER navigates
 * to `/@fs/`: it fetches modules from there, nothing more. So a
 * document-destination request is refused outright, and every module, style,
 * image, wasm and worker fetch is untouched. That is the difference between a
 * fix the caller cannot get around and one that costs the developer a feature.
 *
 * A client that sends no `Sec-Fetch-*` is not a browser and is not the threat,
 * so it still gets its bytes, just with the same inert-as-a-document headers
 * `/api/file` uses, in case something exotic ever renders them.
 *
 * The other half of this lives in vite.config.ts: Vite's dev CORS echoes any
 * loopback Origin, so the game could also just `fetch()` these bytes and READ
 * the reply. See the `cors` and `fs.deny` settings there.
 */
export function viteFsVerdict(headers: {
  'sec-fetch-dest'?: string | string[];
  'sec-fetch-mode'?: string | string[];
}): 'pass' | 'deny' | 'inert' {
  const intent = fetchIntent(headers);
  if (intent === 'document') return 'deny';
  if (intent === 'unknown') return 'inert';
  return 'pass';
}

/**
 * Applies `viteFsVerdict` to a live request. True when the request was answered
 * here and must not reach Vite. Exported so a test can drive the real thing
 * rather than a paraphrase of it.
 */
export function guardViteFs(req: IncomingMessage, res: ServerResponse): boolean {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (!isViteFsPath(pathname)) return false;
  const verdict = viteFsVerdict(req.headers);
  if (verdict === 'deny') {
    sendJson(res, 403, {
      ok: false,
      error: 'Forbidden: /@fs/ does not serve documents.',
    });
    return true;
  }
  if (verdict === 'inert') {
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  return false;
}

/**
 * Where a project's web game lives, in priority order. Declared in
 * agentFacts.ts — a leaf module — because the same list is also STATED to the
 * agent in its system prompt, and two copies of "where the pane looks" would
 * drift into an agent being told the wrong place.
 */
export { GAME_ENTRY_CANDIDATES };

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
  /**
   * Where `POST /api/workspace/create` puts the folders it makes. Default:
   * `$HEARTH_PROJECTS_DIR`, else `~/Hearth`. Tests point it at a temp dir so
   * they never write into the real home.
   */
  projectsDir?: string;
  /** Monorepo root (for example projects + agent docs). Auto-detected by default. */
  repoRoot?: string;
  /**
   * Test seam: override the desktop packager. Defaults to a lazy import of
   * @hearth/shipping's `packageDesktop` (which needs Node + Electron), so
   * suites can inject a stub and never touch the real toolchain.
   */
  packageDesktop?: PackageDesktopFn;
  /**
   * Test seam: stand in the tester's model backend and its browser. Defaults to
   * the user's configured agent and a real headless Chromium, so a suite that
   * did not inject these would spend someone's quota to prove a route returns
   * 409.
   */
  testerDeps?: {
    createDriver?: (root: string) => Promise<ChatDriver>;
    openGame?: (opts: { dir: string; onFrame?: (data: string) => void }) => Promise<TesterGame>;
  };
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

/**
 * The project documents the renderer may read and write. An allowlist, not a
 * path parameter: this pair is reachable from the browser, and "any file in
 * the project" is a far larger promise than the one screen using it needs.
 */
const PROJECT_DOCS = ['AGENTS.md'] as const;

interface RecentEntry {
  path: string;
  name: string;
  openedAt: string;
}

/**
 * One conversation in the GLOBAL recents list (GET /api/chats/recent) — the
 * sidebar's chat history spans folders, so each row carries the folder it
 * belongs to; opening it means opening that folder first.
 */
export interface RecentChatEntry {
  id: string;
  title: string;
  /**
   * Chat or terminal session — carried so the rail can say which one a row is
   * without opening it. Read from the folder's index, where a record written
   * before kinds existed already reads as 'chat'.
   */
  kind: ChatKind;
  createdAt: string;
  updatedAt: string;
  project: { path: string; name: string };
}

/** How many conversations the global recents list returns. */
export const RECENT_CHATS_LIMIT = 40;

/**
 * What the global playtest history is allowed to cost.
 *
 * It walks `.hearth/tester/sessions/` for every recent project each time the
 * screen opens, so both ends are bounded: how many project folders are visited
 * at all, and how many runs come back. Twelve projects is more than the rail
 * itself shows; sixty runs is weeks of playing on a screen that is scanned,
 * not read to the bottom.
 */
export const MAX_HISTORY_PROJECTS = 12;
export const MAX_HISTORY_RUNS = 60;

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
 * The marker line identifying `.hearth/.gitignore` as ours — the same trick
 * `MIRROR_IGNORE_MARKER` plays in skills.ts, and for the same reason: matched
 * BEFORE the file is ever rewritten or removed, so a `.gitignore` a human put
 * there by hand, or one an older build of this app wrote in some other shape,
 * is left exactly alone.
 */
export const HEARTH_DIR_IGNORE_MARKER = '# Written by Hearth: everything in this folder is private to this machine.';

/**
 * Keep `.hearth/` out of the user's git history.
 *
 * Opening or creating a project (openWorkspaceImpl, openProject,
 * createNewProject below) is what materializes `.hearth/chats`,
 * `.hearth/tester` and `.hearth/log` — real conversation transcripts,
 * playtest recordings and the command journal — and, once Settings saves one,
 * `.hearth/app.json` with the user's own Anthropic/OpenAI key. A project
 * folder is an ordinary git repo the person may `git add .` at any time, and
 * until this ran that command committed all of it: private, and reachable by
 * anyone the repo is ever pushed to.
 *
 * `*` inside `.hearth/.gitignore` is the standard self-ignoring-directory
 * trick — git matches the pattern against every entry in that directory,
 * INCLUDING the `.gitignore` file itself, so the whole folder drops out of
 * `git status` rather than merely its contents.
 *
 * Called on every open, not only the first, which is what "heal it on open if
 * missing" means here: a project opened before this guard existed gets it the
 * next time someone opens it, with no migration step and no version check.
 * Marker-gated exactly like `writeMirrorIgnore`, so that healing can never
 * turn into clobbering — a `.gitignore` that does not start with the marker
 * is not this function's to touch, whoever wrote it and whenever.
 */
async function ensureHearthDirIgnored(root: string): Promise<void> {
  const dir = path.join(root, '.hearth');
  await fsp.mkdir(dir, { recursive: true }).catch(() => undefined);
  const file = path.join(dir, '.gitignore');
  const existing = await fsp.readFile(file, 'utf8').catch(() => null);
  if (existing !== null && !existing.startsWith(HEARTH_DIR_IGNORE_MARKER)) return;
  const body = [
    HEARTH_DIR_IGNORE_MARKER,
    '# Chats, playtest history, the command log and any saved API key belong to',
    '# this machine, not this project. `*` ignores every file in this folder,',
    '# including this .gitignore, so the folder never reaches `git status` at all.',
    '*',
    '',
  ].join('\n');
  if (existing === body) return; // already healthy: skip the write, not just the mkdir
  await fsp.writeFile(file, body, 'utf8').catch(() => undefined);
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
export async function resolveToolPaths(repoRoot: string): Promise<{
  cli: string;
  mcp: string;
  probe: string | null;
  bundled: boolean;
}> {
  const toolsDir = process.env.HEARTH_TOOLS_DIR;
  const bundledCli = toolsDir ? path.join(toolsDir, 'hearth-cli.mjs') : null;
  const bundledMcp = toolsDir ? path.join(toolsDir, 'hearth-mcp.mjs') : null;
  if (bundledCli && bundledMcp && (await pathExists(bundledCli)) && (await pathExists(bundledMcp))) {
    // The probe is best-effort in BOTH branches: an app updated in place can
    // carry a tools dir from before the probe shipped, and a checkout may not
    // have built probe-tools. Null means "not on this machine today" — the
    // shim skips it and the agent is never told about a command that 127s.
    const bundledProbe = path.join(toolsDir!, 'hearth-probe.mjs');
    return {
      cli: bundledCli,
      mcp: bundledMcp,
      probe: (await pathExists(bundledProbe)) ? bundledProbe : null,
      bundled: true,
    };
  }
  const repoProbe = path.join(repoRoot, 'packages', 'probe-tools', 'dist', 'cli.js');
  return {
    cli: path.join(repoRoot, 'packages', 'cli', 'dist', 'main.js'),
    mcp: path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'main.js'),
    probe: (await pathExists(repoProbe)) ? repoProbe : null,
    bundled: false,
  };
}

/**
 * Param names that carry a path into the HOST filesystem rather than a name
 * inside the project.
 *
 * Matched by name and not by value, because the alternative (scan every string
 * param for something that looks absolute) rejects a JavaScript file whose
 * first line is `//` (`path.isAbsolute('//x')` is true on posix), and
 * `editScript.source` is exactly that shape. Matched by suffix rather than
 * listed per command, so a core command added later is covered on the day it
 * lands instead of on the day someone remembers this table exists.
 */
const HOST_PATH_PARAM = /(^|[a-z])(path|paths|dir|dirs|file|files)$/i;

/**
 * Every absolute path named by `params` under a path-shaped key. Relative
 * values are left alone: core resolves those against the project root and
 * already refuses the ones that escape (`isSafeOut`, `isSafeRelativePath`,
 * `resolveScriptsPath`), so re-judging them here would only add a second
 * opinion that can drift from the first.
 *
 * Top level only. Nothing in core's command vocabulary nests a host path
 * inside an object today; if something does, it needs adding here.
 */
export function absolutePathParams(params: unknown): string[] {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (!HOST_PATH_PARAM.test(key)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry === 'string' && path.isAbsolute(entry)) found.push(entry);
    }
  }
  return found;
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
   * the file routes, the static mounts, AND the /api/ws upgrade: a request
   * must name a root that was deliberately opened, and every path is still
   * resolved inside it.
   */
  const openedRoots = new Set<string>();
  const chatAttachments = new ChatAttachmentStager();
  /**
   * Where the game mount is being served from this run (see gameServer.ts).
   * Set once the loopback listener is up; null until then, and null forever if
   * it could not start. The client is told over /api/meta and refuses to build
   * a game URL without it, which is what stops a failed start from quietly
   * falling back to this origin and reopening the hole.
   */
  let gameOrigin: string | null = null;
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
  // hearthHome() (server/skills.ts), not a bare os.homedir() join: it honors
  // HEARTH_HOME, which is how an isolated instance (a second profile, a test)
  // keeps its recents list to itself instead of reading and rewriting the
  // real one. Same default path either way — HEARTH_HOME unset resolves to
  // exactly `~/.hearth` — so this changes nothing for a normal install.
  const recentsFile = options.recentsFile ?? path.join(hearthHome(), 'recent-projects.json');
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

  // A running sweep's picture. Same split as the export bus below: the runner
  // emits frames tagged with the folder they came from, and probeStream.ts
  // decides who is watching. Nothing is retained here: an unwatched sweep
  // emits into an empty room, which costs one JSON.stringify it skips.
  const probeBus = new EventEmitter();

  // The tester's own channel: what it is thinking, where it has got to, and the
  // note it ends with. Separate from the picture bus above because the two have
  // genuinely different lifetimes and audiences — the frames go straight to an
  // <img> outside React, and these are small and belong in application state.
  const testerBus = new EventEmitter();
  interface TesterJob {
    root: string;
    session: number;
    controller: AbortController;
    done: Promise<void>;
  }
  const testerJobs = new Map<string, TesterJob>();
  const emitTester = (root: string, frame: TesterFrame): void => {
    testerBus.emit('frame', { root, frame });
  };

  // Desktop-export progress bus. One export runs at a time; the running job
  // routes packageDesktop's onProgress and its terminal result onto this bus,
  // tagged with the project root, and ws.ts fans frames out to that root's
  // sockets. Emitting here (not straight to sockets) keeps projectServer
  // transport-agnostic — the same as the journal/pty split.
  const exportBus = new EventEmitter();
  const beforeChatDelete = new Set<(root: string, chatId: string) => Promise<string | void>>();
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

  /**
   * The recents list, and whether it could actually be read.
   *
   * The second half matters more than it looks. Every caller used to get a
   * bare `[]` for "no file yet" AND for "the file is there but unreadable",
   * and `addRecent` writes back whatever it was given — so one transient read
   * error (a half-written file, a racing second server) silently replaced a
   * list of twelve projects with a list of one. That is not a stale cache; it
   * is the user's project list, gone, with nothing to say it happened.
   */
  async function readRecentsState(): Promise<{
    entries: RecentEntry[];
    readable: boolean;
  }> {
    let raw: string;
    try {
      raw = await fsp.readFile(recentsFile, 'utf8');
    } catch (err) {
      // Genuinely absent is a normal first run; anything else is a failure we
      // must not treat as "the list is empty".
      const missing = (err as { code?: string }).code === 'ENOENT';
      return { entries: [], readable: missing };
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? { entries: parsed, readable: true } : { entries: [], readable: false };
    } catch {
      return { entries: [], readable: false };
    }
  }

  async function readRecents(): Promise<RecentEntry[]> {
    return (await readRecentsState()).entries;
  }

  async function addRecent(projectPath: string, name: string): Promise<void> {
    const state = await readRecentsState();
    const entries = state.entries.filter((e) => e.path !== projectPath);
    entries.unshift({
      path: projectPath,
      name,
      openedAt: new Date().toISOString(),
    });
    await fsp.mkdir(path.dirname(recentsFile), { recursive: true });
    // Unreadable but present: keep a copy before replacing it. Whatever was in
    // there is the user's list, and "we could not parse it" is not permission
    // to delete it.
    if (!state.readable) {
      await fsp.copyFile(recentsFile, `${recentsFile}.bak`).catch(() => {});
    }
    // Write-then-rename, so a reader never sees a half-written file. That race
    // is what corrupted the list in the first place: two servers on the same
    // home directory, one reading while the other was mid-write.
    const temp = `${recentsFile}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(entries.slice(0, 12), null, 2) + '\n');
    await fsp.rename(temp, recentsFile);
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

  /**
   * Does `target` land inside a folder the caller is allowed to name: one of
   * the open roots, or `commandRoot`, the project the command is being run
   * against (which is that command's own subject, and is added to the open set
   * a moment later when its session opens).
   *
   * Deliberately "inside ANY open root" rather than "inside this project".
   * Importing an asset out of one open folder into another is a legitimate
   * thing to ask for, and narrowing to the single project would take that away
   * to fix a problem it is not part of.
   */
  function isInsideAllowedRoot(target: string, commandRoot: string): boolean {
    const abs = path.resolve(target);
    for (const root of [commandRoot, ...openedRoots, ...sessions.keys()]) {
      if (abs === root || abs.startsWith(root + path.sep)) return true;
    }
    return false;
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
      return {
        status: 200,
        body: errorEnvelope('(unknown)', 'NO_COMMAND', 'Missing command name.'),
      };
    }
    const root = path.resolve(project);

    // Absolute path params must land in a folder the caller may name.
    //
    // Several core commands take a path into the HOST filesystem rather than
    // into the project: `importAsset`/`importAssets` (`sourcePath`,
    // `sourcePaths`) COPY it in, and `inspectAssetPack` (`path`) walks it and
    // reports what it found. Core is right not to jail them: the CLI and the
    // MCP server import downloaded asset packs from wherever the user put
    // them, and core has no idea what a "folder the user opened" is. This
    // route does, and it is reachable from a browser, so the jail belongs
    // here: one open project was otherwise enough to copy any file on the disk
    // into it and then read it straight back out over /api/file or the /game/
    // mount, and enough to list any directory through the pack inspector.
    //
    // The check is on the LOCATION, not the command: nothing is taken away
    // from any command, it just has to name somewhere the caller is entitled
    // to name. A path outside every open folder becomes one by opening that
    // folder, which is a thing the user can do at any time.
    const outside = absolutePathParams(params).filter((p) => !isInsideAllowedRoot(p, root));
    if (outside.length > 0) {
      return {
        status: 200,
        body: errorEnvelope(
          commandName,
          'PATH_NOT_OPEN',
          `Outside every open folder: ${outside.join(', ')}. Open the folder that holds it first.`,
        ),
      };
    }

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

  /**
   * Is `root` readable through the file routes, the static mounts, or the
   * WebSocket channel?
   *
   * A resolved absolute path, always. Every caller must resolve before asking:
   * `openedRoots` holds resolved paths, so `isOpenRoot('/a/../a')` would say no
   * about a folder that is open.
   *
   * This is also exported on the context (see below), which it was not for a
   * long time, and that is why the /api/ws upgrade never called it: it was a
   * closure ws.ts had no way to reach, so a socket could name ANY path on the
   * disk and get a shell there. Anything that resolves a caller-supplied root
   * asks this first.
   */
  function isOpenRoot(root: string): boolean {
    return openedRoots.has(root) || sessions.has(root);
  }

  /**
   * Is `root` a folder the USER has named, whether or not it is open right now?
   *
   * Open, or on the recents list, which is the same list the rail renders. A
   * resolved absolute path, like isOpenRoot.
   *
   * This exists because "open" is too tight for two real flows and "any
   * directory" is far too loose for both. The rail lets you give a mark and a
   * colour to any row in its list, and those rows are recents, not open
   * folders: gating `POST /api/workspace/identity` on isOpenRoot would leave
   * Appearance silently doing nothing on every row but one. Every path on that
   * list got there because the user opened the folder, so it is still a folder
   * they picked, just not the one they are in.
   */
  async function isKnownRoot(root: string): Promise<boolean> {
    if (isOpenRoot(root)) return true;
    return (await readRecents()).some((entry) => path.resolve(entry.path) === root);
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
      body: {
        ok: true,
        hasKey: resolved !== null,
        source: stored ? 'project' : resolved ? 'environment' : null,
      },
    };
  }

  /**
   * Open any folder as the working folder. Unlike `openProject` this does NOT
   * require a hearth.json: the app's whole premise is that the agent builds a
   * game in a folder however it wants, so an empty folder is a perfectly good
   * starting point. A folder that also happens to be a Hearth project reports
   * `isHearthProject` so callers can offer more.
   *
   * A standalone function rather than only a ctx method, so `createWorkspace`
   * can run the EXACT same open path (recents registration included) after it
   * makes the folder, instead of a near-copy that drifts.
   *
   * WHAT AUTHORIZES A FOLDER, AND WHERE THAT CHECK LIVES
   *
   * This function takes any string and adds it to `openedRoots`, which is the
   * jail every file route, both static mounts and the /api/ws upgrade resolve
   * against. That is deliberate and it is NOT the hole: opening any folder
   * anywhere is the whole premise of the app, and a rule here about which
   * folders are allowed would be Hearth deciding where someone may build a
   * game. There is no such rule and there must never be one.
   *
   * The authorization is about the CALLER, not the path, and it lives in
   * `route()` (see `denyUnattestedRoot`) because it is a fact about the
   * request's headers, which this function cannot see. Do not move it here and
   * do not "simplify" it away: the reason this function is allowed to be as
   * permissive as it is, is that the only caller who can reach it with a
   * caller-named path has already been proven to be the editor's own document.
   *
   * In-process callers (createWorkspace, and tests) reach this directly and
   * are trusted by construction: no request, no header, no attacker.
   */
  async function openWorkspaceImpl(rawPath: unknown): Promise<JsonResult> {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      return {
        status: 400,
        body: { ok: false, error: 'Missing "path" (absolute folder).' },
      };
    }
    const root = path.resolve(rawPath.trim());
    if (!(await isDirectory(root))) {
      return {
        status: 400,
        body: { ok: false, error: `Not a folder: ${root}` },
      };
    }
    openedRoots.add(root);
    // Any opened folder can end up with a `.hearth/` — a chat can start in a
    // folder that has no hearth.json at all — so this runs here, not only on
    // the Hearth-project path below. See ensureHearthDirIgnored's own comment.
    await ensureHearthDirIgnored(root);
    // The name the project stores for itself, or the folder basename when it
    // has none. A folder is a slug because it is a path; the name is what
    // somebody typed, and the two have not been the same string since
    // `우주 게임` came back as `new-game`. See server/projectIdentity.ts.
    const name = (await readProjectIdentity(root)).name ?? (path.basename(root) || root);
    const isHearthProject = await pathExists(path.join(root, 'hearth.json'));
    await addRecent(root, name);
    return {
      status: 200,
      body: { ok: true, path: root, name, isHearthProject },
    };
  }

  const ctx = {
    repoRoot,
    sessions,
    /**
     * The open-folder jail, reachable from the other transports. ws.ts gates
     * its upgrade on this; see isOpenRoot above for what went wrong while it
     * could not.
     */
    isOpenRoot,
    /** Streamed composer uploads shared with ws.ts, which consumes their tokens. */
    chatAttachments,
    /**
     * The wider "the user has named this folder at some point" test. Used by
     * the route layer to decide whether an unattested caller may name a root,
     * and by the identity route, whose rows are recents. See isKnownRoot.
     */
    isKnownRoot,
    /** Told by whoever started the game listener. See gameOrigin above. */
    setGameOrigin(origin: string | null): void {
      gameOrigin = origin;
    },
    /** Desktop-export progress bus; ws.ts subscribes and fans frames to sockets. */
    exportBus,
    /** Lets the socket transport stop live work before the HTTP route removes its conversation. */
    onBeforeChatDelete(listener: (root: string, chatId: string) => Promise<string | void>): () => void {
      beforeChatDelete.add(listener);
      return () => beforeChatDelete.delete(listener);
    },
    /** Running-sweep frames; probeStream.ts subscribes and fans them to viewers. */
    probeBus,

    openWorkspace: openWorkspaceImpl,

    /**
     * Take a folder back OUT of the jail.
     *
     * `openedRoots` only ever grew. Closing a project in the window was a
     * client-side state change and nothing else, so every folder touched during
     * a server run stayed readable through /api/file, /api/fs, the /api/ws
     * upgrade and both static mounts until the process exited. That is how a
     * game in project A ended up able to read project B's files: B had been
     * opened an hour ago and never let go.
     *
     * "Open" should mean open. This is the only direction that needs no
     * attestation gate: it takes reach away and can hand nothing back, so the
     * worst a caller can do with it is make the user reopen a folder. Both the
     * cached session and its journal-seq bookmark go with it, so reopening
     * later builds a fresh session against whatever is on disk by then.
     *
     * The recents list is deliberately untouched: recents are folders the user
     * NAMED, which is a different fact from folders that are open, and the rail
     * still has to render the row you just closed.
     */
    async closeWorkspace(rawPath: unknown): Promise<JsonResult> {
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "path" (absolute folder).' },
        };
      }
      const root = path.resolve(rawPath.trim());
      const wasOpen = isOpenRoot(root);
      openedRoots.delete(root);
      sessions.delete(root);
      seenSeq.delete(root);
      await chatAttachments.discardProject(root);
      return { status: 200, body: { ok: true, path: root, wasOpen } };
    },

    /**
     * Make the folder a chat is about to fill. Home has no picker — the first
     * message IS the project — so the prompt names a folder under the projects
     * home (`~/Hearth` unless overridden), and from there this behaves exactly
     * like `openWorkspace`: same recents registration, same response shape.
     */
    async createWorkspace(prompt: unknown, name?: unknown): Promise<JsonResult> {
      // A typed name and a first message are not the same kind of text, so
      // they do not get the same slug rule: every word of a name was chosen,
      // while a prompt is mostly scaffolding. See workspaceSlug.ts.
      const typed = typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
      const source = typed ?? (typeof prompt === 'string' ? prompt : '');
      const home = resolveProjectsHome(options.projectsDir);
      try {
        await fsp.mkdir(home, { recursive: true });
        const folder = await uniqueFolderName(home, typed ? slugFromName(typed) : slugFromPrompt(source));
        const target = path.join(home, folder);
        await fsp.mkdir(target, { recursive: true });
        // The folder is a slug and always will be. The NAME is what was typed,
        // and it goes in the project's own file so it travels with the folder
        // and outlives this process. Without it the slug was the name, which
        // is how `우주 게임` became a game called `new-game`.
        if (typed) await writeProjectIdentity(target, { name: typed });
        return await openWorkspaceImpl(target);
      } catch (err) {
        return {
          status: 500,
          body: {
            ok: false,
            error: `Could not create a project folder: ${(err as Error).message}`,
          },
        };
      }
    },

    /**
     * Every conversation across the folders this machine has open recently —
     * the sidebar's Recents list, which is global rather than per-folder
     * because a chat is the thing the user is looking for, not the folder it
     * happens to live in. A folder that has moved, been deleted, or holds an
     * unreadable index is skipped silently: a stale recents entry must not
     * turn the whole list into an error.
     */
    async recentChats(): Promise<JsonResult> {
      const entries = await readRecents();
      const perFolder = await Promise.all(
        entries.map(async (entry): Promise<RecentChatEntry[]> => {
          try {
            if (!(await isDirectory(entry.path))) return [];
            // The project's own name wins over the one cached in recents, and
            // both win over the basename: a row that says `cafe-adventure`
            // when the game is called Café Adventure is naming a folder, and
            // nobody asked which folder their chat was in.
            const stored = (await readProjectIdentity(entry.path)).name;
            return (await listChats(entry.path)).map((chat) => ({
              id: chat.id,
              title: chat.title,
              kind: chat.kind,
              createdAt: chat.createdAt,
              updatedAt: chat.updatedAt,
              project: {
                path: entry.path,
                name: stored ?? (entry.name || path.basename(entry.path)),
              },
            }));
          } catch {
            return [];
          }
        }),
      );
      const chats = perFolder
        .flat()
        // Newest activity first; ties break on id so the order is stable
        // across reads (two chats created in the same millisecond otherwise
        // swap places between refreshes).
        .sort((a, b) =>
          a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt),
        )
        .slice(0, RECENT_CHATS_LIMIT);
      return { status: 200, body: { ok: true, chats } };
    },

    /** Recently opened folders, each flagged with whether it still exists. */
    async recentWorkspaces(): Promise<JsonResult> {
      const entries = await readRecents();
      const projects = await Promise.all(
        entries.map(async (e) => {
          // Carried in the list rather than fetched per row: the rail paints
          // every project's mark on first render, and six round trips to draw
          // six glyphs would be six chances to flash the wrong colour.
          const identity = await readProjectIdentity(e.path);
          return {
            path: e.path,
            // The stored name, then the one recents cached at open time, then
            // the basename. A project made before names were stored has none
            // and keeps reading as its folder, which is why there is nothing
            // to migrate.
            name: identity.name ?? e.name,
            exists: await isDirectory(e.path),
            identity,
          };
        }),
      );
      return { status: 200, body: { ok: true, projects } };
    },

    /**
     * What this machine has made with Hearth — counted, never metered. Like
     * skills, this is about the person and not about one open folder, so it
     * takes no `project`; it reads the same recents list every other global
     * route reads. See server/usage.ts for what is and is not countable.
     */
    async usage(): Promise<JsonResult> {
      return {
        status: 200,
        body: { ok: true, usage: await collectUsage({ recentsFile }) },
      };
    },

    /**
     * Give a project a mark and a colour, or clear one back to derived. The
     * rail is the only caller; it writes what the picker chose and re-reads
     * the list.
     */
    /**
     * Read one of the project's own standing documents — today only AGENTS.md,
     * the instructions every agent reads on its own.
     *
     * Deliberately an allowlist rather than an arbitrary path: this is a
     * read/write pair reachable from the renderer, and "any file in the
     * project" is a much larger promise than the one screen using it needs.
     * A document that does not exist yet reads as empty rather than 404 —
     * "you have not written instructions" is not an error.
     *
     * The allowlist bounds the FILENAME; `isOpenRoot` bounds the FOLDER, and
     * the pair is what makes this safe. With only the allowlist, `project` was
     * any directory on the disk, so one request wrote `~/.hearth/AGENTS.md` or
     * `~/.claude/AGENTS.md`, both of which go into the system prompt of every
     * agent the user runs (see personalization.ts). That is persistent prompt
     * injection into someone's own Claude Code, from a route whose entire job
     * is one text box in one pane of one open project.
     */
    async projectDoc(project: unknown, name: unknown): Promise<JsonResult> {
      const doc = PROJECT_DOCS.find((entry) => entry === name);
      if (typeof project !== 'string' || project.trim() === '' || !doc) {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project" or unknown document.' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      if (!(await isDirectory(root))) {
        return {
          status: 404,
          body: { ok: false, error: 'That project is not on disk any more.' },
        };
      }
      try {
        return {
          status: 200,
          body: {
            ok: true,
            text: await fsp.readFile(path.join(root, doc), 'utf8'),
          },
        };
      } catch {
        return { status: 200, body: { ok: true, text: '' } };
      }
    },

    /**
     * Write one back. An empty body removes the file rather than leaving a
     * blank one, which is also why the folder gate matters as much on the way
     * in as on the way out: unchecked, `text: ""` deleted any AGENTS.md on the
     * disk as readily as a full one overwrote it.
     */
    async writeProjectDoc(project: unknown, name: unknown, text: unknown): Promise<JsonResult> {
      const doc = PROJECT_DOCS.find((entry) => entry === name);
      if (typeof project !== 'string' || project.trim() === '' || !doc || typeof text !== 'string') {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'Missing "project", "text", or unknown document.',
          },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      if (!(await isDirectory(root))) {
        return {
          status: 404,
          body: { ok: false, error: 'That project is not on disk any more.' },
        };
      }
      const file = path.join(root, doc);
      try {
        if (text.trim() === '') await fsp.rm(file, { force: true });
        else await fsp.writeFile(file, text.endsWith('\n') ? text : text + '\n');
        return { status: 200, body: { ok: true } };
      } catch (err) {
        return {
          status: 500,
          body: {
            ok: false,
            error: `Could not write ${doc}: ${(err as Error).message}`,
          },
        };
      }
    },

    async setProjectIdentity(project: unknown, icon: unknown, color: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      // isKnownRoot, not isOpenRoot: the caller is a row in the recents rail,
      // and only one of those rows is ever the open folder. See isKnownRoot.
      if (!(await isKnownRoot(root))) {
        return {
          status: 403,
          body: { ok: false, error: 'Not a folder you have opened.' },
        };
      }
      if (!(await isDirectory(root))) {
        return {
          status: 404,
          body: { ok: false, error: 'That project is not on disk any more.' },
        };
      }
      const identity = await writeProjectIdentity(root, {
        ...(icon === undefined ? {} : { icon: typeof icon === 'string' ? icon : '' }),
        ...(color === undefined ? {} : { color: typeof color === 'string' ? color : '' }),
      });
      return { status: 200, body: { ok: true, identity } };
    },

    /**
     * Whether this folder currently holds a playable web game, where its entry
     * point is, and how fresh it is. The game pane polls this: a changed
     * `mtime` is its cue to reload the iframe.
     */
    async gameStatus(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      const found = await resolveGameEntry(root);
      if (!found)
        return {
          status: 200,
          body: { ok: true, present: false, entry: null, mtime: 0 },
        };
      const mtime = await newestMtimeMs(path.dirname(found.abs));
      return {
        status: 200,
        body: { ok: true, present: true, entry: found.entry, mtime },
      };
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
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      const [game, record] = await Promise.all([resolveGameEntry(root), readCapabilities(root)]);
      return {
        status: 200,
        body: {
          ok: true,
          senses: sensesFromCapabilities(record, game !== null),
          shimDetected: record?.shimDetected === true,
        },
      };
    },

    // --- The private tester ---------------------------------------------------

    /** The tester's channel; ws.ts subscribes and fans frames to the folder's sockets. */
    testerBus,

    /** The in-flight session for `root`, so callers (and tests) can await it. */
    testerJob(root: string): Promise<void> | undefined {
      return testerJobs.get(path.resolve(root))?.done;
    },

    /**
     * Play the game.
     *
     * The session runs off the request: it takes minutes and has its own
     * channel, so the response only says it started and which session number it
     * claimed. One at a time per folder, and a second ask while one is playing
     * is a 409 rather than a queue — two testers in one folder would both try to
     * claim the same session id and only one of them could have it.
     *
     * Never scheduled and never automatic. It plays when asked, because every
     * turn costs the person whose game it is.
     */
    async startTesterSession(project: unknown, maxSteps?: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      if (testerJobs.has(root)) {
        return {
          status: 409,
          body: {
            ok: false,
            error: 'The tester is already playing this game.',
          },
        };
      }
      const game = await resolveGameEntry(root);
      if (!game) {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'No game to play yet. Nothing in this folder runs.',
          },
        };
      }
      const asked = typeof maxSteps === 'number' ? Math.floor(maxSteps) : Number.NaN;
      const budget = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_MAX_STEPS) : DEFAULT_MAX_STEPS;
      const session = await nextTesterSessionId(root);

      let driver: ChatDriver;
      try {
        // Deliberately bound WITHOUT the project's permission mode, which is
        // about the conversation the user is watching. Nobody is watching this
        // one: under `ask` every step would raise an approval into an empty
        // room and the session would wedge, and under `skip` an unattended
        // agent would be running with no sandbox at all. It gets the default,
        // which is what this has always run as.
        driver = await (options.testerDeps?.createDriver ?? ((r: string) => createChatDriver(r)))(root);
      } catch (err) {
        return {
          status: 500,
          body: {
            ok: false,
            error: `Could not reach your agent: ${(err as Error).message}`,
          },
        };
      }
      // createChatDriver never throws on "no agent configured" — it falls
      // through to `new StubDriver()`, which answers every turn with the same
      // canned "connect an agent" guidance (see chat.ts's STUB_REPLY). That is
      // the right call for the chat column, where a person reads the reply
      // and knows exactly what it is. Nobody reads the tester's turns as they
      // happen: it would burn its whole step budget arguing with itself
      // against canned text and then write a note that reads like a real
      // playtest, which is a worse lie than refusing outright.
      //
      // An `instanceof` check on the real class, not `driver.kind === 'stub'`:
      // several test suites' fake drivers (testerRoutes.test.ts's
      // ScriptedDriver, testerSession.test.ts's FakeDriver, and others) also
      // set `kind = 'stub'` as a cheap way to satisfy the ChatDriver interface
      // — that is a label for the UI, not a promise that the backend is
      // absent, and treating it as one would refuse every one of those
      // legitimately-connected test doubles. `StubDriver` itself is a
      // concrete class those fakes never extend, so this catches only the
      // real fallback. Same status/shape as the catch above: from the
      // caller's side "no agent replied" and "no agent is reachable" are the
      // same failure.
      if (driver instanceof StubDriver) {
        return {
          status: 500,
          body: {
            ok: false,
            error: 'Could not reach your agent: no agent is connected.',
          },
        };
      }

      const controller = new AbortController();
      const done = (async (): Promise<void> => {
        emitTester(root, { type: 'tester-started', session, maxSteps: budget });
        try {
          await driver.start(`tester-${session}`, root);
          const note = await runTesterSession({
            root,
            dir: path.dirname(game.abs),
            driver,
            maxSteps: budget,
            signal: controller.signal,
            openGame: options.testerDeps?.openGame,
            onFrame: (data) => {
              const message: ProbeBusMessage = {
                root,
                frame: { type: 'probe-frame', data },
              };
              probeBus.emit('frame', message);
            },
            onThought: (text, turn) => emitTester(root, { type: 'tester-thought', text, turn }),
            onPhase: (phase: TesterPhase) => emitTester(root, { type: 'tester-phase', phase }),
          });
          emitTester(root, { type: 'tester-done', note });
        } catch (err) {
          emitTester(root, {
            type: 'tester-error',
            message: (err as Error).message,
          });
        } finally {
          // Said explicitly rather than left to be inferred from frames
          // stopping, so the pane hands the stage back to the person's own game
          // at the moment it stops being a lie to show the tester's.
          const message: ProbeBusMessage = {
            root,
            frame: { type: 'probe-end' },
          };
          probeBus.emit('frame', message);
          try {
            driver.stop();
          } catch {
            /* a driver that is already gone is the outcome we wanted */
          }
          testerJobs.delete(root);
        }
      })();
      testerJobs.set(root, { root, session, controller, done });
      return {
        status: 200,
        body: { ok: true, started: true, session, maxSteps: budget },
      };
    },

    /**
     * Stop the session that is playing. The session still writes its note: the
     * person asked it to stop playing, not to forget what it saw.
     */
    async stopTesterSession(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      const job = testerJobs.get(root);
      if (!job) return { status: 200, body: { ok: true, stopped: false } };
      job.controller.abort();
      return { status: 200, body: { ok: true, stopped: true } };
    },

    /**
     * Every session this folder's tester has played, oldest first, plus the
     * memory it keeps. Read from disk on every call: these are files a person
     * can edit by hand, and the folder is the only thing every reader shares.
     */
    async testerHistory(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      const [sessions, memory] = await Promise.all([listSessions(root), readMemory(root)]);
      return {
        status: 200,
        body: {
          ok: true,
          sessions,
          memory,
          running: testerJobs.has(root),
          maxSteps: DEFAULT_MAX_STEPS,
        },
      };
    },

    /**
     * Every recent playtest across every game, newest first.
     *
     * A playtest belongs to a game, but the HISTORY of playtests belongs to
     * the person, the way skills and usage do. So this takes no `project` and
     * reads the same recents list every other global route reads. That is also
     * what makes it safe without `isOpenRoot`: the caller supplies no path at
     * all, so there is nothing here to point somewhere it should not go.
     *
     * The caps are the point of the caps. This walks
     * `.hearth/tester/sessions/` for every recent project on every open of the
     * screen, and each session is a directory read plus a JSON parse. Bounded
     * so a machine with forty projects and a thousand sessions still opens the
     * screen in one frame, and `dropped` says out loud when the bound bit,
     * rather than letting a truncated list read as a complete one.
     *
     * A project whose folder has gone is skipped, not fatal: a deleted game
     * must not take the whole history down with it.
     */
    async testerHistoryAll(): Promise<JsonResult> {
      // `readRecents` swallows its own failure and answers an empty list, so a
      // corrupt or unreadable recents file used to come back as a cheerful 200
      // with no runs, and the screen said "your tester has not played yet"
      // over a disk holding fifteen games of history. `readable` is the whole
      // reason `readRecentsState` exists; a read that did not land is a 500,
      // and the screen keeps whatever it already had.
      const state = await readRecentsState();
      if (!state.readable) {
        return {
          status: 500,
          body: { ok: false, error: 'Could not read the list of projects.' },
        };
      }
      const looked = state.entries.slice(0, MAX_HISTORY_PROJECTS);
      // Counted, because the screen may not silently present a slice of your
      // history as the whole of it. Two ways a game goes missing: the cap, and
      // a folder that is no longer there.
      let skippedProjects = Math.max(0, state.entries.length - looked.length);
      const perProject = await Promise.all(
        looked.map(async (entry) => {
          // Inside the try, not outside it. A malformed entry (a null, or a
          // `path` that is not a string) made `isDirectory` throw straight out
          // of the Promise.all, so ONE bad line in the recents file answered
          // 500 and left the screen reading "Looking for past sessions" with
          // nothing that would ever end it.
          try {
            if (!(await isDirectory(entry.path))) return { runs: [], gone: true };
            const sessions = await listSessions(entry.path);
            const identity = await readProjectIdentity(entry.path);
            return {
              runs: sessions.map((note) => ({
                note,
                // Same rule as the rail: the game's own name, then the one
                // recents cached. A history of playtests that names folders
                // is a history of folders.
                project: {
                  path: entry.path,
                  name: identity.name ?? entry.name,
                  identity,
                },
              })),
              gone: false,
            };
          } catch {
            // One unreadable project folder is one missing game, not a broken
            // screen for the other nine.
            return { runs: [], gone: true };
          }
        }),
      );
      skippedProjects += perProject.filter((project) => project.gone).length;
      const all = perProject
        .flatMap((project) => project.runs)
        .sort((a, b) => {
          const at = Date.parse(a.note.finishedAt ?? '');
          const bt = Date.parse(b.note.finishedAt ?? '');
          // A note with no readable time sorts last rather than randomly: it is
          // the one case where "newest first" has no answer.
          return (Number.isFinite(bt) ? bt : -Infinity) - (Number.isFinite(at) ? at : -Infinity);
        });
      return {
        status: 200,
        body: {
          ok: true,
          runs: all.slice(0, MAX_HISTORY_RUNS),
          dropped: Math.max(0, all.length - MAX_HISTORY_RUNS),
          skippedProjects,
        },
      };
    },

    /**
     * The message that starts work on part of a session's plan of action.
     *
     * Built here rather than in the window because the note is a file on disk
     * and the ids are the only thing the window is entitled to be believed
     * about. Anything not ticked never leaves this function: an unapproved
     * proposal that reaches an agent is one it may act on.
     */
    async approveTesterProposals(project: unknown, session: unknown, proposals: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      if (typeof session !== 'number' || !Number.isFinite(session)) {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "session".' },
        };
      }
      const picked = Array.isArray(proposals) ? proposals.filter((id): id is string => typeof id === 'string') : [];
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      const note = (await listSessions(root)).find((entry) => entry.session === session);
      if (!note)
        return {
          status: 404,
          body: { ok: false, error: `Session ${session} has no note to read.` },
        };
      const dir = path.relative(root, framesDir(root, session)).split(path.sep).join('/');
      const seed = approvalSeed(note, picked, dir);
      if (!seed) {
        return {
          status: 400,
          body: { ok: false, error: 'Nothing was picked from that session.' },
        };
      }
      return {
        status: 200,
        body: {
          ok: true,
          text: seed.text,
          // Named as well as described, so a caller that wants to show or open
          // a picture does not have to know how a session lays out its folder.
          frames: seed.frames.map((frame) => ({
            frame,
            relPath: `${dir}/${frameFile(frame)}`,
          })),
        },
      };
    },

    // --- Conversations ------------------------------------------------------

    /** Every conversation this folder holds, newest activity first. */
    async listProjectChats(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      return { status: 200, body: { ok: true, chats: await listChats(root) } };
    },

    async createProjectChat(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      const chat = await createChat(root);
      return {
        status: 200,
        body: { ok: true, chat, chats: await listChats(root) },
      };
    },

    /**
     * Renaming and deleting are gated on a KNOWN folder, not an open one.
     *
     * The rail lists every conversation on the machine and the row carries the
     * folder it belongs to, so tidying the list meant opening each folder in
     * turn to be allowed to touch one row of it. Every path on that list got
     * there because the user opened it; it is still a folder they picked, just
     * not the one they are in. Same reasoning, and the same gate, as the
     * appearance route below.
     */
    async renameProjectChat(project: unknown, chatId: unknown, title: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || typeof chatId !== 'string' || typeof title !== 'string') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project", "chatId" or "title".' },
        };
      }
      const root = path.resolve(project);
      if (!(await isKnownRoot(root)))
        return {
          status: 403,
          body: { ok: false, error: 'That folder is not one of yours.' },
        };
      const chat = await renameChat(root, chatId, title);
      if (!chat)
        return {
          status: 404,
          body: { ok: false, error: 'No such conversation.' },
        };
      return {
        status: 200,
        body: { ok: true, chat, chats: await listChats(root) },
      };
    },

    async deleteProjectChat(project: unknown, chatId: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || typeof chatId !== 'string') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project" or "chatId".' },
        };
      }
      const root = path.resolve(project);
      if (!(await isKnownRoot(root)))
        return {
          status: 403,
          body: { ok: false, error: 'That folder is not one of yours.' },
        };
      const id = safeChatId(chatId);
      const chat = id ? await getChat(root, id) : null;
      if (!chat) {
        return {
          status: 404,
          body: { ok: false, error: 'No such conversation.' },
        };
      }
      for (const listener of beforeChatDelete) {
        const blocked = await listener(root, chat.id);
        if (blocked) return { status: 409, body: { ok: false, error: blocked } };
      }
      const removed = await deleteChat(root, chat.id);
      if (!removed)
        return {
          status: 404,
          body: { ok: false, error: 'No such conversation.' },
        };
      if (chat.kind === 'devteam') await deleteDevTeamArtifacts(root, chat.id);
      return { status: 200, body: { ok: true, chats: await listChats(root) } };
    },

    // --- Context files ------------------------------------------------------
    //
    // Background reading the user hands the project: everything lives in
    // `.hearth/context/`, so it travels with the folder and can be committed.
    // All four routes answer with the same list the pane renders, which is why
    // the mutating ones re-read rather than trusting the caller to merge.
    //
    // All four are open-folder gated, like every other project route. They
    // were the outliers that checked only `isDirectory`, which made the pair
    // of them a write-and-read primitive over any directory on the disk: drop
    // a file into `<anywhere>/.hearth/context/`, then read it back out. The
    // containment INSIDE the folder (projectContext.ts) was never the problem;
    // the folder was whatever the caller typed.

    /** What the project has been told about itself, newest first. */
    async listContext(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      if (!(await isDirectory(root))) {
        return {
          status: 404,
          body: { ok: false, error: 'That project is not on disk any more.' },
        };
      }
      return {
        status: 200,
        body: {
          ok: true,
          dir: contextDir(root),
          files: await listContextFiles(root),
        },
      };
    },

    /**
     * Take dropped files. The response is the whole list rather than just what
     * landed, so a drop that lost a file to a size cap shows the truth
     * immediately instead of on the next refresh.
     */
    async addContextFiles(project: unknown, files: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      if (!(await isDirectory(root))) {
        return {
          status: 404,
          body: { ok: false, error: 'That project is not on disk any more.' },
        };
      }
      const saved = await saveContextFiles(root, files);
      return {
        status: 200,
        body: {
          ok: true,
          saved,
          dir: contextDir(root),
          files: await listContextFiles(root),
        },
      };
    },

    async removeContextFile(project: unknown, name: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      if (!(await isDirectory(root))) {
        return {
          status: 404,
          body: { ok: false, error: 'That project is not on disk any more.' },
        };
      }
      const removed = await deleteContextFile(root, name);
      if (!removed)
        return {
          status: 404,
          body: { ok: false, error: 'No such context file.' },
        };
      return {
        status: 200,
        body: {
          ok: true,
          dir: contextDir(root),
          files: await listContextFiles(root),
        },
      };
    },

    /** One file's text for the preview sheet; binary and oversized read as 404. */
    async readContextText(project: unknown, name: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      if (!(await isDirectory(root))) {
        return {
          status: 404,
          body: { ok: false, error: 'That project is not on disk any more.' },
        };
      }
      const text = await readContextFile(root, name);
      if (text === null)
        return {
          status: 404,
          body: { ok: false, error: 'Nothing to preview.' },
        };
      return { status: 200, body: { ok: true, text } };
    },

    /**
     * Flat, read-only listing of the folder's files for the code peek. Skips
     * the noise directories, caps the result, and never leaves the root.
     */
    async listFiles(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
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
     *
     * Gated exactly like the POST below, which it was not. It reads
     * `<root>/.hearth/app.json` for any root it is handed, and answers with a
     * boolean: "does this directory have a Hearth app.json" is a probe of the
     * user's disk, one directory per request, from a route that only ever
     * needs to describe the folder that is open.
     */
    async getAppSettings(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      return settingsSummary(root);
    },

    /**
     * Save agent settings. `apiKey` stays the Anthropic key (the shape every
     * existing caller sends); `extra` carries the newer provider fields, each
     * optional so a client that only knows about the key keeps working.
     * Saving anything here can change which agent answers, so the socket is
     * told — that is what keeps Settings live during a sign-in.
     */
    async setAppSettings(project: unknown, apiKey: unknown, extra?: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const patch: AppSettings = {};
      if (typeof apiKey === 'string') patch.apiKey = apiKey;
      const more = extra && typeof extra === 'object' ? (extra as Record<string, unknown>) : {};
      if (typeof more.openaiApiKey === 'string') patch.openaiApiKey = more.openaiApiKey;
      if (typeof more.codexPath === 'string') patch.codexPath = more.codexPath;
      if (typeof more.claudePath === 'string') patch.claudePath = more.claudePath;
      if (more.provider === 'anthropic' || more.provider === 'openai') patch.provider = more.provider;
      if (Object.keys(patch).length === 0) {
        return { status: 400, body: { ok: false, error: 'Nothing to save.' } };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      await writeAppSettings(root, patch);
      void announceProviders(root);
      return settingsSummary(root);
    },

    /** Which agents this machine can talk to right now. */
    async chatProviders(project: unknown): Promise<JsonResult> {
      // No folder named means the HOME screen is asking. Who the person is
      // signed in as is a fact about the machine, not about any folder — the
      // CLI logins live in the user's home — so the read is answered against
      // the home directory rather than refused. A refusal here is what made
      // the account row sit on "haven't looked yet" forever before a first
      // project was opened. Per-folder facts (a project API key, the folder's
      // chosen provider) simply come back empty, which is the truth for a
      // screen with no folder open.
      if (project === null || project === undefined || (typeof project === 'string' && project.trim() === '')) {
        return {
          status: 200,
          body: { ok: true, ...(await readChatProviders(os.homedir())) },
        };
      }
      if (typeof project !== 'string') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      return {
        status: 200,
        body: { ok: true, ...(await readChatProviders(root)) },
      };
    },

    /**
     * Start a ChatGPT sign-in. The reply is only the URL to open — the flow
     * itself runs in the user's browser against codex's own callback, and its
     * completion reaches the app as a `chat-providers` socket frame. No token
     * ever passes through here.
     */
    async openAiLogin(project: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || project.trim() === '') {
        return {
          status: 400,
          body: { ok: false, error: 'Missing "project".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      const result = await beginOpenAiLogin(root);
      return { status: result.ok ? 200 : 400, body: result };
    },

    /**
     * Serve a file from one of the static mounts. `key` is the base64url
     * project root; `rel` is resolved inside it (or inside its evidence dir),
     * and anything escaping, or hidden, is refused.
     *
     * Both checks run TWICE: once on the spelling, and once on where the
     * filesystem actually goes. `path.resolve` and `path.relative` only read the
     * text of a path, and `readFile` follows symlinks, so a link inside the
     * project folder was a complete bypass of both rules:
     *
     *   ln -s .hearth assets         -> assets/app.json served the saved API keys
     *   ln -s .hearth/app.json a.png -> the same, through one file
     *   ln -s ../secrets.txt b.png   -> anything at all, from anywhere at all
     *
     * That folder is where an agent writes game code, so creating the link is
     * the most ordinary thing in the threat model rather than an exotic one.
     * `realpath` is the only thing that answers "what will actually be opened",
     * and it has to be asked BEFORE the escape check and BEFORE the hidden
     * check, not after. It resolves the base too: a mount root under a symlinked
     * temp dir (which is every macOS temp dir) would otherwise fail its own
     * containment test.
     */
    async serveMounted(mount: 'game' | 'evidence', key: string, rel: string): Promise<FileResult> {
      const root = decodeRootKey(key);
      if (!root)
        return {
          status: 400,
          body: { ok: false, error: 'Malformed mount key.' },
        };
      const resolvedRoot = path.resolve(root);
      if (!isOpenRoot(resolvedRoot))
        return {
          status: 403,
          body: { ok: false, error: 'Folder is not open.' },
        };
      const base = mount === 'evidence' ? path.join(resolvedRoot, EVIDENCE_DIR) : resolvedRoot;
      const abs = path.resolve(base, rel === '' ? '.' : rel);
      const escapes = (from: string, to: string): boolean => to !== from && !to.startsWith(from + path.sep);
      // The lexical pass first, because it needs no disk and refuses the
      // spelled-out `../` walk without ever touching the path it names.
      if (escapes(base, abs)) {
        return {
          status: 403,
          body: { ok: false, error: 'Path escapes the mount.' },
        };
      }
      if (hasHiddenSegment(path.relative(base, abs))) {
        return {
          status: 403,
          body: { ok: false, error: 'Hidden paths are not served.' },
        };
      }
      let realBase: string;
      let realAbs: string;
      try {
        realBase = await fsp.realpath(base);
        realAbs = await fsp.realpath(abs);
      } catch {
        // Nothing there, or a link pointing at nothing. Answered like any other
        // missing file rather than thrown: a dangling link in a project folder
        // is untidy, not exceptional.
        return { status: 404, body: { ok: false, error: `Not found: ${rel}` } };
      }
      // The same two rules again, now against where the bytes really live. The
      // evidence mount's base is itself inside `.hearth`, which is exactly why
      // the hidden check is rebased onto it rather than onto the project root.
      if (escapes(realBase, realAbs)) {
        return {
          status: 403,
          body: { ok: false, error: 'Path escapes the mount.' },
        };
      }
      if (hasHiddenSegment(path.relative(realBase, realAbs))) {
        return {
          status: 403,
          body: { ok: false, error: 'Hidden paths are not served.' },
        };
      }
      try {
        // The resolved path from here on, so what was checked is what is read.
        const stat = await fsp.stat(realAbs);
        if (stat.isDirectory()) return { status: 404, body: { ok: false, error: 'Not a file.' } };
        // Named by the URL, not by the link target: a `.png` that resolves to a
        // file with another extension is still what the game asked for.
        return {
          status: 200,
          contentType: contentTypeFor(abs),
          data: new Uint8Array(await fsp.readFile(realAbs)),
        };
      } catch {
        return { status: 404, body: { ok: false, error: `Not found: ${rel}` } };
      }
    },

    async openProject(rawPath: unknown): Promise<JsonResult> {
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'Missing "path" (absolute project folder).',
          },
        };
      }
      try {
        const root = path.resolve(rawPath.trim());
        const session = await getSession(root);
        const result = await session.execute('inspectProject');
        if (!result.success) {
          return {
            status: 500,
            body: {
              ok: false,
              error: result.errors[0]?.message ?? 'inspectProject failed',
            },
          };
        }
        const info = result.data as { name?: string };
        openedRoots.add(root);
        await ensureHearthDirIgnored(root);
        await addRecent(root, info?.name ?? path.basename(root));
        await provisionAgentMcp(root);
        return {
          status: 200,
          body: { ok: true, path: root, info: result.data },
        };
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
        return {
          status: 400,
          body: { ok: false, error: 'Both "dir" and "name" are required.' },
        };
      }
      if (template !== undefined && template !== null && template !== '') {
        if (typeof template !== 'string' || !listTemplates().some((t) => t.name === template)) {
          const valid = listTemplates()
            .map((t) => t.name)
            .join(', ');
          return {
            status: 400,
            body: {
              ok: false,
              error: `Unknown template "${String(template)}". Available templates: ${valid}.`,
            },
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
        await ensureHearthDirIgnored(target);
        await addRecent(target, info?.name ?? name.trim());
        await provisionAgentMcp(target);
        return {
          status: 200,
          body: { ok: true, path: target, info: result.data },
        };
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
        for (const entry of await fsp.readdir(examplesDir, {
          withFileTypes: true,
        })) {
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
        body: {
          ok: true,
          capability: describeSigningCapability(),
          platforms: DESKTOP_PLATFORMS,
        },
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
        return {
          status: 400,
          body: {
            ok: false,
            error: 'Missing "project" (absolute project folder).',
          },
        };
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
        const result = await session.execute('importAsset', {
          sourcePath: stagedAbs,
        });
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
          preSkipped.push({
            path: displayName,
            code: 'INVALID_INPUT',
            message: 'Each file requires "filename" and "dataBase64".',
          });
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
          preSkipped.push({
            path: displayName,
            code: 'INVALID_INPUT',
            message: `"${displayName}": dataBase64 is not valid base64.`,
          });
          continue;
        }
        if (bytes.length === 0) {
          preSkipped.push({
            path: displayName,
            code: 'INVALID_INPUT',
            message: `"${displayName}" decoded to zero bytes.`,
          });
          continue;
        }
        if (bytes.length > MAX_IMPORT_BYTES) {
          const mb = (bytes.length / (1024 * 1024)).toFixed(1);
          preSkipped.push({
            path: displayName,
            code: 'INVALID_INPUT',
            message: `"${displayName}" is ${mb} MB; imports are limited to 25 MB.`,
          });
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
          preSkipped.push({
            path: displayName,
            code: 'INVALID_INPUT',
            message: 'Import path escapes the project root.',
          });
          continue;
        }
        try {
          await fsp.mkdir(path.dirname(stagedAbs), { recursive: true });
          await fsp.writeFile(stagedAbs, bytes);
        } catch (err) {
          preSkipped.push({
            path: displayName,
            code: 'INTERNAL',
            message: (err as Error).message,
          });
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
          imported: {
            path: string;
            assetId: string;
            name: string;
            type: string;
          }[];
          skipped: { path: string; code: string; message: string }[];
        }>;
        await syncSeenSeq(root);
        if (result.data) {
          result.data.imported = result.data.imported.map((i) => ({
            ...i,
            path: originalNameByStaged.get(i.path) ?? i.path,
          }));
          result.data.skipped = [
            ...result.data.skipped.map((s) => ({
              ...s,
              path: originalNameByStaged.get(s.path) ?? s.path,
            })),
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
          throw Object.assign(new Error('Missing "project" query parameter.'), {
            status: 400,
          });
        }
        const session = await getSession(project);
        return {
          status: 200,
          body: { ok: true, commands: session.listCommands() },
        };
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        return { status, body: { ok: false, error: (err as Error).message } };
      }
    },

    /**
     * Serve a raw project file. Refuses anything outside the project root, and
     * anything in a folder that is not open.
     *
     * WHY THE `hearth.json` FALLBACK IS GONE
     *
     * This route and `fsOperation` below used to accept `isOpenRoot(root) ||
     * exists(root + '/hearth.json')`, which made EVERY folder on the disk that
     * happens to contain a hearth.json readable, open or not. A manifest is not
     * an authorization: it is a file, and the untrusted side of this app (the
     * agent, and anything the agent's game can drive) writes files. `createProject`
     * will happily write one wherever the caller points it. Every sibling route
     * here already says isOpenRoot; these two were the odd ones out, and being
     * the two broadest read surfaces in the server made that expensive.
     *
     * Nothing legitimate is lost: opening a folder, creating a project, and
     * reopening a recent one all put the root in the jail before the client
     * reads a byte out of it.
     */
    async readProjectFile(project: unknown, relPath: unknown): Promise<FileResult> {
      if (typeof project !== 'string' || typeof relPath !== 'string' || relPath === '') {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'Requires "project" and "path" query params.',
          },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) {
        return {
          status: 403,
          body: { ok: false, error: `Folder is not open: ${root}` },
        };
      }
      const abs = resolveInside(root, relPath);
      if (!abs) {
        return {
          status: 403,
          body: { ok: false, error: 'Path escapes the project root.' },
        };
      }
      try {
        const stat = await fsp.stat(abs);
        if (stat.isDirectory()) {
          return {
            status: 400,
            body: { ok: false, error: 'Path is a directory.' },
          };
        }
        const data = new Uint8Array(await fsp.readFile(abs));
        return { status: 200, contentType: contentTypeFor(abs), data };
      } catch {
        return {
          status: 404,
          body: { ok: false, error: `File not found: ${relPath}` },
        };
      }
    },

    /**
     * Minimal FS ops for the browser-side ProjectStore (read-only). Same jail
     * as readProjectFile above, and the same reason the manifest fallback is
     * gone: `readdir` on any folder with a hearth.json was a listing of
     * somebody's disk for the asking.
     */
    async fsOperation(project: unknown, op: unknown, relPath: unknown): Promise<JsonResult> {
      if (typeof project !== 'string' || typeof op !== 'string' || typeof relPath !== 'string') {
        return {
          status: 400,
          body: { ok: false, error: 'Requires "project", "op", and "path".' },
        };
      }
      const root = path.resolve(project);
      if (!isOpenRoot(root)) {
        return {
          status: 403,
          body: { ok: false, error: `Folder is not open: ${root}` },
        };
      }
      const abs = resolveInside(root, relPath === '' ? '.' : relPath);
      if (!abs) {
        return {
          status: 403,
          body: { ok: false, error: 'Path escapes the project root.' },
        };
      }
      try {
        switch (op) {
          case 'read':
            return {
              status: 200,
              body: { ok: true, content: await fsp.readFile(abs, 'utf8') },
            };
          case 'exists':
            return {
              status: 200,
              body: { ok: true, exists: await pathExists(abs) },
            };
          case 'readdir':
            return {
              status: 200,
              body: { ok: true, entries: await fsp.readdir(abs) },
            };
          case 'stat': {
            const s = await fsp.stat(abs);
            return {
              status: 200,
              body: {
                ok: true,
                stat: {
                  isDirectory: s.isDirectory(),
                  size: s.size,
                  mtimeMs: s.mtimeMs,
                },
              },
            };
          }
          default:
            return {
              status: 400,
              body: { ok: false, error: `Unknown fs op "${op}".` },
            };
        }
      } catch (err) {
        return {
          status: 404,
          body: { ok: false, error: (err as Error).message },
        };
      }
    },

    /**
     * Facts about this server that the UI needs before any folder is open.
     *
     * It used to also answer with `os.homedir()`, the repo root, and the
     * absolute paths of the bundled CLI/MCP/probe binaries, to anyone who
     * asked. Nothing in the client ever read them (the UI uses
     * `hearthVersion`, and now `gameOrigin`), and handing an unauthenticated
     * caller a map of the user's disk is what turned the /api/ws hole from a
     * vulnerability into a point-and-shoot one: the attack did not have to
     * guess a username, it just asked. So they are gone rather than gated.
     *
     * The route itself stays ungated, because it has to be: it is the first
     * call the app makes, before any folder exists to authorize against. What
     * protects it now is the same-origin rule in originGuard.ts, which no
     * other page on the machine (the game included) can satisfy. What is left
     * in the body is a version string, a capability bit, and a loopback port
     * that is useless without an open folder to name.
     */
    async meta(): Promise<JsonResult> {
      const runtimeAvailable =
        (await pathExists(path.join(repoRoot, 'packages', 'runtime', 'src', 'pixi', 'index.ts'))) ||
        (await pathExists(path.join(repoRoot, 'packages', 'runtime', 'dist', 'pixi', 'index.js')));

      return {
        status: 200,
        body: {
          ok: true,
          hearthVersion: HEARTH_VERSION,
          runtimeAvailable,
          gameOrigin,
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

async function readJsonBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<Record<string, unknown>> {
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
 * The gate on the three routes that put a CALLER-NAMED folder into
 * `openedRoots`: workspace/open, project/open, project/create.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT AN ALLOWLIST OF FOLDERS
 *
 * `openedRoots` is the jail every file route, both static mounts and the
 * /api/ws upgrade resolve against. These three routes are the only way into
 * it, and they took any string that stat'd as a directory. So two requests
 * were a whole-disk read primitive:
 *
 *     POST /api/workspace/open  {"path":"/Users/someone"}
 *     GET  /api/file?project=/Users/someone&path=.ssh/id_rsa
 *
 * and the first of them also rewrote ~/.hearth/recent-projects.json, so it
 * outlived the process.
 *
 * The fix cannot be a rule about WHICH folders may be opened. Opening any
 * folder anywhere is the app's premise, and a denylist of "sensitive"
 * directories would be Hearth deciding where somebody may build a game while
 * doing nothing about the folder it failed to think of. The question is who is
 * asking.
 *
 * WHAT COUNTS AS THE USER PICKING A FOLDER
 *
 * The legitimate callers are the editor's own document, and only ever with a
 * path a person just chose: the native folder dialog in the desktop app
 * (electron/main.ts's `hearth:pick-directory`), the typed prompt that stands
 * in for it in a dev browser tab, or a row in the recents rail. There is no
 * other one. `createWorkspace` makes its own folder and opens it in process,
 * and nothing in the CLI or the MCP server speaks to this HTTP API at all.
 *
 * So the attestation is: THE REQUEST CARRIES AN ORIGIN HEADER. That is a
 * narrower claim than it sounds, because `route()` has already run
 * `isRequestAllowed`, which rejects every Origin that is not this exact server
 * (loopback name AND matching port). An Origin that survives to here therefore
 * names the editor's own UI. And a browser cannot decline to send one: Origin
 * is attached to every request whose method is not GET or HEAD, same-origin
 * included, and it is a forbidden header name, so no page can strip or forge
 * it. A page that is not the editor cannot reach these routes at all. The
 * game, on its own loopback port, fails on the port comparison like any other
 * page on the machine.
 *
 * WHAT IS LEFT OVER, SAID PLAINLY
 *
 * `isRequestAllowed` deliberately admits requests with NO Origin, because
 * curl, the CLI and the MCP server never send one and must keep working. That
 * is the leftover: a local process can omit the header, and it can equally
 * well forge one. Nothing checkable in a header defends against a process
 * already running as the user, and it does not need to: that process has the
 * disk. What this rules out is the case that actually escalates, a page in a
 * browser reaching a server it was not meant to reach.
 *
 * Unattested callers are not refused outright, because that would be a rule
 * about folders again. They may still name a root the user has already
 * blessed (open now, or on the recents list). What they cannot do is
 * introduce a NEW one, which is the whole of the primitive above.
 */
async function denyUnattestedRoot(
  ctx: ProjectServerContext,
  req: IncomingMessage,
  rawPath: unknown,
): Promise<JsonResult | null> {
  if (req.headers.origin !== undefined) return null;
  if (typeof rawPath === 'string' && rawPath.trim() !== '' && (await ctx.isKnownRoot(path.resolve(rawPath.trim())))) {
    return null;
  }
  return {
    status: 403,
    body: {
      ok: false,
      error: 'Forbidden: only the editor window can open a folder it has not opened before.',
    },
  };
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
    return sendJson(res, 403, {
      ok: false,
      error: 'Forbidden: cross-origin request rejected',
    });
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams;
  const method = req.method ?? 'GET';
  const key = `${method} ${url.pathname}`;

  // The /game/ and /evidence/ mounts were served here. They now live on their
  // own loopback origin (server/gameServer.ts). Nothing that serves project
  // bytes belongs on this origin.

  // Raw bytes, deliberately outside readJsonBody: pictures should not become
  // base64 strings in either HTTP JSON or the conversation WebSocket.
  if (key === 'POST /api/chat/attachments') {
    const rawProject = q.get('project');
    if (!rawProject || rawProject.trim() === '') {
      return sendJson(res, 400, { ok: false, error: 'Missing "project".' });
    }
    const root = path.resolve(rawProject);
    if (!ctx.isOpenRoot(root)) {
      return sendJson(res, 403, { ok: false, error: 'Folder is not open.' });
    }
    const lengthHeader = req.headers['content-length'];
    const contentLength =
      typeof lengthHeader === 'string' && lengthHeader !== '' ? Number.parseInt(lengthHeader, 10) : null;
    try {
      const upload = await ctx.chatAttachments.stage(root, req, {
        name: q.get('name'),
        mimeType: q.get('mimeType'),
        contentLength,
      });
      return sendJson(res, 200, { ok: true, ...upload });
    } catch (error) {
      const message = (error as Error).message;
      const tooLarge = message.includes('too large');
      return sendJson(res, tooLarge ? 413 : 400, { ok: false, error: message });
    }
  }

  // The harness registry (connectors + skills) owns its own route module.
  if (url.pathname === '/api/harness/registry')
    return (await import('./harnessRegistry.js')).routeHarnessRegistry(ctx, req, res);

  // Skills are the one thing here that is NOT per-project — they belong to the
  // person, so the route takes no `project` and does its own validation.
  if (url.pathname === '/api/skills' || url.pathname === '/api/skills/source') {
    return (await import('./skillsRoutes.js')).routeSkills(req, res, url.pathname);
  }

  // Which agent CLIs are installed is a fact about the machine, not the folder
  // — and the composer's picker asks it on Home too, where there is no folder
  // to scope it to. Like skills, it takes no `project`; unlike skills it only
  // reads, and only from PATH.
  if (url.pathname === '/api/agent-clis') {
    return (await import('./agentClis.js')).routeAgentClis(req, res);
  }

  // Personalization is the other one: a name and standing instructions belong
  // to the person, so like skills the route takes no `project` and validates
  // everything itself.
  if (url.pathname === '/api/personalization') {
    return (await import('./personalization.js')).routePersonalization(req, res);
  }

  // Which models the user wants offered. Also the person's, not the folder's,
  // and read by the composer's picker on Home where there is no folder at all.
  if (url.pathname === '/api/model-prefs') {
    return (await import('./modelPrefs.js')).routeModelPrefs(req, res);
  }

  // How much the agent may do without asking. Per PROJECT, unlike the three
  // above, but stored per machine and never in the folder: see the header of
  // permissionMode.ts for why a shared `skip` would be handing out remote code
  // execution. It takes `project` and does its own validation, so it stays out
  // of the context's open-folder table like the other route modules here.
  if (url.pathname === '/api/permission-mode') {
    return (await import('./permissionMode.js')).routePermissionMode(req, res);
  }

  switch (key) {
    case 'POST /api/workspace/open': {
      const body = await readJsonBody(req);
      const denied = await denyUnattestedRoot(ctx, req, body.path);
      if (denied) return sendJson(res, denied.status, denied.body);
      const result = await ctx.openWorkspace(body.path);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/workspace/create': {
      const body = await readJsonBody(req);
      const result = await ctx.createWorkspace(body.prompt, body.name);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/workspace/close': {
      // No `denyUnattestedRoot`: this only narrows what the server will serve,
      // so there is nothing here for an unattested caller to gain. See
      // ctx.closeWorkspace.
      const body = await readJsonBody(req);
      const result = await ctx.closeWorkspace(body.path);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/workspace/recent': {
      const result = await ctx.recentWorkspaces();
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/usage': {
      const result = await ctx.usage();
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/workspace/identity': {
      const body = await readJsonBody(req);
      const result = await ctx.setProjectIdentity(body.project, body.icon, body.color);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/project/doc': {
      const result = await ctx.projectDoc(q.get('project'), q.get('name'));
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/project/doc': {
      const body = await readJsonBody(req);
      const result = await ctx.writeProjectDoc(body.project, body.name, body.text);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/chats/recent': {
      const result = await ctx.recentChats();
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
    case 'POST /api/tester/play': {
      const body = await readJsonBody(req);
      const result = await ctx.startTesterSession(body.project, body.maxSteps);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/tester/stop': {
      const body = await readJsonBody(req);
      const result = await ctx.stopTesterSession(body.project);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/tester/history/all': {
      const result = await ctx.testerHistoryAll();
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/tester/history': {
      const result = await ctx.testerHistory(q.get('project'));
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/tester/approve': {
      const body = await readJsonBody(req);
      const result = await ctx.approveTesterProposals(body.project, body.session, body.proposals);
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
    case 'GET /api/context': {
      const result = await ctx.listContext(q.get('project'));
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/context': {
      // Context files arrive base64-encoded like an asset import, so the body
      // limit has to cover the ~4/3 inflation plus JSON overhead; the real
      // per-file and per-request caps are enforced in projectContext.
      const body = await readJsonBody(req, 72 * 1024 * 1024);
      const result = await ctx.addContextFiles(body.project, body.files);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/context/delete': {
      const body = await readJsonBody(req);
      const result = await ctx.removeContextFile(body.project, body.name);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/context/file': {
      const result = await ctx.readContextText(q.get('project'), q.get('name'));
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
      const result = await ctx.setAppSettings(body.project, body.apiKey, body);
      return sendJson(res, result.status, result.body);
    }
    case 'GET /api/chat/providers': {
      const result = await ctx.chatProviders(q.get('project'));
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/chat/providers/openai/login': {
      const body = await readJsonBody(req);
      const result = await ctx.openAiLogin(body.project);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/project/open': {
      const body = await readJsonBody(req);
      const denied = await denyUnattestedRoot(ctx, req, body.path);
      if (denied) return sendJson(res, denied.status, denied.body);
      const result = await ctx.openProject(body.path);
      return sendJson(res, result.status, result.body);
    }
    case 'POST /api/project/create': {
      const body = await readJsonBody(req);
      // `dir` is the PARENT the new project lands under, so it is the folder
      // being named here, and this route both writes into it and opens what it
      // wrote. Same gate as the two above.
      const denied = await denyUnattestedRoot(ctx, req, body.dir);
      if (denied) return sendJson(res, denied.status, denied.body);
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
        // Everything this route returns is a file an AGENT wrote, served from
        // the control plane's own origin. That is a way back in to the hole the
        // game-origin split closed: a `.html` here comes back as `text/html`,
        // the game frame carries `allow-popups` without
        // `allow-popups-to-escape-sandbox` (so a popup inherits its
        // `allow-same-origin`), and `window.open` on this URL would run
        // agent-written script AS the editor.
        //
        // `sandbox` with no allow tokens is the surgical answer: any DOCUMENT
        // made from this response lands in a unique opaque origin with scripts
        // off, so navigating to it gains nothing. Images are not documents and
        // are unaffected, which is what keeps the asset pipeline working: an
        // SVG texture in an `<img>` still renders, and script inside an SVG
        // never runs in that context anyway. `nosniff` stops a content type
        // being guessed past this.
        res.setHeader('Content-Security-Policy', 'sandbox');
        res.setHeader('X-Content-Type-Options', 'nosniff');
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
      return sendJson(res, 404, {
        ok: false,
        error: `Unknown API route: ${key}`,
      });
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
    async configureServer(server) {
      // Started (and awaited) before the first request can arrive, so
      // /api/meta never answers with a game origin the client would then have
      // to poll for. A failure here leaves gameOrigin null and the pane says
      // so; it must never fall back to serving the game from this origin.
      let game: GameServerHandle | null = null;
      try {
        game = await startGameServer(ctx);
        ctx.setGameOrigin(game.origin);
      } catch (err) {
        console.error(`[hearth] game mount server could not start: ${(err as Error).message}`);
      }

      server.middlewares.use((req, res, next) => {
        // /api/* only; everything else is Vite's (the editor UI itself). The
        // game and evidence mounts are on `game` above, on their own origin.
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (isHearthServerPath(pathname)) {
          route(ctx, req, res).catch((err: unknown) => {
            sendJson(res, 500, {
              ok: false,
              error: (err as Error).message ?? 'Internal error',
            });
          });
          return;
        }
        // Everything else is Vite's, with one thing taken off it first: no
        // DOCUMENT may be made out of /@fs/. See viteFsVerdict for the popup
        // chain that ends at pty-start. The editor's module graph is
        // `Sec-Fetch-Dest: script`, so it never meets this.
        if (guardViteFs(req, res)) return;
        return next();
      });
      // Absent in middleware mode (Vite embedded in another server); the /api
      // routes above still work there, just without the WS channel. Vite's
      // httpServer type also covers http2's secure server (HTTPS dev
      // certs), which this dev server never uses; attachWebSocket only
      // needs the plain node:http surface (`.on('upgrade'/'close', ...)`).
      if (server.httpServer) {
        const httpServer = server.httpServer as import('node:http').Server;
        attachWebSocket(httpServer, ctx);
        // Its own upgrade listener on its own path, so a window that never
        // playtests never holds a socket for pictures of one.
        attachProbeStream(httpServer, ctx.probeBus, ctx.isOpenRoot);
        // A dev-server restart re-runs this hook, so the previous run's
        // listener has to go or its port leaks for the process's lifetime.
        httpServer.on('close', () => void game?.close());
      }
    },
  };
}
