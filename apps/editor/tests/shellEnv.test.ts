import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loginShellPathEnv,
  mergePathStrings,
  parseLoginShellPath,
  projectShellEnv,
  resetLoginShellPathCacheForTests,
} from '../server/shellEnv';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetLoginShellPathCacheForTests();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

async function fakeDirenv(script: string): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-direnv-'));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, 'direnv');
  await fsp.writeFile(executable, `#!/bin/sh\n${script}`, { mode: 0o755 });
  return directory;
}

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

  it.skipIf(process.platform === 'win32')('loads the complete approved project environment from direnv', async () => {
    const bin = await fakeDirenv(`
if [ "$#" -ne 4 ] || [ "$1" != "exec" ] || [ "$3" != "env" ] || [ "$4" != "-0" ] || [ "$2" != "$EXPECTED_ROOT" ]; then
  exit 64
fi
printf 'PROJECT_ONLY=ready\\0EQUALS=left=right\\0MULTILINE=first\\nsecond\\0EMPTY=\\0CWD=%s\\0' "$(pwd)"
`);
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-project-env-'));
    temporaryDirectories.push(root);
    await fsp.writeFile(path.join(root, '.envrc'), '');
    const savedPath = process.env.PATH;
    const savedShell = process.env.SHELL;
    const savedRoot = process.env.EXPECTED_ROOT;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.SHELL = '/does/not/exist';
    process.env.EXPECTED_ROOT = root;
    resetLoginShellPathCacheForTests();
    try {
      await expect(projectShellEnv(root)).resolves.toEqual({
        PROJECT_ONLY: 'ready',
        EQUALS: 'left=right',
        MULTILINE: 'first\nsecond',
        EMPTY: '',
        CWD: await fsp.realpath(root),
      });
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = savedShell;
      if (savedRoot === undefined) delete process.env.EXPECTED_ROOT;
      else process.env.EXPECTED_ROOT = savedRoot;
    }
  });

  it.skipIf(process.platform === 'win32')('falls back without exposing rejected direnv output', async () => {
    const bin = await fakeDirenv(`
printf 'secret-value' >&2
exit 1
`);
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-rejected-env-'));
    temporaryDirectories.push(root);
    await fsp.writeFile(path.join(root, '.envrc'), '');
    const savedPath = process.env.PATH;
    const savedShell = process.env.SHELL;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.SHELL = '/does/not/exist';
    resetLoginShellPathCacheForTests();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const expected = { ...process.env };
      await expect(projectShellEnv(root)).resolves.toEqual(expected);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = savedShell;
    }
  });

  it.skipIf(process.platform === 'win32')('closes the direnv process group before falling back on timeout', async () => {
    const bin = await fakeDirenv(`
trap '' TERM
sleep 30 &
printf '%s' "$!" > "$DIRENV_CHILD_PID"
wait
`);
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-timeout-env-'));
    temporaryDirectories.push(root);
    await fsp.writeFile(path.join(root, '.envrc'), '');
    const childPidFile = path.join(root, 'direnv-child-pid');
    const savedPath = process.env.PATH;
    const savedShell = process.env.SHELL;
    const savedChildPid = process.env.DIRENV_CHILD_PID;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.SHELL = '/does/not/exist';
    process.env.DIRENV_CHILD_PID = childPidFile;
    resetLoginShellPathCacheForTests();
    try {
      const expected = { ...process.env };
      await loginShellPathEnv();
      const realSetTimeout = globalThis.setTimeout;
      let triggerTimeout: (() => void) | undefined;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          if (delay === 10_000) {
            triggerTimeout = () => callback(...args);
            return 1 as unknown as ReturnType<typeof setTimeout>;
          }
          return realSetTimeout(callback, delay, ...args);
        }) as typeof setTimeout,
      );
      const result = projectShellEnv(root);
      let childPid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          childPid = Number(await fsp.readFile(childPidFile, 'utf8'));
          break;
        } catch {
          await new Promise((resolve) => realSetTimeout(resolve, 10));
        }
      }
      expect(childPid).toBeTypeOf('number');
      expect(triggerTimeout).toBeTypeOf('function');
      triggerTimeout?.();
      await expect(result).resolves.toEqual(expected);
      expect(() => process.kill(childPid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = savedShell;
      if (savedChildPid === undefined) delete process.env.DIRENV_CHILD_PID;
      else process.env.DIRENV_CHILD_PID = savedChildPid;
    }
  });

  it.skipIf(process.platform === 'win32')('does not invoke direnv when the project has no envrc', async () => {
    const bin = await fakeDirenv(`
touch "$DIRENV_CALLED"
printf 'UNEXPECTED=1\\0'
`);
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-no-envrc-'));
    temporaryDirectories.push(root);
    const marker = path.join(root, 'called');
    const savedPath = process.env.PATH;
    const savedShell = process.env.SHELL;
    const savedMarker = process.env.DIRENV_CALLED;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.SHELL = '/does/not/exist';
    process.env.DIRENV_CALLED = marker;
    resetLoginShellPathCacheForTests();
    try {
      const expected = { ...process.env };
      await expect(projectShellEnv(root)).resolves.toEqual(expected);
      await expect(fsp.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = savedShell;
      if (savedMarker === undefined) delete process.env.DIRENV_CALLED;
      else process.env.DIRENV_CALLED = savedMarker;
    }
  });

  it.skipIf(process.platform === 'win32').each([
    ['missing terminal NUL', "printf 'FIRST=one\\0SECOND=two'"],
    ['interior empty record', "printf 'FIRST=one\\0\\0SECOND=two\\0'"],
  ])('rejects malformed direnv output with %s', async (_name, script) => {
    const bin = await fakeDirenv(`${script}\n`);
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-malformed-env-'));
    temporaryDirectories.push(root);
    await fsp.writeFile(path.join(root, '.envrc'), '');
    const savedPath = process.env.PATH;
    const savedShell = process.env.SHELL;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.SHELL = '/does/not/exist';
    resetLoginShellPathCacheForTests();
    try {
      const expected = { ...process.env };
      await expect(projectShellEnv(root)).resolves.toEqual(expected);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = savedShell;
    }
  });
});
