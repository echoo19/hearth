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

/** The script the shim executes. Exported so a test can assert its exact shape
 * without spawning a shell. `"$@"` / `%*` forward every argument through.
 *
 * `nodeBin` is the Node binary to run the CLI with. In the packaged desktop app
 * this is the Electron executable (`process.execPath`) launched with
 * `ELECTRON_RUN_AS_NODE=1`, so `hearth` runs on Hearth's OWN bundled Node — the
 * user never needs a system `node` installed. In dev it's just the `node` that
 * runs the server. `ELECTRON_RUN_AS_NODE` is harmless for a plain-node binary,
 * so the same script works for both. The paths are quoted so a Program Files
 * install (spaces) still runs. */
export function shimScript(
  cliPath: string,
  nodeBin: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${nodeBin}" "${cliPath}" %*\r\n`;
  }
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${nodeBin}" "${cliPath}" "$@"\n`;
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
  // Hearth's own Node: the Electron binary in the packaged app (run as Node via
  // ELECTRON_RUN_AS_NODE inside shimScript), or the dev server's node.
  const nodeBin = process.execPath;
  if (process.platform === 'win32') {
    await fsp.writeFile(path.join(dir, 'hearth.cmd'), shimScript(cliPath, nodeBin), 'utf8');
  } else {
    const shimPath = path.join(dir, 'hearth');
    await fsp.writeFile(shimPath, shimScript(cliPath, nodeBin), 'utf8');
    await fsp.chmod(shimPath, 0o755);
  }
  return dir;
}

/**
 * Returns `baseEnv` with `shimDir` prepended to PATH (so the shim's `hearth`
 * wins over anything else). Pure — never mutates `baseEnv`.
 *
 * Windows exposes PATH as `Path`. Naively spreading `baseEnv` and adding `PATH`
 * would leave BOTH `Path` (stale, without the shim dir) and `PATH` in the env
 * object; the pty child could then read the stale one and never find `hearth`.
 * So we collapse every case-variant of the key into a single `PATH` (Windows
 * looks it up case-insensitively, so one canonical key resolves everywhere).
 */
export function hearthPtyEnv(baseEnv: NodeJS.ProcessEnv, shimDir: string): NodeJS.ProcessEnv {
  const next = { ...baseEnv };
  const pathKeys = Object.keys(next).filter((k) => k.toLowerCase() === 'path');
  const existing = pathKeys.map((k) => next[k]).find((v) => v != null && v !== '') ?? '';
  for (const k of pathKeys) delete next[k];
  next.PATH = existing ? `${shimDir}${path.delimiter}${existing}` : shimDir;
  return next;
}
