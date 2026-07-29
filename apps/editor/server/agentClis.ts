/**
 * Which agent CLIs are actually on this machine.
 *
 *   GET /api/agent-clis  → every CLI Hearth knows by name, and whether it is
 *                          installed here
 *
 * The composer's picker offers two ways to work: a chat Hearth drives itself,
 * or one of these CLIs running in the embedded terminal. The second half is
 * only honest if the list is measured rather than assumed, so nothing here is
 * hardcoded as present: every entry is resolved against the user's real
 * login-shell PATH before it is reported.
 *
 * Three things shape this file:
 *
 *  1. **A GUI app's PATH is not the user's PATH.** An Electron app launched
 *     from Finder inherits a minimal system PATH, and these binaries live in
 *     `~/.local/bin`, a homebrew prefix, or an nvm shim — none of which are in
 *     it. `loginShellPathEnv()` is the same fix `chatDrivers/codex.ts` uses for
 *     the same reason.
 *  2. **Hearth knows the name and nothing more.** A registry entry says what
 *     command to run and what to call it. It does NOT claim to know the CLI's
 *     models, flags or capabilities, because Hearth never asks it any of that
 *     — it types the command into a shell and gets out of the way. The one
 *     extra thing an entry may carry is an install hint, and only where that
 *     hint is a documented published package.
 *  3. **Not installed is a state, not an omission.** The route reports the
 *     whole registry with an `installed` flag rather than filtering, so the
 *     picker can show a CLI as unavailable and say what would make it work.
 *     Offering it as though it would run is what would be dishonest; naming it
 *     is not.
 *
 * Adding a CLI is one line in AGENT_CLIS.
 *
 * Like skills and personalization, this is NOT scoped to a project: what is
 * installed belongs to the machine, not to the folder that happens to be open,
 * and the picker needs an answer on Home too. It takes no `project` and
 * touches nothing inside one.
 */
import { constants as fsConstants, promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { loginShellPathEnv } from './shellEnv.js';

/** One agent CLI Hearth can launch in the terminal. */
export interface AgentCli {
  /** Stable id, used in code and in the picker's selection state. Never shown. */
  id: string;
  /** The word typed into the shell. */
  command: string;
  /** What the CLI's own makers call it. */
  label: string;
  /**
   * How to install it, when Hearth knows a published command that does so.
   * Null means Hearth does not know, and the picker says only that the binary
   * was not found rather than guessing at a package name.
   */
  installHint: string | null;
}

/**
 * The CLIs Hearth knows by name, in the order the picker lists them.
 *
 * Fixed order so nothing reshuffles under the pointer as installs come and go.
 * Membership here is a claim about one thing only: that Hearth knows what to
 * type. Whether it is installed is measured below.
 *
 * THE LIST IS A CONVENIENCE, NOT A BOUNDARY, and that is the whole reason it
 * is long rather than short. The terminal runs any command you type, so a CLI
 * that is not here is not unsupported — it is one word of typing. A two-entry
 * list read as the set of agents Hearth works with, which is the exact
 * assumption this app must never plant, so the list now names the field rather
 * than the two harnesses Hearth happens to also drive in chat. Every surface
 * that renders it says out loud that anything else works too.
 *
 * Nothing here is an integration, a partnership or an endorsement. These are
 * other people's programs, named so Hearth can type their name for you.
 */
export const AGENT_CLIS: readonly AgentCli[] = [
  { id: 'claude', command: 'claude', label: 'Claude Code', installHint: 'npm i -g @anthropic-ai/claude-code' },
  { id: 'codex', command: 'codex', label: 'Codex', installHint: 'npm i -g @openai/codex' },
  { id: 'gemini', command: 'gemini', label: 'Gemini CLI', installHint: 'npm i -g @google/gemini-cli' },
  { id: 'opencode', command: 'opencode', label: 'opencode', installHint: 'npm i -g opencode-ai' },
  { id: 'amp', command: 'amp', label: 'Amp', installHint: 'npm i -g @sourcegraph/amp' },
  { id: 'crush', command: 'crush', label: 'Crush', installHint: 'npm i -g @charmland/crush' },
  { id: 'hermes', command: 'hermes', label: 'Hermes', installHint: null },
  // No hint below this line, deliberately. These install through a shell
  // script, a Python packaging tool, or a platform installer that differs per
  // machine, and a hint is a command Hearth is telling someone to run. Naming
  // the binary is a fact; guessing the package would be Hearth being confidently
  // wrong in the one place a user cannot check it.
  { id: 'aider', command: 'aider', label: 'Aider', installHint: null },
  { id: 'goose', command: 'goose', label: 'Goose', installHint: null },
  { id: 'cursor-agent', command: 'cursor-agent', label: 'Cursor CLI', installHint: null },
];

/** A registry entry plus what this machine says about it. */
export interface AgentCliStatus extends AgentCli {
  installed: boolean;
  /** Where it was found. Null when it was not. */
  path: string | null;
}

/**
 * Windows names the same binary several ways and PATH lookup is by extension.
 * The empty string is last so an extensionless file still resolves.
 */
const WINDOWS_EXTENSIONS = ['.cmd', '.exe', '.bat', ''];

/** Is this path a file we could actually run? Same check codex.ts makes. */
async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(candidate); // follows symlinks: ~/.local/bin is full of them
    if (!stat.isFile()) return false;
    await fsp.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a command against a PATH string, left to right, the way a shell
 * would. Takes the PATH rather than reading the environment so the whole of
 * detection is testable against a directory laid out by hand.
 */
export async function findOnPath(command: string, pathValue: string): Promise<string | null> {
  const extensions = process.platform === 'win32' ? WINDOWS_EXTENSIONS : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === '') continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The registry, resolved against this machine.
 *
 * `env` is for tests; in the app it is the login shell's environment, falling
 * back to the process's own when that could not be read (Windows always, and
 * any shell that would not answer). A CLI that cannot be resolved is reported
 * as not installed rather than dropped.
 */
export async function detectAgentClis(env?: NodeJS.ProcessEnv): Promise<AgentCliStatus[]> {
  const base = env ?? (await loginShellPathEnv()) ?? process.env;
  const pathValue = base.PATH ?? '';
  return Promise.all(
    AGENT_CLIS.map(async (cli) => {
      const found = await findOnPath(cli.command, pathValue);
      return { ...cli, installed: found !== null, path: found };
    }),
  );
}

/** What the picker reads. The resolved path stays on this side: it is how the
 * answer was reached, not part of it, and nothing on screen shows it. */
export interface AgentCliInfoWire {
  id: string;
  command: string;
  label: string;
  installed: boolean;
  installHint: string | null;
}

export function toWire(status: AgentCliStatus): AgentCliInfoWire {
  return {
    id: status.id,
    command: status.command,
    label: status.label,
    installed: status.installed,
    installHint: status.installHint,
  };
}

export interface AgentClisResult {
  status: number;
  body: unknown;
}

export async function getAgentClis(): Promise<AgentClisResult> {
  return { status: 200, body: { ok: true, clis: (await detectAgentClis()).map(toWire) } };
}

/** The http adapter. Everything above it is plain functions. */
export async function routeAgentClis(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const result: AgentClisResult =
    req.method === 'GET' ? await getAgentClis() : { status: 405, body: { ok: false, error: 'Use GET.' } };
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(result.body));
}
