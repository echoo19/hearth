import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const LOGIN_SHELL_TIMEOUT_MS = 10_000;
const PROJECT_SHELL_TIMEOUT_MS = 10_000;
const PROJECT_SHELL_KILL_GRACE_MS = 250;
const BEGIN = '__HEARTH_SHELL_ENV_BEGIN__';
const END = '__HEARTH_SHELL_ENV_END__';
const COMMAND = `echo ${BEGIN}; /usr/bin/env; echo ${END}`;

function readLoginShell(shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shell, ['-ilc', COMMAND], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, LOGIN_SHELL_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? output : null));
  });
}

export function parseLoginShellPath(stdout: string): string | null {
  const start = stdout.lastIndexOf(BEGIN);
  if (start === -1) return null;
  const end = stdout.indexOf(END, start + BEGIN.length);
  if (end === -1) return null;
  const block = stdout.slice(start + BEGIN.length, end);
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith('PATH=')) continue;
    return line.slice('PATH='.length).trim() || null;
  }
  return null;
}

export function mergePathStrings(current: string, fromShell: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...current.split(':'), ...fromShell.split(':')]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(':');
}

let cached: Promise<NodeJS.ProcessEnv | null> | null = null;

export function resetLoginShellPathCacheForTests(): void {
  cached = null;
}

async function fetchLoginShellPathEnv(): Promise<NodeJS.ProcessEnv | null> {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const output = await readLoginShell(shell);
  if (!output) return null;
  const shellPath = parseLoginShellPath(output);
  if (!shellPath) return null;
  const currentPath = process.env.PATH ?? '';
  const PATH = mergePathStrings(currentPath, shellPath);
  return PATH === currentPath ? null : { ...process.env, PATH };
}

export function loginShellPathEnv(): Promise<NodeJS.ProcessEnv | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  cached ??= fetchLoginShellPathEnv().catch(() => null);
  return cached;
}

function readProjectEnv(root: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('direnv', ['exec', root, 'env', '-0'], {
        cwd: root,
        detached: true,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let killEscalated = false;
    let closed = false;
    let failed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: NodeJS.ProcessEnv | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(value);
    };
    const killProcessGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process may already have exited between the close/timeout checks.
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killEscalated = true;
        killProcessGroup('SIGKILL');
        if (closed) finish(null);
      }, PROJECT_SHELL_KILL_GRACE_MS);
    }, PROJECT_SHELL_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => {
      failed = true;
    });
    child.on('close', (code) => {
      closed = true;
      if (timedOut) {
        if (killEscalated) finish(null);
        return;
      }
      if (failed || code !== 0) {
        finish(null);
        return;
      }
      const output = Buffer.concat(chunks);
      if (output.length === 0 || output[output.length - 1] !== 0) {
        finish(null);
        return;
      }
      const entries = output.toString('utf8').split('\0');
      entries.pop();
      const parsed: NodeJS.ProcessEnv = {};
      for (const entry of entries) {
        if (!entry) {
          finish(null);
          return;
        }
        const equals = entry.indexOf('=');
        if (equals <= 0) {
          finish(null);
          return;
        }
        parsed[entry.slice(0, equals)] = entry.slice(equals + 1);
      }
      finish(parsed);
    });
  });
}

export async function projectShellEnv(root: string): Promise<NodeJS.ProcessEnv> {
  const base = (await loginShellPathEnv()) ?? process.env;
  if (process.platform === 'win32') return base;
  try {
    await access(join(root, '.envrc'));
  } catch {
    return base;
  }
  return (await readProjectEnv(root, base)) ?? base;
}
