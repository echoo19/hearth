/**
 * Agent CLI detection + per-tool MCP config preparation for the embedded
 * agent panel. Two concerns:
 *
 *  - detectAgents(): which agent CLIs are on PATH (claude / codex / opencode /
 *    hermes), plus ollama for OpenCode's local-model path (and the models it
 *    has pulled), and what version each is.
 *  - prepareAgentTool(): write this project's Hearth MCP server into the
 *    selected tool's OWN config format so the agent picks it up with zero
 *    manual steps — never clobbering a user's other servers or an
 *    already-correct entry:
 *      · claude   → <project>/.mcp.json          (project JSON)
 *      · opencode → <project>/opencode.json      (project JSON, + Ollama provider)
 *      · codex    → ~/.codex/config.toml         (global TOML, via `codex mcp add`)
 *      · hermes   → ~/.hermes/config.yaml        (global YAML, merged in place)
 *
 * Every prepare path also backfills the project-local best-practices skills
 * (ensureAgentSkill) so an agent launched from any stack gets them.
 *
 * Codex and Hermes read a single GLOBAL config, so their `hearth` entry points
 * at whichever project was most recently prepared — which is always the one
 * you're launching from (prepare runs immediately before launch). The Agent
 * panel says so in its per-tool hint.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import {
  AGENT_SKILL_CONTENT,
  AGENT_SKILL_FILE,
  AGENT_CRAFT_SKILL_CONTENT,
  AGENT_CRAFT_SKILL_FILE,
} from '@hearth/core';

const DETECT_TIMEOUT_MS = 3000;
/** `codex mcp add` and `ollama list` shell out; give them a bit more room. */
const PREPARE_TIMEOUT_MS = 15000;
/**
 * One-time login-shell spawn to learn the user's real PATH (see
 * loginShellPathEnv). Heavier rc setups (nvm, mise, oh-my-zsh) can take
 * seconds to initialize, so this gets more room than a `--version` probe;
 * it runs at most once per server process and falls back cleanly on timeout.
 */
const LOGIN_SHELL_TIMEOUT_MS = 10000;

export interface AgentDetection {
  found: boolean;
  version?: string;
}

/** Ollama additionally surfaces the local models it has pulled (for OpenCode). */
export interface OllamaDetection extends AgentDetection {
  models?: string[];
}

export interface DetectAgentsResult {
  claude: AgentDetection;
  codex: AgentDetection;
  opencode: AgentDetection;
  hermes: AgentDetection;
  ollama: OllamaDetection;
}

/** The agent stacks the launcher can wire up (everything except a bare shell). */
export type AgentTool = 'claude' | 'codex' | 'opencode' | 'hermes';

/** Runs `bin args...`, capturing stdout, killing it if it outlives `timeoutMs`.
 * `env`, when given, replaces the child's environment (defaults to inheriting
 * process.env) — used to re-run detection under the login-shell PATH. */
function runWithTimeout(
  bin: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      // `bin` can be a `where`-resolved path ending in `.cmd` (e.g. a global
      // npm shim on Windows). Node's CVE-2024-27980 hardening refuses to spawn
      // a .cmd/.bat file directly without `shell: true` (throws/emits EINVAL) —
      // opt in on win32. `bin`/`args` here are either hardcoded ('which'/'where'
      // /'--version'/'mcp add') or a path resolved from `where`/`which`'s own
      // output, never attacker input.
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
        ...(env ? { env } : {}),
      });
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

// ---------------------------------------------------------------------------
// Login-shell PATH resolution
// ---------------------------------------------------------------------------
//
// A GUI-launched app (Electron from Finder/.desktop) never sources the user's
// shell rc files, so on macOS its PATH is just /usr/bin:/bin:/usr/sbin:/sbin —
// which is missing ~/.local/bin (Claude Code's default install location),
// /opt/homebrew/bin, nvm/mise/volta shims, etc. `which claude` under that PATH
// reports "not installed" to a user who has it. The dev server (`npm run dev`)
// runs from a terminal and never hits this, which is why it hides from tests.
//
// Fix (same approach as VS Code/Zed): once per process, ask the user's login
// shell for its PATH and merge it into the env used to locate agent binaries.
// Only consulted when a binary is NOT already findable on the current PATH,
// so terminal-launched dev servers never pay for the shell spawn.

