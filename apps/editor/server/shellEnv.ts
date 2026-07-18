import { spawn } from 'node:child_process';

const LOGIN_SHELL_TIMEOUT_MS = 10_000;
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
