/**
 * Tests for the `hearth` CLI PATH shim: it must write an executable launcher
 * for the packaged/standalone CLI and prepend its dir to PATH, so every
 * embedded-terminal session finds a working `hearth` with zero manual setup.
 *
 * The end-to-end "does `hearth` actually run in a real pty" check lives in the
 * packaged smoke test (electron/main.ts smokeTestHearthShim) — here we prove
 * the shim's shape and the env math without spawning anything.
 */
import { describe, it, expect } from 'vitest';
import { promises as fsp, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureHearthShim, hearthPtyEnv, shimScript } from '../server/hearthShim';

describe('shimScript', () => {
  it('execs `node <cliPath>` forwarding all args on POSIX', () => {
    const script = shimScript('/tools/hearth-cli.mjs', 'linux');
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('exec node "/tools/hearth-cli.mjs" "$@"');
  });

  it('uses a .cmd-style launcher on win32', () => {
    const script = shimScript('C:\\tools\\hearth-cli.mjs', 'win32');
    expect(script).toContain('@node "C:\\tools\\hearth-cli.mjs" %*');
  });
});

describe('ensureHearthShim', () => {
  it('writes an executable `hearth` launcher and returns its dir', async () => {
    const cliPath = path.join(os.tmpdir(), `fake-cli-${Date.now()}.mjs`);
    const dir = await ensureHearthShim(cliPath);
    const shimPath = path.join(dir, process.platform === 'win32' ? 'hearth.cmd' : 'hearth');
    const contents = await fsp.readFile(shimPath, 'utf8');
    expect(contents).toContain(cliPath);
    if (process.platform !== 'win32') {
      // Executable bit is what makes it runnable off PATH.
      await expect(fsp.access(shimPath, fsConstants.X_OK)).resolves.toBeUndefined();
    }
  });

  it('is cached: same cliPath returns the same dir', async () => {
    const cliPath = path.join(os.tmpdir(), `fake-cli-cache-${Date.now()}.mjs`);
    const a = await ensureHearthShim(cliPath);
    const b = await ensureHearthShim(cliPath);
    expect(a).toBe(b);
  });

  it('gives different cliPaths different dirs (no cross-checkout collision)', async () => {
    const a = await ensureHearthShim(path.join(os.tmpdir(), `cli-a-${Date.now()}.mjs`));
    const b = await ensureHearthShim(path.join(os.tmpdir(), `cli-b-${Date.now()}.mjs`));
    expect(a).not.toBe(b);
  });
});

describe('hearthPtyEnv', () => {
  it('prepends the shim dir to PATH without mutating the base env', () => {
    const base = { PATH: '/usr/bin:/bin', FOO: 'bar' } as NodeJS.ProcessEnv;
    const next = hearthPtyEnv(base, '/shim');
    expect(next.PATH).toBe(`/shim${path.delimiter}/usr/bin:/bin`);
    expect(next.FOO).toBe('bar');
    expect(base.PATH).toBe('/usr/bin:/bin'); // untouched
  });

  it('handles an empty/absent PATH', () => {
    expect(hearthPtyEnv({} as NodeJS.ProcessEnv, '/shim').PATH).toBe('/shim');
  });

  it('collapses a Windows-style `Path` key so no stale duplicate shadows the shim', () => {
    // Windows exposes PATH as `Path`. Spreading it and adding `PATH` would leave
    // BOTH keys, and the pty child could read the stale `Path` (without the shim
    // dir) — so `hearth` would not resolve. There must be exactly one path key.
    const base = { Path: 'C:\\Windows;C:\\nodejs' } as NodeJS.ProcessEnv;
    const next = hearthPtyEnv(base, 'C:\\shim');
    const pathKeys = Object.keys(next).filter((k) => k.toLowerCase() === 'path');
    expect(pathKeys).toHaveLength(1);
    expect(next[pathKeys[0]]).toBe(`C:\\shim${path.delimiter}C:\\Windows;C:\\nodejs`);
  });
});