const SHELL_ENV_BEGIN = '__HEARTH_SHELL_ENV_BEGIN__';
const SHELL_ENV_END = '__HEARTH_SHELL_ENV_END__';
// Hardcoded — nothing user-controlled is ever interpolated into this command.
// `/usr/bin/env` (an absolute path, present on every POSIX system) prints
// `PATH=...` in a shell-syntax-independent way, so this works under zsh, bash,
// fish, etc. The markers fence our output off from rc-file banners/motd noise.
const SHELL_ENV_COMMAND = `echo ${SHELL_ENV_BEGIN}; /usr/bin/env; echo ${SHELL_ENV_END}`;

/**
 * Extracts the PATH value from a login shell's (noisy) output: rc files may
 * print banners before/after our block, so only lines between the last
 * BEGIN marker and its matching END marker are considered. Exported for
 * unit testing. Returns null when the markers or PATH line are missing.
 */
export function parseLoginShellPath(stdout: string): string | null {
  const start = stdout.lastIndexOf(SHELL_ENV_BEGIN);
  if (start === -1) return null;
  const end = stdout.indexOf(SHELL_ENV_END, start + SHELL_ENV_BEGIN.length);
  if (end === -1) return null;
  const block = stdout.slice(start + SHELL_ENV_BEGIN.length, end);
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('PATH=')) {
      const value = line.slice('PATH='.length).trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Merges two PATH strings: every entry of `current` (in order, so anything
 * the process was launched with keeps winning — dev-server overrides stay
 * intact), then any login-shell entries not already present. Exported for
 * unit testing.
 */
export function mergePathStrings(current: string, fromShell: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...current.split(path.delimiter), ...fromShell.split(path.delimiter)]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(path.delimiter);
}

let loginShellPathEnvPromise: Promise<NodeJS.ProcessEnv | null> | null = null;

/** Test hook: clears the per-process login-shell PATH cache. */
export function resetLoginShellPathCacheForTests(): void {
  loginShellPathEnvPromise = null;
}

async function fetchLoginShellPathEnv(): Promise<NodeJS.ProcessEnv | null> {
  // $SHELL is the user's own configured shell (same trust level as PATH
  // itself; ptyManager already spawns it for the embedded terminal). GUI
  // launchd/systemd sessions normally set it; fall back to the platform
  // default login shell when absent.
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  // -i -l -c: interactive login shell, so BOTH profile files (.zprofile/
  // .bash_profile — where PATH usually lives) and rc files (.zshrc — where
  // version managers usually live) are sourced. Bounded by a hard timeout;
  // any failure degrades to "no extra PATH" (today's behavior), never worse.
  const { code, stdout } = await runWithTimeout(shell, ['-ilc', SHELL_ENV_COMMAND], LOGIN_SHELL_TIMEOUT_MS);
  if (code !== 0) return null;
  const shellPath = parseLoginShellPath(stdout);
  if (!shellPath) return null;
  const currentPath = process.env.PATH ?? '';
  const merged = mergePathStrings(currentPath, shellPath);
  if (merged === currentPath) return null; // nothing the current PATH doesn't already have
  return { ...process.env, PATH: merged };
}

/**
 * The process env with PATH widened by the user's login-shell PATH, or null
 * when that adds nothing (or can't be resolved: Windows, timeout, no $SHELL
 * binary, unparseable output). Cached for the process lifetime — the login
 * shell is spawned at most once. Never throws.
 */
