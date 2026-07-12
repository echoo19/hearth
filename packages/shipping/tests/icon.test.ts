import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveIcons, defaultIconPaths } from '../src/icon.js';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

async function workDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-icon-'));
}

async function realIconPng(): Promise<Uint8Array> {
  return fsp.readFile(path.join(ASSETS, 'hearth-icon.png'));
}

describe('defaultIconPaths', () => {
  it('points at the bundled hearth icons', () => {
    const d = defaultIconPaths();
    expect(d.icns).toBe(path.join(ASSETS, 'hearth.icns'));
    expect(d.ico).toBe(path.join(ASSETS, 'hearth.ico'));
    expect(d.png).toBe(path.join(ASSETS, 'hearth-icon.png'));
  });
});

describe('resolveIcons', () => {
  it('returns bundled defaults when no iconPng is provided', async () => {
    const r = await resolveIcons({ workDir: await workDir() });
    expect(r).toEqual(defaultIconPaths());
  });

  it('converts a valid iconPng into workDir .icns/.ico and a .png', async () => {
    const wd = await workDir();
    const onProgress = vi.fn();
    const r = await resolveIcons({ iconPng: await realIconPng(), workDir: wd, onProgress });
    // All three live under the work dir (not the bundled defaults).
    expect(r.icns.startsWith(wd)).toBe(true);
    expect(r.ico.startsWith(wd)).toBe(true);
    expect(r.png.startsWith(wd)).toBe(true);
    // Files exist and are non-empty.
    for (const p of [r.icns, r.ico, r.png]) {
      const stat = await fsp.stat(p);
      expect(stat.size).toBeGreaterThan(0);
    }
    // .icns starts with the 'icns' magic.
    const icns = await fsp.readFile(r.icns);
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('warns and falls back to defaults when conversion fails on garbage input', async () => {
    const onProgress = vi.fn();
    const r = await resolveIcons({ iconPng: new Uint8Array([1, 2, 3, 4]), workDir: await workDir(), onProgress });
    expect(r).toEqual(defaultIconPaths());
    expect(onProgress).toHaveBeenCalled();
  });
});
