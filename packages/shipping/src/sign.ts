/**
 * The macOS signing ladder for `hearth ship`. Three rungs, chosen purely from
 * environment variables so hosts (CLI/MCP/editor) never need to branch:
 *
 *   1. No `HEARTH_MAC_IDENTITY` → ad-hoc `codesign -s -`. If that fails we warn
 *      and ship the app unsigned (`signed: 'none'`); a missing/broken local
 *      codesign must never abort an export.
 *   2. `HEARTH_MAC_IDENTITY` set → sign with that identity. Failure is a hard
 *      error — the user explicitly asked for a real signature.
 *   3. Identity + `HEARTH_APPLE_ID` + `HEARTH_APPLE_PASSWORD` + `HEARTH_TEAM_ID`
 *      → also notarize (`xcrun notarytool submit --wait` on a zip of the .app)
 *      and staple. Any failure here is a hard error.
 *
 * All shelling-out goes through an injected {@link ExecFn} so tests never touch
 * the real `codesign`/`xcrun`.
 */
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { zipDirectory } from './zip.js';

/** Runs a command with args and resolves its stdout/stderr, rejecting on non-zero exit. */
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** Default {@link ExecFn} backed by `child_process.execFile` (no shell). */
export function createDefaultExec(): ExecFn {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
}

export type SigningMode = 'adhoc' | 'identity' | 'identity+notarize';

/**
 * Read-only view of the signing rung the current environment selects, for hosts
 * to display before running. Mirrors the ladder in {@link signMacApp} exactly.
 */
export function describeSigningCapability(env: NodeJS.ProcessEnv = process.env): {
  mode: SigningMode;
  identity?: string;
} {
  const identity = env.HEARTH_MAC_IDENTITY;
  if (!identity) return { mode: 'adhoc' };
  if (env.HEARTH_APPLE_ID && env.HEARTH_APPLE_PASSWORD && env.HEARTH_TEAM_ID) {
    return { mode: 'identity+notarize', identity };
  }
  return { mode: 'identity', identity };
}

export interface SignMacOptions {
  /** Absolute path to the `.app` bundle to sign. */
  appDir: string;
  env: NodeJS.ProcessEnv;
  exec: ExecFn;
  /** Scratch directory for the notarization zip. */
  workDir: string;
  onProgress?: (stage: 'sign' | 'notarize', message: string) => void;
}

export interface SignMacResult {
  signed: 'adhoc' | 'identity' | 'none';
  notarized: boolean;
}

/**
 * Sign (and optionally notarize) a macOS `.app` per the ladder above. Callers
 * invoke this only for darwin targets; non-darwin platforms are unsigned by the
 * packager and never reach here.
 */
export async function signMacApp(opts: SignMacOptions): Promise<SignMacResult> {
  const { appDir, env, exec, workDir, onProgress } = opts;
  const identity = env.HEARTH_MAC_IDENTITY;

  // Rung 1: ad-hoc. Best-effort — never fatal.
  if (!identity) {
    try {
      await exec('codesign', ['--force', '--deep', '-s', '-', appDir]);
      return { signed: 'adhoc', notarized: false };
    } catch (err) {
      onProgress?.('sign', `ad-hoc codesign failed, shipping unsigned: ${(err as Error).message}`);
      return { signed: 'none', notarized: false };
    }
  }

  // Rung 2: real identity. Failure is fatal.
  onProgress?.('sign', `signing with identity ${identity}`);
  await exec('codesign', ['--force', '--deep', '-s', identity, appDir]);

  // Rung 3: notarize when the full Apple triple is present. Failure is fatal.
  if (env.HEARTH_APPLE_ID && env.HEARTH_APPLE_PASSWORD && env.HEARTH_TEAM_ID) {
    onProgress?.('notarize', 'submitting to notarytool (this can take several minutes)');
    // Notarytool wants a zip; zip the .app's parent so the `.app` wrapper is kept.
    const notaryZip = path.join(workDir, `notarize-${path.basename(appDir)}.zip`);
    await fsp.mkdir(workDir, { recursive: true });
    await zipDirectory(path.dirname(appDir), notaryZip);
    await exec('xcrun', [
      'notarytool',
      'submit',
      notaryZip,
      '--apple-id',
      env.HEARTH_APPLE_ID,
      '--password',
      env.HEARTH_APPLE_PASSWORD,
      '--team-id',
      env.HEARTH_TEAM_ID,
      '--wait',
    ]);
    onProgress?.('notarize', 'stapling notarization ticket');
    await exec('xcrun', ['stapler', 'staple', appDir]);
    return { signed: 'identity', notarized: true };
  }

  return { signed: 'identity', notarized: false };
}

/** Small helper so callers can allocate an isolated scratch dir. */
export async function makeScratchDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}
