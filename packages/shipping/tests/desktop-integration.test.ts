/**
 * Real-packager integration test. Runs @electron/packager for THE HOST
 * PLATFORM ONLY and asserts the produced app-dir structure and zip exist.
 * It never launches Electron (headless launch is flaky in CI; that lives in
 * the release workflow's smoke step, out of scope here).
 *
 * Gated behind HEARTH_DESKTOP_INTEGRATION=1 (the main CI workflow sets it).
 * First local run downloads Electron (~100MB) into the @electron/get cache,
 * which is expected and can take a while — hence the generous timeout.
 *
 *   HEARTH_DESKTOP_INTEGRATION=1 npx vitest run packages/shipping/tests/desktop-integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { packageDesktop } from '../src/package.js';
import type { DesktopPlatform } from '@hearth/core';

const ENABLED = process.env.HEARTH_DESKTOP_INTEGRATION === '1';

const OS_NAMES: Record<string, string | undefined> = { darwin: 'darwin', win32: 'win32', linux: 'linux' };
const SUPPORTED: DesktopPlatform[] = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];

function hostPlatform(): DesktopPlatform | null {
  const osName = OS_NAMES[process.platform];
  if (!osName) return null;
  const id = `${osName}-${process.arch}` as DesktopPlatform;
  return SUPPORTED.includes(id) ? id : null;
}

const host = hostPlatform();
const suite = ENABLED && host ? describe : describe.skip;

suite('packageDesktop (real packager, host platform only)', () => {
  it(
    `packages ${host} into an app dir + zip`,
    // Retry: the first attempt may race @electron/get's ~100MB binary download;
    // a retry runs against the now-warm cache. Generous timeout for the cold
    // download.
    { timeout: 600_000, retry: 2 },
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-desktop-int-'));
      const spec = {
        files: [
          { path: 'index.html', content: '<!doctype html><title>Hearth Smoke</title><h1>ok</h1>' },
          { path: 'assets/data.json', content: '{"ok":true}' },
        ],
        slug: 'smoke',
        title: 'Hearth Smoke',
        width: 640,
        height: 480,
        outDirAbs: path.join(root, 'export', 'desktop'),
        projectRoot: root,
        platforms: [host!],
      };

      const stages: string[] = [];
      const res = await packageDesktop({ spec, onProgress: (e) => stages.push(e.stage) });

      expect(res).toHaveLength(1);
      expect(res[0].platform).toBe(host);
      expect(stages).toContain('package');
      expect(stages).toContain('zip');

      // Result paths are project-relative (rooted at spec.projectRoot).
      const appAbs = path.join(spec.projectRoot, res[0].appDir);
      const zipAbs = path.join(spec.projectRoot, res[0].zip);

      expect((await fsp.stat(appAbs)).isDirectory()).toBe(true);
      expect((await fsp.stat(zipAbs)).size).toBeGreaterThan(0);
      expect(res[0].zip).toBe(`export/desktop/smoke-${host}.zip`);

      // D-1 regression: the zip the real user downloads must yield a
      // launchable app — every executable inside a fresh unzip needs its +x
      // bit. On unix hosts, unzip the produced artifact with the SYSTEM unzip
      // and assert the packaged executables are still executable.
      if (host === 'darwin-arm64' || host === 'darwin-x64') {
        const freshDir = path.join(root, 'fresh-unzip');
        await fsp.mkdir(freshDir, { recursive: true });
        execFileSync('unzip', ['-q', '-o', zipAbs, '-d', freshDir]);

        const appName = path.basename(appAbs);
        const macOsDir = path.join(freshDir, appName, 'Contents', 'MacOS');
        const bins = await fsp.readdir(macOsDir);
        expect(bins.length).toBeGreaterThan(0);
        // The main binary (Contents/MacOS/*) must be executable post-unzip.
        for (const bin of bins) {
          const m = (await fsp.stat(path.join(macOsDir, bin))).mode;
          expect(m & 0o111).not.toBe(0);
        }
        // At least one Helper app's binary must be executable too.
        const helpersDir = path.join(freshDir, appName, 'Contents', 'Frameworks');
        const frameworks = await fsp.readdir(helpersDir);
        const helperApp = frameworks.find((f) => f.endsWith('Helper.app'));
        expect(helperApp).toBeDefined();
        const helperMacOs = path.join(helpersDir, helperApp!, 'Contents', 'MacOS');
        const helperBins = await fsp.readdir(helperMacOs);
        expect(helperBins.length).toBeGreaterThan(0);
        const helperMode = (await fsp.stat(path.join(helperMacOs, helperBins[0]))).mode;
        expect(helperMode & 0o111).not.toBe(0);
      } else if (host === 'linux-x64') {
        const freshDir = path.join(root, 'fresh-unzip');
        await fsp.mkdir(freshDir, { recursive: true });
        execFileSync('unzip', ['-q', '-o', zipAbs, '-d', freshDir]);
        // zipDirectory flattens the packaged app dir's CONTENTS to the zip
        // root (same as web export's "index.html at root"), so the Electron
        // launcher binary lands directly in freshDir — not under a
        // <productName>-linux-x64 wrapper. At least one top-level file must be
        // executable, or the game can't run.
        const appRoot = freshDir;
        const top = await fsp.readdir(appRoot, { withFileTypes: true });
        let anyExec = false;
        for (const e of top) {
          if (!e.isFile()) continue;
          if (((await fsp.stat(path.join(appRoot, e.name))).mode & 0o111) !== 0) anyExec = true;
        }
        expect(anyExec).toBe(true);
      }
    },
  );
});
