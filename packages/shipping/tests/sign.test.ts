import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { signMacApp, describeSigningCapability, type ExecFn } from '../src/sign.js';

/** Create a throwaway `.app` directory tree with one file so zipping works. */
async function makeAppDir(): Promise<{ appDir: string; workDir: string }> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-sign-'));
  const appDir = path.join(base, 'Game.app');
  await fsp.mkdir(path.join(appDir, 'Contents'), { recursive: true });
  await fsp.writeFile(path.join(appDir, 'Contents', 'Info.plist'), '<plist/>');
  const workDir = path.join(base, 'work');
  await fsp.mkdir(workDir, { recursive: true });
  return { appDir, workDir };
}

/** A recording exec that resolves for every call unless `failOn` matches. */
function recordingExec(failOn?: (cmd: string, args: string[]) => boolean): {
  exec: ExecFn;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (failOn?.(cmd, args)) throw new Error(`boom: ${cmd} ${args.join(' ')}`);
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const NOTARY_ENV = {
  HEARTH_MAC_IDENTITY: 'Developer ID Application: Hearth (TEAMID)',
  HEARTH_APPLE_ID: 'dev@hearth.dev',
  HEARTH_APPLE_PASSWORD: 'app-specific-pw',
  HEARTH_TEAM_ID: 'TEAMID',
};

describe('describeSigningCapability', () => {
  it('reports adhoc when no identity is set', () => {
    expect(describeSigningCapability({})).toEqual({ mode: 'adhoc' });
  });

  it('reports identity when only the identity is set', () => {
    expect(describeSigningCapability({ HEARTH_MAC_IDENTITY: 'ID' })).toEqual({ mode: 'identity', identity: 'ID' });
  });

  it('reports identity+notarize when the full notary triple is present', () => {
    expect(describeSigningCapability(NOTARY_ENV)).toEqual({
      mode: 'identity+notarize',
      identity: NOTARY_ENV.HEARTH_MAC_IDENTITY,
    });
  });

  it('falls back to identity when the notary triple is incomplete', () => {
    expect(describeSigningCapability({ HEARTH_MAC_IDENTITY: 'ID', HEARTH_APPLE_ID: 'x' })).toEqual({
      mode: 'identity',
      identity: 'ID',
    });
  });
});

describe('signMacApp — signing decision table', () => {
  it('row 1: no env → ad-hoc codesign success → signed:adhoc', async () => {
    const { appDir, workDir } = await makeAppDir();
    const { exec, calls } = recordingExec();
    const r = await signMacApp({ appDir, env: {}, exec, workDir });
    expect(r).toEqual({ signed: 'adhoc', notarized: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('codesign');
    expect(calls[0].args).toEqual(['--force', '--deep', '-s', '-', appDir]);
  });

  it('row 2: no env → ad-hoc codesign fails → signed:none, no throw, warns', async () => {
    const { appDir, workDir } = await makeAppDir();
    const { exec } = recordingExec(() => true);
    const onProgress = vi.fn();
    const r = await signMacApp({ appDir, env: {}, exec, workDir, onProgress });
    expect(r).toEqual({ signed: 'none', notarized: false });
    expect(onProgress).toHaveBeenCalled();
  });

  it('row 3: identity → codesign success → signed:identity', async () => {
    const { appDir, workDir } = await makeAppDir();
    const { exec, calls } = recordingExec();
    const r = await signMacApp({ appDir, env: { HEARTH_MAC_IDENTITY: 'ID' }, exec, workDir });
    expect(r).toEqual({ signed: 'identity', notarized: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['--force', '--deep', '-s', 'ID', appDir]);
  });

  it('row 4: identity → codesign failure → throws (hard error)', async () => {
    const { appDir, workDir } = await makeAppDir();
    const { exec } = recordingExec((cmd) => cmd === 'codesign');
    await expect(signMacApp({ appDir, env: { HEARTH_MAC_IDENTITY: 'ID' }, exec, workDir })).rejects.toThrow();
  });

  it('row 5: identity + notary triple → success → notarized:true, staples', async () => {
    const { appDir, workDir } = await makeAppDir();
    const { exec, calls } = recordingExec();
    const r = await signMacApp({ appDir, env: NOTARY_ENV, exec, workDir });
    expect(r).toEqual({ signed: 'identity', notarized: true });
    const notary = calls.find((c) => c.cmd === 'xcrun' && c.args.includes('notarytool'));
    expect(notary).toBeDefined();
    expect(notary!.args).toContain('submit');
    expect(notary!.args).toContain('--wait');
    const staple = calls.find((c) => c.cmd === 'xcrun' && c.args.includes('stapler'));
    expect(staple).toBeDefined();
    expect(staple!.args).toContain('staple');
  });

  it('row 6: identity + notary triple → notarytool failure → throws (hard error)', async () => {
    const { appDir, workDir } = await makeAppDir();
    const { exec } = recordingExec((cmd, args) => cmd === 'xcrun' && args.includes('notarytool'));
    await expect(signMacApp({ appDir, env: NOTARY_ENV, exec, workDir })).rejects.toThrow();
  });
});
