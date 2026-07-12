import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { DesktopBuildSpec, DesktopPlatform } from '@hearth/core';
import { packageDesktop, splitPlatform } from '../src/package.js';
import type { ExecFn } from '../src/sign.js';

// The real packager downloads Electron; unit tests replace it with a stub that
// synthesizes the output directory the rest of the flow (sign, zip) operates on.
// The spy is created via vi.hoisted so the test never imports the mocked module
// directly (importing it triggers a spurious extra invocation under vite).
const { mockPackager } = vi.hoisted(() => ({ mockPackager: vi.fn() }));
vi.mock('@electron/packager', () => ({ packager: mockPackager }));

mockPackager.mockImplementation(async (opts: any) => {
  const fs = await import('node:fs/promises');
  const p = await import('node:path');
  const dir = p.join(opts.out, `${opts.name}-${opts.platform}-${opts.arch}`);
  await fs.mkdir(dir, { recursive: true });
  if (opts.platform === 'darwin') {
    const contents = p.join(dir, `${opts.name}.app`, 'Contents');
    await fs.mkdir(contents, { recursive: true });
    await fs.writeFile(p.join(contents, 'Info.plist'), '<plist/>');
  } else {
    await fs.writeFile(p.join(dir, opts.platform === 'win32' ? `${opts.name}.exe` : opts.name), 'bin');
  }
  return [dir];
});

/** exec that resolves everything unless `failCodesign`. */
function fakeExec(failCodesign = false): ExecFn {
  return async (cmd) => {
    if (failCodesign && cmd === 'codesign') throw new Error('codesign failed');
    return { stdout: '', stderr: '' };
  };
}

async function makeSpec(platforms: DesktopPlatform[], iconPng?: Uint8Array): Promise<DesktopBuildSpec> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-pkg-'));
  return {
    files: [{ path: 'index.html', content: '<!doctype html><title>x</title>' }],
    slug: 'game',
    title: 'Game',
    width: 800,
    height: 600,
    outDirAbs: path.join(root, 'export', 'desktop'),
    projectRoot: root,
    platforms,
    ...(iconPng ? { iconPng } : {}),
  };
}

beforeEach(() => {
  mockPackager.mockClear();
});

describe('splitPlatform', () => {
  it('splits platform ids into os + arch on the last hyphen', () => {
    expect(splitPlatform('darwin-arm64')).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(splitPlatform('darwin-x64')).toEqual({ platform: 'darwin', arch: 'x64' });
    expect(splitPlatform('win32-x64')).toEqual({ platform: 'win32', arch: 'x64' });
    expect(splitPlatform('linux-x64')).toEqual({ platform: 'linux', arch: 'x64' });
  });
});

