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
    },
    600_000,
  );
});