export function loginShellPathEnv(): Promise<NodeJS.ProcessEnv | null> {
  if (process.platform === 'win32') return Promise.resolve(null); // GUI PATH is already correct there
  if (!loginShellPathEnvPromise) {
    loginShellPathEnvPromise = fetchLoginShellPathEnv().catch(() => null);
  }
  return loginShellPathEnvPromise;
}

/** Runs `which`/`where` for `name` under `env` (or the inherited env). */
async function whichIn(name: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const { code, stdout } = await runWithTimeout(whichCmd, [name], DETECT_TIMEOUT_MS, env);
  if (code !== 0) return null;
  const first = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return first ?? null;
}

/**
 * Locates a binary the way the user's shell would: first on the process's own
 * PATH (always sufficient for terminal-launched dev servers — no login shell
 * is spawned in that case), then on the login-shell PATH for GUI-launched
 * apps. Also returns the env that found it, so follow-up spawns of the binary
 * (e.g. `--version`, `ollama list`, npm-shim launchers that need `node` on
 * PATH) run under a PATH where the binary and its runtime actually resolve.
 */
async function whichBinaryWithEnv(
  name: string,
): Promise<{ bin: string | null; env?: NodeJS.ProcessEnv }> {
  const direct = await whichIn(name);
  if (direct) return { bin: direct };
  const shellEnv = await loginShellPathEnv();
  if (!shellEnv) return { bin: null };
  return { bin: await whichIn(name, shellEnv), env: shellEnv };
}

async function detectOne(bin: string): Promise<AgentDetection> {
  const { bin: resolved, env } = await whichBinaryWithEnv(bin);
  if (!resolved) return { found: false };
  const { code, stdout } = await runWithTimeout(resolved, ['--version'], DETECT_TIMEOUT_MS, env);
  if (code !== 0) return { found: true };
  const version = stdout.trim();
  return { found: true, version: version || undefined };
}

/**
 * Parses `ollama list` table output into model names (the first column of
 * each row after the header). Exported for unit testing the parse without a
 * live ollama. Tolerates a missing/blank table (daemon down) — returns [].
 */
export function parseOllamaModels(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim());
  const models: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^NAME\b/i.test(line)) continue; // header row
    const name = line.split(/\s+/)[0];
    if (name) models.push(name);
  }
  return models;
}

async function detectOllama(): Promise<OllamaDetection> {
  const { bin: resolved, env } = await whichBinaryWithEnv('ollama');
  if (!resolved) return { found: false };
  const { code, stdout } = await runWithTimeout(resolved, ['--version'], DETECT_TIMEOUT_MS, env);
  const version = code === 0 ? stdout.trim() || undefined : undefined;
  // `ollama list` needs the daemon; if it's down this errors/empties out —
  // that's fine, we still report ollama as installed, just with no models.
  const listed = await runWithTimeout(resolved, ['list'], DETECT_TIMEOUT_MS, env);
  const models = listed.code === 0 ? parseOllamaModels(listed.stdout) : [];
  return { found: true, version, models };
}

/** Detects every agent CLI (and ollama) the launcher knows about. Never throws. */
export async function detectAgents(): Promise<DetectAgentsResult> {
  const [claude, codex, opencode, hermes, ollama] = await Promise.all([
    detectOne('claude'),
    detectOne('codex'),
    detectOne('opencode'),
    detectOne('hermes'),
    detectOllama(),
  ]);
  return { claude, codex, opencode, hermes, ollama };
}

// ---------------------------------------------------------------------------
// Permission modes
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

/** The argv every tool's Hearth MCP entry runs: `node <mcp> --project <root> --mode <m>`. */
export function hearthMcpArgs(mcpPath: string, root: string, mode: AgentPermissionMode): string[] {
  return [mcpPath, '--project', root, '--mode', MODE_ARGS[mode]];
}

/** Thrown when an existing config can't be parsed — we refuse to clobber it. */
export class McpConfigParseError extends Error {}

