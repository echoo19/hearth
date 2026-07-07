/**
 * Agent CLI detection + `.mcp.json` preparation for the embedded agent
 * panel. Two independent concerns:
 *
 *  - detectAgents(): is `claude` / `codex` on PATH, and what version?
 *  - prepareMcpConfig(): merge-write a `hearth` entry into the project's
 *    `.mcp.json` so a generic MCP-capable agent (Claude Code via its
 *    project-scoped .mcp.json, or any other client that reads the same
 *    file) picks up this project's Hearth MCP server automatically.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const DETECT_TIMEOUT_MS = 3000;

export interface AgentDetection {
  found: boolean;
  version?: string;
}

export interface DetectAgentsResult {
  claude: AgentDetection;
  codex: AgentDetection;
}

/** Runs `bin args...`, capturing stdout, killing it if it outlives `timeoutMs`. */
function runWithTimeout(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      // `bin` can be a `where`-resolved path ending in `.cmd` (e.g. a global
      // `claude`/`codex` npm shim on Windows). Node's CVE-2024-27980
      // hardening refuses to spawn a .cmd/.bat file directly without
      // `shell: true` (throws/emits EINVAL) — opt in on win32. `bin`/`args`
      // here are either hardcoded ('which'/'where'/'--version') or a path
      // resolved from `where`/`which`'s own output, not attacker input.
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
    } catch {
      // Belt-and-suspenders: some spawn failures (invalid options, ENOENT in
      // certain Node/OS combos) throw synchronously instead of surfacing via
      // the 'error' event below — treat either path as "not found".
      resolve({ code: null, stdout: '' });
      return;
    }
    let settled = false;
    let stdout = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, stdout });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

/** Locates a binary on PATH the way a shell would (`which`/`where`). */
async function whichBinary(name: string): Promise<string | null> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const { code, stdout } = await runWithTimeout(whichCmd, [name], DETECT_TIMEOUT_MS);
  if (code !== 0) return null;
  const first = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return first ?? null;
}

async function detectOne(bin: string): Promise<AgentDetection> {
  const resolved = await whichBinary(bin);
  if (!resolved) return { found: false };
  const { code, stdout } = await runWithTimeout(resolved, ['--version'], DETECT_TIMEOUT_MS);
  if (code !== 0) return { found: true };
  const version = stdout.trim();
  return { found: true, version: version || undefined };
}

/** Detects the `claude` and `codex` CLIs on PATH. Never throws. */
export async function detectAgents(): Promise<DetectAgentsResult> {
  const [claude, codex] = await Promise.all([detectOne('claude'), detectOne('codex')]);
  return { claude, codex };
}

// ---------------------------------------------------------------------------
// .mcp.json preparation
// ---------------------------------------------------------------------------

/**
 * The editor's simplified 4-tier picker, mapped onto the MCP server's real
 * `--mode` tokens (packages/core/src/permissions.ts: read-only, safe-edit,
 * code-edit, asset-edit, build; `all` is a literal shorthand there).
 * `read-only` is always implied by the server itself.
 */
export type AgentPermissionMode = 'read-only' | 'safe-edit' | 'full' | 'all';

const MODE_ARGS: Record<AgentPermissionMode, string> = {
  'read-only': 'read-only',
  'safe-edit': 'safe-edit',
  full: 'safe-edit,code-edit,asset-edit', // everything except build
  all: 'all', // everything, including build/export
};

interface McpServerEntry {
  command: string;
  args: string[];
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/** Thrown when an existing .mcp.json can't be parsed — we refuse to clobber it. */
export class McpConfigParseError extends Error {}

async function readExistingConfig(mcpConfigPath: string): Promise<McpConfig> {
  let raw: string;
  try {
    raw = await fsp.readFile(mcpConfigPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    return raw.trim() === '' ? {} : (JSON.parse(raw) as McpConfig);
  } catch {
    throw new McpConfigParseError(
      `${mcpConfigPath} exists but is not valid JSON; refusing to overwrite it. Fix or remove the file and try again.`,
    );
  }
}

/**
 * Merge-writes the `hearth` MCP server entry into <root>/.mcp.json, leaving
 * any sibling servers untouched. Idempotent: re-running with the same
 * arguments produces the same file.
 */
export async function prepareMcpConfig(
  root: string,
  mcpPath: string,
  mode: AgentPermissionMode,
): Promise<{ written: boolean }> {
  const mcpConfigPath = path.join(root, '.mcp.json');
  const existing = await readExistingConfig(mcpConfigPath);

  const modeArg = MODE_ARGS[mode];
  const servers = { ...(existing.mcpServers ?? {}) };
  servers.hearth = {
    command: 'node',
    args: [mcpPath, '--project', root, '--mode', modeArg],
  };
  const next: McpConfig = { ...existing, mcpServers: servers };

  await fsp.writeFile(mcpConfigPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { written: true };
}
