/**
 * Whether the Claude Code CLI is signed in, and as whom.
 *
 * WHY THIS EXISTS: Hearth used to answer "can Claude reply here" by checking
 * whether the `claude` binary was on PATH. That is not the same question. A
 * machine with claude installed and nobody signed into it reported itself as
 * ready, offered its models, and failed the turn. The binary being present is
 * a precondition, not an answer.
 *
 * `claude auth status` answers it properly and prints JSON:
 *
 *   { "loggedIn": true, "authMethod": "claude.ai", "email": "...",
 *     "subscriptionType": "max", ... }
 *
 * THE CREDENTIAL IS THE CLI'S, exactly as codex's is codex's. Hearth runs a
 * read-only status command and shows what comes back. It never reads the
 * credential file, never proxies a token, and never sends any of this
 * anywhere. Signing in happens in the CLI's own flow, in the terminal, where
 * the person talks to Anthropic directly.
 *
 * Everything here degrades to "not signed in" rather than throwing. A status
 * command that hangs, exits non-zero, or prints something this version does
 * not recognise must never take the providers read-out down with it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectAgentClis } from './agentClis.js';

const run = promisify(execFile);

/**
 * How long the status command gets. Short on purpose: this read sits in front
 * of the providers endpoint, which the Settings pane and the composer both
 * wait on. A claude that is wedged should cost a second and report "unknown",
 * not hold the pane open.
 */
const STATUS_TIMEOUT_MS = 4000;

/** What the CLI reports about its own sign-in. All optional but `installed`. */
export interface ClaudeAuth {
  /** The binary is on PATH. Without this nothing else can be known. */
  installed: boolean;
  /** It has an account. This is the one that decides whether Claude can answer. */
  loggedIn: boolean;
  /** The signed-in account, when it says. */
  email: string | null;
  /**
   * The plan word, verbatim from `subscriptionType`. Passed through rather
   * than mapped: it is Anthropic's vocabulary, it will grow, and a switch
   * statement here would silently render a new tier as "unknown".
   */
  planType: string | null;
}

export const SIGNED_OUT: ClaudeAuth = { installed: false, loggedIn: false, email: null, planType: null };

/**
 * Parse one status payload. Exported so the shapes are testable without
 * spawning anything, and deliberately tolerant: a field this version does not
 * recognise is dropped, and a payload that is not an object at all reads as
 * signed out rather than throwing.
 */
export function parseClaudeAuth(raw: string): ClaudeAuth {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...SIGNED_OUT, installed: true };
    }
    const record = parsed as Record<string, unknown>;
    const text = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    return {
      installed: true,
      // Strictly true. A missing field is not a sign-in, and reading it as one
      // would put the app back where it started: claiming Claude can answer on
      // no evidence.
      loggedIn: record.loggedIn === true,
      email: text(record.email),
      planType: text(record.subscriptionType),
    };
  } catch {
    // Not JSON. Some builds print a human sentence here, and an older one
    // prints nothing at all. Installed, sign-in unknown, which is reported as
    // signed out because that is the direction that fails safe.
    return { ...SIGNED_OUT, installed: true };
  }
}

/**
 * How long an answer is reused.
 *
 * There IS a cache here and it is not premature. `claude auth status` spawns a
 * Node CLI, which costs a few hundred milliseconds of process startup before
 * it prints anything, and this read sits inside `/api/chat/providers` — which
 * is hit on every project open, every provider refresh, and every announce to
 * an open window. Without this, opening a folder paid for a process spawn, and
 * so did every socket that asked afterwards.
 *
 * Short, because the answer changes when the person signs in, and that happens
 * in a terminal Hearth is not watching. Ten seconds means a sign-in shows up on
 * its own shortly after it finishes even if nobody thought to invalidate.
 */
const CACHE_MS = 10_000;

let cached: { at: number; value: Promise<ClaudeAuth> } | null = null;

/**
 * Drop the cached answer. Call this after anything that could have CHANGED the
 * sign-in, so the next read pays for a spawn rather than reporting a stale
 * "signed out" at someone who just finished signing in.
 */
export function forgetClaudeAuth(): void {
  cached = null;
}

/**
 * Ask the installed CLI. Resolves the binary through the same PATH walk the
 * rest of the app uses, so "Hearth can see claude" means one thing everywhere.
 *
 * Cached for CACHE_MS. The PROMISE is cached rather than the value, so several
 * callers arriving together share one spawn instead of racing to start their
 * own.
 */
export async function readClaudeAuth(): Promise<ClaudeAuth> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = spawnClaudeAuth();
  cached = { at: now, value };
  // A read that threw is not an answer worth keeping: clear the slot so the
  // next caller retries rather than inheriting a rejection for ten seconds.
  value.catch(() => {
    if (cached?.value === value) cached = null;
  });
  return value;
}

async function spawnClaudeAuth(): Promise<ClaudeAuth> {
  const clis = await detectAgentClis().catch(() => []);
  const claude = clis.find((entry) => entry.id === 'claude');
  if (!claude?.path) return SIGNED_OUT;
  try {
    const { stdout } = await run(claude.path, ['auth', 'status'], {
      timeout: STATUS_TIMEOUT_MS,
      // A status read has no business inheriting a huge buffer, and a runaway
      // one should be cut off rather than held in memory.
      maxBuffer: 1024 * 256,
    });
    return parseClaudeAuth(stdout);
  } catch {
    // Non-zero exit is how at least one build says "signed out", and a timeout
    // lands here too. Installed either way: we found the binary above.
    return { ...SIGNED_OUT, installed: true };
  }
}