/** Outcome of a per-tool prepare: whether we wrote, and a human note for the UI. */
export interface PrepareToolResult {
  written: boolean;
  /** True when a valid, up-to-date hearth entry already existed (no write). */
  alreadyConfigured: boolean;
  /** Absolute path of the config that was written (or would be). */
  configPath: string;
  /** One-line, honest note for the panel (e.g. "already configured"). */
  note: string;
}

function argsEqual(a: string[] | undefined, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// Claude Code — <project>/.mcp.json  (project-scoped JSON)
// ---------------------------------------------------------------------------

interface McpServerEntry {
  command: string;
  args: string[];
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

async function readJsonConfig(configPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    return raw.trim() === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    throw new McpConfigParseError(
      `${configPath} exists but is not valid JSON; refusing to overwrite it. Fix or remove the file and try again.`,
    );
  }
}

/**
 * Merge-writes the `hearth` MCP server entry into <root>/.mcp.json, leaving any
 * sibling servers untouched. Idempotent; no-ops when already correct.
 */
export async function prepareMcpConfig(
  root: string,
  mcpPath: string,
  mode: AgentPermissionMode,
): Promise<PrepareToolResult> {
  const configPath = path.join(root, '.mcp.json');
  const existing = (await readJsonConfig(configPath)) as McpConfig;
  const args = hearthMcpArgs(mcpPath, root, mode);
  const current = existing.mcpServers?.hearth;
  if (current && current.command === 'node' && argsEqual(current.args, args)) {
    return { written: false, alreadyConfigured: true, configPath, note: '.mcp.json already configured.' };
  }
  const servers = { ...(existing.mcpServers ?? {}) };
  servers.hearth = { command: 'node', args };
  const next: McpConfig = { ...existing, mcpServers: servers };
  await fsp.writeFile(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { written: true, alreadyConfigured: false, configPath, note: 'Wrote hearth server to .mcp.json.' };
}

// ---------------------------------------------------------------------------
// OpenCode — <project>/opencode.json  (project-scoped JSON, + Ollama provider)
// ---------------------------------------------------------------------------

const OPENCODE_SCHEMA = 'https://opencode.ai/config.json';
const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

interface OpenCodeMcpEntry {
  type: 'local';
  command: string[];
  enabled: boolean;
}

/**
 * Merge-writes the `hearth` MCP server (and, when local ollama models are
 * present and no ollama provider is configured yet, an OpenAI-compatible
 * ollama provider) into <root>/opencode.json. Preserves every other key.
 */
export async function prepareOpenCodeConfig(
  root: string,
  mcpPath: string,
  mode: AgentPermissionMode,
  ollamaModels: string[] = [],
): Promise<PrepareToolResult> {
  const configPath = path.join(root, 'opencode.json');
  const existing = await readJsonConfig(configPath);
  const command = ['node', ...hearthMcpArgs(mcpPath, root, mode)];

  const mcp = { ...((existing.mcp as Record<string, unknown> | undefined) ?? {}) };
  const currentEntry = mcp.hearth as OpenCodeMcpEntry | undefined;
  const desiredEntry: OpenCodeMcpEntry = { type: 'local', command, enabled: true };

  // Provider: only add ollama if models exist AND the user hasn't set one up.
  const provider = { ...((existing.provider as Record<string, unknown> | undefined) ?? {}) };
  const wantProvider = ollamaModels.length > 0 && provider.ollama === undefined;

  const mcpUpToDate =
    currentEntry?.type === 'local' && currentEntry.enabled === true && argsEqual(currentEntry.command, command);
  if (mcpUpToDate && !wantProvider) {
    return { written: false, alreadyConfigured: true, configPath, note: 'opencode.json already configured.' };
  }

  mcp.hearth = desiredEntry;
  if (wantProvider) {
    provider.ollama = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: { baseURL: OLLAMA_BASE_URL },
      models: Object.fromEntries(ollamaModels.map((m) => [m, { name: m }])),
    };
  }

  const next: Record<string, unknown> = { $schema: OPENCODE_SCHEMA, ...existing, mcp };
  if (Object.keys(provider).length > 0) next.provider = provider;
  await fsp.writeFile(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  const note = wantProvider
    ? `Wrote hearth server + ollama provider (${ollamaModels.length} model${ollamaModels.length === 1 ? '' : 's'}) to opencode.json.`
    : 'Wrote hearth server to opencode.json.';
  return { written: true, alreadyConfigured: false, configPath, note };
}

// ---------------------------------------------------------------------------
// Codex — ~/.codex/config.toml  (global TOML, written via the codex CLI)
// ---------------------------------------------------------------------------

/**
 * The codex CLI owns its own TOML: `codex mcp add` writes a clean
 * `[mcp_servers.hearth]` table and touches nothing else, and `codex mcp get`
 * tells us whether it's already there. We use the tool's own native writer
 * rather than hand-merging TOML (no TOML serializer in this tree, and the CLI
 * is the canonical, forward-compatible format). Argv is built by
 * codexAddArgv() so it can be unit-tested without spawning codex.
 */
export function codexAddArgv(mcpPath: string, root: string, mode: AgentPermissionMode): string[] {
  // `--` ends option parsing; everything after is the stdio command + its args.
  return ['mcp', 'add', 'hearth', '--', 'node', ...hearthMcpArgs(mcpPath, root, mode)];
}

/** True iff `codex mcp get hearth` output already targets this project+mode. */
export function codexAlreadyConfigured(
  getOutput: string,
  mcpPath: string,
  root: string,
  mode: AgentPermissionMode,
): boolean {
  const needle = hearthMcpArgs(mcpPath, root, mode).join(' ');
  return getOutput.includes(needle);
}

export async function prepareCodexConfig(
  mcpPath: string,
  root: string,
  mode: AgentPermissionMode,
): Promise<PrepareToolResult> {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  const { bin, env } = await whichBinaryWithEnv('codex');
  if (!bin) {
    throw new Error('codex is not on PATH — install Codex or pick another launcher.');
  }
  const existing = await runWithTimeout(bin, ['mcp', 'get', 'hearth'], DETECT_TIMEOUT_MS, env);
  if (existing.code === 0 && codexAlreadyConfigured(existing.stdout, mcpPath, root, mode)) {
    return { written: false, alreadyConfigured: true, configPath, note: '~/.codex/config.toml already configured.' };
  }
  const add = await runWithTimeout(bin, codexAddArgv(mcpPath, root, mode), PREPARE_TIMEOUT_MS, env);
  if (add.code !== 0) {
    throw new Error(`codex mcp add failed (exit ${add.code ?? 'timeout'}).`);
  }
  return { written: true, alreadyConfigured: false, configPath, note: 'Wrote hearth server to ~/.codex/config.toml.' };
}

// ---------------------------------------------------------------------------
// Hermes — ~/.hermes/config.yaml  (global YAML, merged in place)
// ---------------------------------------------------------------------------

/**
 * Hermes reads `mcp_servers.<name>` from ~/.hermes/config.yaml (stdio entries
 * carry `command`/`args`). Its own `mcp add` is interactive (discovery-first;
 * it saves the server *disabled* if the connection probe fails), so we merge
 * the YAML directly instead — preserving every other Hermes setting.
 */
async function readYamlConfig(configPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? {} : yaml.load(raw);
  } catch {
    throw new McpConfigParseError(
      `${configPath} exists but is not valid YAML; refusing to overwrite it. Fix or remove the file and try again.`,
    );
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpConfigParseError(`${configPath} is not a YAML mapping; refusing to overwrite it.`);
  }
  return parsed as Record<string, unknown>;
}

export async function prepareHermesConfig(
  mcpPath: string,
  root: string,
  mode: AgentPermissionMode,
  homeDir: string = os.homedir(),
): Promise<PrepareToolResult> {
  const configPath = path.join(homeDir, '.hermes', 'config.yaml');
  const existing = await readYamlConfig(configPath);
  const args = hearthMcpArgs(mcpPath, root, mode);
  const servers = { ...((existing.mcp_servers as Record<string, unknown> | undefined) ?? {}) };
  const current = servers.hearth as { command?: string; args?: string[] } | undefined;
  if (current && current.command === 'node' && argsEqual(current.args, args)) {
    return { written: false, alreadyConfigured: true, configPath, note: '~/.hermes/config.yaml already configured.' };
  }
  servers.hearth = { command: 'node', args };
  const next = { ...existing, mcp_servers: servers };
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, yaml.dump(next, { lineWidth: -1 }), 'utf8');
  return { written: true, alreadyConfigured: false, configPath, note: 'Wrote hearth server to ~/.hermes/config.yaml.' };
}

