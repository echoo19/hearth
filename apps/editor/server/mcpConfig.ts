/**
 * Auto-provisions the `hearth` MCP server entry into a project's `.mcp.json`,
 * so that when the user types `claude` in the embedded project terminal, Claude
 * Code discovers the server and loads the whole engine as MCP tools with no
 * manual `claude mcp add` step.
 *
 * This is purely passive config writing — nothing is ever spawned or detected
 * here — so it cannot reintroduce the old launcher's silent "click the tile and
 * nothing happens" spawn failures (those came from spawning `claude` directly
 * via node-pty without shell PATH resolution; the embedded shell fixed that).
 *
 * The merge only ever touches the `hearth` key, leaving any other MCP servers
 * the user configured untouched. `.mcp.json` holds machine-absolute paths, so
 * it is gitignored (PROJECT_GITIGNORE) and refreshed on open: a project copied
 * to another machine simply has none and gets a fresh one, and a stale mcp path
 * (e.g. after a desktop-app update relocates the bundled tools) is corrected in
 * place while preserving whatever `--mode` the user chose.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * The editor's simplified tiers, mapped onto the MCP server's real `--mode`
 * tokens (packages/core/src/permissions.ts: read-only, safe-edit, code-edit,
 * asset-edit, build; `all` is a literal shorthand there). `read-only` is always
 * implied by the server itself.
 */
export type AgentPermissionMode = 'read-only' | 'safe-edit' | 'full' | 'all';

const MODE_ARGS: Record<AgentPermissionMode, string> = {
  'read-only': 'read-only',
  'safe-edit': 'safe-edit',
  full: 'safe-edit,code-edit,asset-edit', // everything except build
  all: 'all', // everything, including build/export
};

/** The argv Hearth's MCP entry runs: `node <mcp> --project <root> --mode <m>`. */
export function hearthMcpArgs(mcpPath: string, root: string, mode: AgentPermissionMode): string[] {
  return buildArgs(mcpPath, root, MODE_ARGS[mode]);
}

function buildArgs(mcpPath: string, root: string, modeArg: string): string[] {
  return [mcpPath, '--project', root, '--mode', modeArg];
}

/** Thrown when an existing `.mcp.json` can't be parsed — we refuse to clobber it. */
export class McpConfigParseError extends Error {}

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Env for the hearth MCP entry. When `command` is the packaged app's Electron
 * binary, ELECTRON_RUN_AS_NODE makes it run as plain Node — so the MCP server
 * uses Hearth's OWN bundled Node and the user never needs a system `node`
 * installed. Harmless when `command` is already a plain-node binary (dev).
 */
const HEARTH_MCP_ENV = { ELECTRON_RUN_AS_NODE: '1' };

function envEqual(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (!a) return false;
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
}
interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface EnsureMcpResult {
  written: boolean;
  configPath: string;
}

function argsEqual(a: string[] | undefined, b: string[]): boolean {
  return !!a && a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Reads the raw `--mode` token from an existing hearth args array, if present. */
function existingModeArg(args: string[] | undefined): string | null {
  if (!args) return null;
  const i = args.indexOf('--mode');
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

async function readConfig(configPath: string): Promise<McpConfig> {
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch {
    return {}; // missing is fine — we create it
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as McpConfig) : {};
  } catch {
    throw new McpConfigParseError(`Could not parse ${configPath}`);
  }
}

/**
 * Ensures `<root>/.mcp.json` has a correct `hearth` server entry.
 *
 * Writes it if absent or if the resolved mcp path differs from what's on disk
 * (correcting a stale path), preserving a user-chosen `--mode`. Returns
 * `{ written: false }` when the on-disk entry is already correct.
 */
export async function ensureHearthMcpConfig(
  root: string,
  mcpPath: string,
  defaultMode: AgentPermissionMode,
  nodeBin: string = process.execPath,
): Promise<EnsureMcpResult> {
  const configPath = path.join(root, '.mcp.json');
  const existing = await readConfig(configPath);
  const current = existing.mcpServers?.hearth;
  const modeArg = existingModeArg(current?.args) ?? MODE_ARGS[defaultMode];
  const desired = buildArgs(mcpPath, root, modeArg);

  if (
    current &&
    current.command === nodeBin &&
    argsEqual(current.args, desired) &&
    envEqual(current.env, HEARTH_MCP_ENV)
  ) {
    return { written: false, configPath };
  }

  const servers = { ...(existing.mcpServers ?? {}) };
  servers.hearth = { command: nodeBin, args: desired, env: { ...HEARTH_MCP_ENV } };
  const next: McpConfig = { ...existing, mcpServers: servers };
  await fsp.writeFile(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { written: true, configPath };
}
