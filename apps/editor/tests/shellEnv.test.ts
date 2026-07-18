import { afterEach, describe, expect, it } from 'vitest';
import {
  loginShellPathEnv,
  mergePathStrings,
  parseLoginShellPath,
  resetLoginShellPathCacheForTests,
} from '../server/shellEnv';

afterEach(() => resetLoginShellPathCacheForTests());

describe('shell environment', () => {
  it('parses PATH only from the marked login-shell block', () => {
    expect(
      parseLoginShellPath(
        'banner\n__HEARTH_SHELL_ENV_BEGIN__\nHOME=/tmp\nPATH=/shell/bin:/usr/bin\n__HEARTH_SHELL_ENV_END__\n',
      ),
    ).toBe('/shell/bin:/usr/bin');
  });

  it('keeps process PATH entries first and appends shell-only entries once', () => {
    expect(mergePathStrings('/current:/shared', '/shared:/shell')).toBe('/current:/shared:/shell');
  });

  it.skipIf(process.platform === 'win32')('degrades safely when the configured shell cannot run', async () => {
    const saved = process.env.SHELL;
    process.env.SHELL = '/does/not/exist';
    resetLoginShellPathCacheForTests();
    try {
      await expect(loginShellPathEnv()).resolves.toBeNull();
    } finally {
      if (saved === undefined) delete process.env.SHELL;
      else process.env.SHELL = saved;
    }
  });
});