describe('packageDesktop', () => {
  it('packages a darwin target: adhoc-signs, uses .icns, zips, returns relative paths', async () => {
    const spec = await makeSpec(['darwin-arm64']);
    const res = await packageDesktop({ spec, env: {}, exec: fakeExec() });
    expect(res).toHaveLength(1);
    expect(res[0].platform).toBe('darwin-arm64');
    expect(res[0].signed).toBe('adhoc');
    expect(res[0].notarized).toBe(false);
    // project-relative shape rooted at the project (grandparent of outDirAbs).
    expect(res[0].appDir.startsWith('export/desktop/')).toBe(true);
    expect(res[0].appDir.endsWith('.app')).toBe(true);
    expect(res[0].zip).toBe('export/desktop/game-darwin-arm64.zip');
    // packager got the split platform/arch and an .icns icon.
    const opts = mockPackager.mock.calls[0][0] as any;
    expect(opts.platform).toBe('darwin');
    expect(opts.arch).toBe('arm64');
    expect(opts.icon.endsWith('.icns')).toBe(true);
    expect(opts.overwrite).toBe(true);
    expect(opts.name).toBe('Game');
    // zip exists on disk.
    const zipAbs = path.join(spec.outDirAbs, 'game-darwin-arm64.zip');
    expect((await fsp.stat(zipAbs)).size).toBeGreaterThan(0);
  });

  it('does not sign non-darwin targets and selects the right icon extension', async () => {
    const win = await packageDesktop({ spec: await makeSpec(['win32-x64']), env: {}, exec: fakeExec() });
    expect(win[0].signed).toBe('none');
    expect(win[0].notarized).toBe(false);
    expect((mockPackager.mock.calls[0][0] as any).icon.endsWith('.ico')).toBe(true);

    mockPackager.mockClear();
    const lin = await packageDesktop({ spec: await makeSpec(['linux-x64']), env: {}, exec: fakeExec() });
    expect(lin[0].signed).toBe('none');
    expect((mockPackager.mock.calls[0][0] as any).icon.endsWith('.png')).toBe(true);
  });

  it('returns one result per platform, in order', async () => {
    const spec = await makeSpec(['darwin-arm64', 'win32-x64', 'linux-x64']);
    const res = await packageDesktop({ spec, env: {}, exec: fakeExec() });
    expect(res.map((r) => r.platform)).toEqual(['darwin-arm64', 'win32-x64', 'linux-x64']);
    expect(res.map((r) => r.zip)).toEqual([
      'export/desktop/game-darwin-arm64.zip',
      'export/desktop/game-win32-x64.zip',
      'export/desktop/game-linux-x64.zip',
    ]);
  });

  it('computes project-relative paths from projectRoot regardless of outDir depth', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-pkg-'));
    const base = {
      files: [{ path: 'index.html', content: '<!doctype html><title>x</title>' }],
      slug: 'game',
      title: 'Game',
      width: 800,
      height: 600,
      projectRoot: root,
    };

    // Single-segment outDir ('dist'): the old grandparent-of-outDirAbs
    // heuristic would climb past the project root and leak its folder name
    // into the result path.
    const oneSeg: DesktopBuildSpec = { ...base, outDirAbs: path.join(root, 'dist'), platforms: ['darwin-arm64'] };
    const resOne = await packageDesktop({ spec: oneSeg, env: {}, exec: fakeExec() });
    expect(resOne[0].appDir.startsWith('dist/')).toBe(true);
    expect(resOne[0].zip).toBe('dist/game-darwin-arm64.zip');

    // Three-segment outDir ('a/b/c'): the old heuristic would drop the
    // leading 'a' segment.
    mockPackager.mockClear();
    const threeSeg: DesktopBuildSpec = {
      ...base,
      outDirAbs: path.join(root, 'a', 'b', 'c'),
      platforms: ['win32-x64'],
    };
    const resThree = await packageDesktop({ spec: threeSeg, env: {}, exec: fakeExec() });
    expect(resThree[0].zip).toBe('a/b/c/game-win32-x64.zip');
  });

  it('adhoc codesign failure degrades to signed:none without throwing', async () => {
    const onProgress = vi.fn();
    const res = await packageDesktop({ spec: await makeSpec(['darwin-arm64']), env: {}, exec: fakeExec(true), onProgress });
    expect(res[0].signed).toBe('none');
    expect(onProgress).toHaveBeenCalled();
  });

  it('signs with the configured identity when HEARTH_MAC_IDENTITY is set', async () => {
    const res = await packageDesktop({
      spec: await makeSpec(['darwin-arm64']),
      env: { HEARTH_MAC_IDENTITY: 'Developer ID Application: X' },
      exec: fakeExec(),
    });
    expect(res[0].signed).toBe('identity');
  });

  it('falls back to the default icon and warns when icon conversion fails', async () => {
    const onProgress = vi.fn();
    const res = await packageDesktop({
      spec: await makeSpec(['darwin-arm64'], new Uint8Array([1, 2, 3])),
      env: {},
      exec: fakeExec(),
      onProgress,
    });
    expect(res[0].signed).toBe('adhoc'); // still succeeds
    const opts = mockPackager.mock.calls[0][0] as any;
    expect(opts.icon.endsWith('hearth.icns')).toBe(true); // bundled default
    expect(onProgress).toHaveBeenCalled();
  });
});