// ---------------------------------------------------------------------------
// Skill backfill (shared by every prepare path)
// ---------------------------------------------------------------------------

/** Write one embedded skill to its project-local path if it is missing. */
async function backfillSkill(root: string, relPath: string, content: string): Promise<boolean> {
  const skillPath = path.join(root, ...relPath.split('/'));
  try {
    await fsp.access(skillPath);
    return false;
  } catch {
    // Not present — write it.
  }
  await fsp.mkdir(path.dirname(skillPath), { recursive: true });
  await fsp.writeFile(skillPath, content, 'utf8');
  return true;
}

/**
 * Backfill the project-local coding-agent skills under `<root>/.claude/skills/`
 * if they are missing: `hearth/SKILL.md` (operating the engine) and
 * `hearth-craft/SKILL.md` (making the game good). New projects get them at
 * creation (createProject / the template scaffolder), but projects made before
 * these shipped won't have them — so preparing an agent launch is the point to
 * add them, giving existing projects the skills on their next agent session.
 * Never overwrites an existing file (the user may have local edits). `written`
 * is true if either skill was written.
 */
export async function ensureAgentSkill(root: string): Promise<{ written: boolean }> {
  const wroteSkill = await backfillSkill(root, AGENT_SKILL_FILE, AGENT_SKILL_CONTENT);
  const wroteCraft = await backfillSkill(root, AGENT_CRAFT_SKILL_FILE, AGENT_CRAFT_SKILL_CONTENT);
  return { written: wroteSkill || wroteCraft };
}

