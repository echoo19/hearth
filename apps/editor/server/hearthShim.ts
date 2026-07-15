/**
 * A tiny `hearth` shim so every embedded-terminal session — a bare shell, or
 * any agent CLI (claude/codex/opencode/hermes) spawned in it — finds a working
 * `hearth` on PATH with zero manual setup.
 *
 * The Hearth CLI ships as a single-file bundle (`hearth-cli.mjs` next to the
 * packaged app, or `packages/cli/dist/main.js` from a repo checkout — see
 * projectServer's resolveToolPaths), runnable with any Node ≥ 20 but NOT
 * installed as a `hearth` binary on the user's PATH. Rather than ask users to
 * `npm i -g` or hand-alias it, we write a one-line launcher into a temp dir and
 * prepend that dir to the pty's PATH. Works identically in dev and in the
 * packaged desktop app (the only difference is which CLI file the shim execs).
 *
 * The shim is `node <cliPath> "$@"` — it relies on `node` itself being on PATH,
 * which it always is for anyone who installed Hearth's tooling in the first
 * place (and the manual-setup fallback in the Agent panel assumes the same).
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Per-cliPath cache: creating the shim is a couple of tiny disk writes, and
 * cliPath is stable for a server process's lifetime, so we only ever do it
 * once per distinct CLI location (dev vs. packaged, or two repo checkouts).
 */
const shimDirs = new Map<string, Promise<string>>();

/** The line the shim executes. Exported so a test can assert its exact shape
 * without spawning a shell. `"$@"` / `%*` forward every argument through. */
export function shimScript(cliPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `@node "${cliPath}" %*\r\n`;
  return `#!/bin/sh\nexec node "${cliPath}" "$@"\n`;
}

/**
 * Ensures a `hearth` launcher for `cliPath` exists in a dedicated temp dir and
 * returns that dir (to be prepended to a pty's PATH). Idempotent and cached;
 * the dir name is keyed by a hash of `cliPath` so two checkouts on one machine
 * never overwrite each other's shim.
 */
export function ensureHearthShim(cliPath: string): Promise<string> {
  let existing = shimDirs.get(cliPath);
  if (!existing) {
    existing = createShim(cliPath);
    shimDirs.set(cliPath, existing);
  }
  return existing;
}

async function createShim(cliPath: string): Promise<string> {
  const key = crypto.createHash('sha1').update(cliPath).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), `hearth-cli-shim-${key}`);
  await fsp.mkdir(dir, { recursive: true });
  if (process.platform === 'win32') {
    await fsp.writeFile(path.join(dir, 'hearth.cmd'), shimScript(cliPath), 'utf8');
  } else {
    const shimPath = path.join(dir, 'hearth');
    await fsp.writeFile(shimPath, shimScript(cliPath), 'utf8');
    await fsp.chmod(shimPath, 0o755);
  }
  return dir;
}

/**
 * Returns `baseEnv` with `shimDir` prepended to PATH (so the shim's `hearth`
 * wins over anything else). Pure — never mutates `baseEnv`.
 */
export function hearthPtyEnv(baseEnv: NodeJS.ProcessEnv, shimDir: string): NodeJS.ProcessEnv {
  const existing = baseEnv.PATH ?? baseEnv.Path ?? '';
  const nextPath = existing ? `${shimDir}${path.delimiter}${existing}` : shimDir;
  return { ...baseEnv, PATH: nextPath };
}
