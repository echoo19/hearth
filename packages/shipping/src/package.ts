/**
 * `packageDesktop` — the Node-only entry point that turns an assembled web
 * build into native desktop apps, one per requested platform. Hosts (CLI, MCP
 * server, editor) wire this in as `CommandResources.packageDesktop`.
 *
 * Per platform: stage the web files + generated Electron `main.js` + app
 * `package.json` into a temp dir → run `@electron/packager` → sign (darwin
 * only, via the ladder in {@link signMacApp}) → zip. Windows/Linux targets are
 * never signed.
 */
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { packager, type OfficialPlatform, type SupportedArch } from '@electron/packager';
import type { DesktopBuildSpec, DesktopBuildResult, DesktopPlatform } from '@hearth/core';
import { renderElectronMain, packageJsonForApp } from './shell.js';
import { zipDirectory } from './zip.js';
import { resolveIcons } from './icon.js';
import { signMacApp, createDefaultExec, makeScratchDir, type ExecFn } from './sign.js';

/**
 * Electron version the packaged apps ship with. Must match apps/editor's
 * pinned (non-caret) `electron` devDependency version exactly.
 */
const ELECTRON_VERSION = '33.4.11';

export type PackageStage = 'stage' | 'download' | 'package' | 'sign' | 'notarize' | 'zip';

export interface ProgressEvent {
  platform: DesktopPlatform | null;
  stage: PackageStage;
  message: string;
}

export interface PackageDesktopOptions {
  spec: DesktopBuildSpec;
  onProgress?: (e: ProgressEvent) => void;
  /** Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>;
  /** Injectable codesign/notarytool runner for tests. */
  exec?: ExecFn;
}

/** Split a platform id (`darwin-arm64`) into Electron's `platform`/`arch` on the last hyphen. */
export function splitPlatform(id: DesktopPlatform): { platform: string; arch: string } {
  const i = id.lastIndexOf('-');
  return { platform: id.slice(0, i), arch: id.slice(i + 1) };
}

/** Write a staged web file (string or bytes) to disk, creating parent dirs. */
async function writeStaged(stageDir: string, rel: string, content: string | Uint8Array): Promise<void> {
  const abs = path.join(stageDir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, typeof content === 'string' ? content : Buffer.from(content));
}

/** Locate the `.app` bundle inside a packaged darwin output directory. */
async function findDotApp(packagedDir: string): Promise<string> {
  for (const entry of await fsp.readdir(packagedDir)) {
    if (entry.endsWith('.app')) return path.join(packagedDir, entry);
  }
  return packagedDir; // shouldn't happen, but degrade gracefully
}

export async function packageDesktop(opts: PackageDesktopOptions): Promise<DesktopBuildResult[]> {
  const { spec } = opts;
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? createDefaultExec();
  const emit = (platform: DesktopPlatform | null, stage: PackageStage, message: string) =>
    opts.onProgress?.({ platform, stage, message });

  // Result paths are project-relative, rooted at spec.projectRoot (the
  // exportDesktop caller's project root), independent of outDir depth.
  const rel = (abs: string) => path.relative(spec.projectRoot, abs).split(path.sep).join('/');

  const results: DesktopBuildResult[] = [];

  for (const platform of spec.platforms) {
    try {
      const { platform: osName, arch } = splitPlatform(platform);

      // 1. Stage web files + Electron shell into a temp app source dir.
      emit(platform, 'stage', `staging ${platform} app`);
      const stageDir = await makeScratchDir(`hearth-stage-${platform}-`);
      for (const f of spec.files) await writeStaged(stageDir, f.path, f.content);
      await writeStaged(stageDir, 'main.js', renderElectronMain({ width: spec.width, height: spec.height, title: spec.title }));
      await writeStaged(stageDir, 'package.json', packageJsonForApp({ name: spec.title }));

      // 2. Resolve the platform icon (falls back to bundled defaults on failure).
      const iconWork = await makeScratchDir(`hearth-icon-${platform}-`);
      const icons = await resolveIcons({
        iconPng: spec.iconPng,
        workDir: iconWork,
        onProgress: (m) => emit(platform, 'package', m),
      });
      const icon = osName === 'darwin' ? icons.icns : osName === 'win32' ? icons.ico : icons.png;

      // 3. Package with Electron (downloads the runtime on first use per version).
      emit(platform, 'download', `ensuring Electron ${ELECTRON_VERSION} for ${platform}`);
      emit(platform, 'package', `packaging ${platform}`);
      const outParent = path.join(spec.outDirAbs, platform);
      const packaged = await packager({
        dir: stageDir,
        out: outParent,
        platform: osName as OfficialPlatform,
        arch: arch as SupportedArch,
        icon,
        appVersion: '1.0.0',
        name: spec.title,
        // A project-derived bundle identifier — otherwise @electron/packager
        // falls back to `com.electron.<name>`, which reads as an unconfigured
        // template and collides across Hearth-exported games under near-
        // identical generic ids (a footgun for per-bundle-id OS state:
        // notification permissions, TCC prompts, etc.).
        appBundleId: `com.hearth.${spec.slug}`,
        electronVersion: ELECTRON_VERSION,
        overwrite: true,
        prune: true,
        quiet: true,
      });
      const packagedDir = packaged[0];
      const appDir = osName === 'darwin' ? await findDotApp(packagedDir) : packagedDir;

      // 4. Sign (darwin only).
      let signed: DesktopBuildResult['signed'] = 'none';
      let notarized = false;
      if (osName === 'darwin') {
        emit(platform, 'sign', `signing ${platform}`);
        const signWork = await makeScratchDir(`hearth-sign-${platform}-`);
        const r = await signMacApp({
          appDir,
          env,
          exec,
          workDir: signWork,
          onProgress: (stage, message) => emit(platform, stage, message),
        });
        signed = r.signed;
        notarized = r.notarized;
      }

      // 5. Zip the packaged output.
      emit(platform, 'zip', `zipping ${platform}`);
      const zipAbs = path.join(spec.outDirAbs, `${spec.slug}-${platform}.zip`);
      await zipDirectory(packagedDir, zipAbs);

      results.push({ platform, appDir: rel(appDir), zip: rel(zipAbs), signed, notarized });
    } catch (err) {
      // A failure partway through one platform's build (most commonly a hard
      // signing failure — HEARTH_MAC_IDENTITY set, codesign rejects it) must
      // not surface as an anonymous error: hosts (the editor's export-error
      // frame in particular) need to know which platform failed so they can
      // attribute it in the UI instead of blaming the whole multi-platform
      // run. Throw-on-first-failure semantics are unchanged — this only
      // tags the error before it propagates.
      throw new DesktopPackageError(platform, err);
    }
  }

  return results;
}

/**
 * Wraps an error thrown while packaging a single platform, tagging it with
 * the platform id so hosts (editor export-error frames, CLI output) can
 * attribute the failure instead of treating it as a whole-run failure with
 * no origin. `message` stays informative on its own (includes the platform
 * id) so callers that only read `.message` are not degraded.
 */
export class DesktopPackageError extends Error {
  readonly platform: DesktopPlatform;

  constructor(platform: DesktopPlatform, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`packaging ${platform} failed: ${causeMessage}`, { cause });
    this.name = 'DesktopPackageError';
    this.platform = platform;
  }
}