// ---------------------------------------------------------------------------
// Dispatcher — one entry point the prepare route calls per selected tool
// ---------------------------------------------------------------------------

export interface PrepareToolOptions {
  tool: AgentTool;
  root: string;
  mcpPath: string;
  mode: AgentPermissionMode;
  /** Local ollama models, for OpenCode's provider block. Ignored by others. */
  ollamaModels?: string[];
}

/**
 * Writes the selected tool's Hearth MCP config in its native format and
 * backfills the skills. Returns the per-tool result plus whether a skill was
 * just written.
 */
export async function prepareAgentTool(
  opts: PrepareToolOptions,
): Promise<PrepareToolResult & { tool: AgentTool; skillWritten: boolean }> {
  const { tool, root, mcpPath, mode } = opts;
  let result: PrepareToolResult;
  switch (tool) {
    case 'claude':
      result = await prepareMcpConfig(root, mcpPath, mode);
      break;
    case 'opencode':
      result = await prepareOpenCodeConfig(root, mcpPath, mode, opts.ollamaModels ?? []);
      break;
    case 'codex':
      result = await prepareCodexConfig(mcpPath, root, mode);
      break;
    case 'hermes':
      result = await prepareHermesConfig(mcpPath, root, mode);
      break;
    default: {
      const never: never = tool;
      throw new Error(`Unknown agent tool: ${String(never)}`);
    }
  }
  const skill = await ensureAgentSkill(root);
  return { ...result, tool, skillWritten: skill.written };
}
