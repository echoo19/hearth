/**
 * Tests for PtyManager against a fake PtyBackend — no real pseudo-terminal
 * is spawned in this suite (the real @lydell/node-pty backend is exercised
 * only through manual smoke testing, per the project's test policy for
 * native modules).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import {
  createLazyHandle,
  PtyManager,
  resolveShell,
  ScrollbackBuffer,
  SERVER_SCROLLBACK_CAP_BYTES,
  SERVER_SCROLLBACK_TRIM_SLACK_BYTES,
  type PtyBackend,
  type PtyHandle,
} from '../server/ptyManager';

class FakePtyHandle implements PtyHandle {
  dataCbs: Array<(d: string) => void> = [];
  exitCbs: Array<(e: { exitCode: number }) => void> = [];
  errorCbs: Array<(error: Error) => void> = [];
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.push(cb);
  }
  onError(cb: (error: Error) => void): void {
    this.errorCbs.push(cb);
  }
  write(d: string): void {
    this.writes.push(d);
  }
  resize(c: number, r: number): void {
    this.resizes.push({ cols: c, rows: r });
  }
  kill(): void {
    this.killed = true;
  }

  emitData(d: string): void {
    for (const cb of this.dataCbs) cb(d);
  }
  emitExit(code: number): void {
    for (const cb of this.exitCbs) cb({ exitCode: code });
  }
}

class FakeBackend implements PtyBackend {
  spawns: Array<{ file: string; args: string[]; opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }; handle: FakePtyHandle }> = [];

  spawn(file: string, args: string[], opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }): PtyHandle {
    const handle = new FakePtyHandle();
    this.spawns.push({ file, args, opts, handle });
    return handle;
  }
}

let backend: FakeBackend;
let manager: PtyManager;

beforeEach(() => {
  backend = new FakeBackend();
  manager = new PtyManager(backend);
});

describe('resolveShell', () => {
  it('uses powershell.exe on Windows even when SHELL is set', () => {
    expect(resolveShell('win32', { SHELL: '/bin/zsh' })).toEqual({
      file: 'powershell.exe',
      args: [],
    });
  });

  it('uses $SHELL on POSIX, falling back to /bin/bash', () => {
    expect(resolveShell('linux', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: [] });
    expect(resolveShell('darwin', {})).toEqual({ file: '/bin/bash', args: [] });
  });
});

describe('PtyManager', () => {
  // The expected shell is platform-specific (powershell.exe on Windows,
  // $SHELL/bin/bash on POSIX), so derive it the same way PtyManager does rather
  // than hardcoding a POSIX path — otherwise this fails on the Windows release CI.
  it('spawns the platform shell with no args and cwd=root', () => {
    const savedShell = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    try {
      const expected = resolveShell(os.platform(), process.env);
      manager.start('session-a', '/proj/a', { cols: 80, rows: 24 });
      expect(backend.spawns).toHaveLength(1);
      expect(backend.spawns[0].file).toBe(expected.file);
      expect(backend.spawns[0].args).toEqual(expected.args);
      expect(backend.spawns[0].opts.cwd).toBe('/proj/a');
      expect(backend.spawns[0].opts.cols).toBe(80);
      expect(backend.spawns[0].opts.rows).toBe(24);
    } finally {
      if (savedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = savedShell;
    }
  });

  it('passes a caller-supplied env to the backend (the hearth-shim PATH)', () => {
    const env = { PATH: '/shim:/usr/bin' } as NodeJS.ProcessEnv;
    manager.start('session', '/proj/env', { cols: 80, rows: 24, env });
    expect(backend.spawns[0].opts.env).toBe(env);
  });

  it('defaults env to process.env when none is supplied', () => {
    manager.start('session', '/proj/env2', { cols: 80, rows: 24 });
    expect(backend.spawns[0].opts.env).toBe(process.env);
  });

  it('write() forwards to the active pty for that root', () => {
    manager.start('session', '/proj', { cols: 80, rows: 24 });
    manager.write('session', 'echo hi\r');
    expect(backend.spawns[0].handle.writes).toEqual(['echo hi\r']);
  });

  it('write() to a root with no pty is a silent no-op', () => {
    expect(() => manager.write('/nowhere', 'x')).not.toThrow();
  });

  it('resize() forwards cols/rows to the active pty', () => {
    manager.start('session', '/proj', { cols: 80, rows: 24 });
    manager.resize('session', 120, 40);
    expect(backend.spawns[0].handle.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('kill() kills the active pty and clears it', () => {
    manager.start('session', '/proj', { cols: 80, rows: 24 });
    manager.kill('session');
    expect(backend.spawns[0].handle.killed).toBe(true);
    // Further writes are now no-ops (nothing to forward to).
    manager.write('session', 'x');
    expect(backend.spawns[0].handle.writes).toEqual([]);
  });

  it('kill() on a root with no pty is a silent no-op', () => {
    expect(() => manager.kill('/nowhere')).not.toThrow();
  });

  it('a second start() for the same root kills the first pty before spawning the second', () => {
    manager.start('session', '/proj', { cols: 80, rows: 24 });
    const first = backend.spawns[0].handle;
    expect(first.killed).toBe(false);

    manager.start('session', '/proj', { cols: 80, rows: 24 });
    expect(first.killed).toBe(true);
    expect(backend.spawns).toHaveLength(2);

    // Writes now go to the second pty only.
    manager.write('session', 'y');
    expect(first.writes).toEqual([]);
    expect(backend.spawns[1].handle.writes).toEqual(['y']);
  });

  it('starting distinct session keys in the same cwd does not interfere', () => {
    manager.start('a', '/same-project', { cols: 80, rows: 24 });
    manager.start('b', '/same-project', { cols: 80, rows: 24 });
    manager.write('a', 'to-a');
    manager.write('b', 'to-b');
    expect(backend.spawns[0].handle.writes).toEqual(['to-a']);
    expect(backend.spawns[1].handle.writes).toEqual(['to-b']);
  });

  it('when the pty exits on its own, the manager forgets it (no double-kill on close)', () => {
    manager.start('session', '/proj', { cols: 80, rows: 24 });
    const handle = backend.spawns[0].handle;
    handle.emitExit(0);
    // kill() on an already-exited pty must not call kill() again.
    manager.kill('session');
    expect(handle.killed).toBe(false);
  });

  it('killAll() tears down every live pty', () => {
    manager.start('a', '/a', { cols: 80, rows: 24 });
    manager.start('b', '/b', { cols: 80, rows: 24 });
    manager.killAll();
    expect(backend.spawns[0].handle.killed).toBe(true);
    expect(backend.spawns[1].handle.killed).toBe(true);
  });

  it('routes backend data/exit events through onData/onExit registered by the caller', () => {
    const handle = manager.start('session', '/proj', { cols: 80, rows: 24 });
    const seenData: string[] = [];
    let seenExit: number | null = null;
    handle.onData((d) => seenData.push(d));
    handle.onExit((e) => (seenExit = e.exitCode));

    backend.spawns[0].handle.emitData('hello\n');
    backend.spawns[0].handle.emitExit(0);

    expect(seenData).toEqual(['hello\n']);
    expect(seenExit).toBe(0);
  });
});

describe('createLazyHandle', () => {
  it('retains an early async spawn error for a late subscriber', async () => {
    const handle = createLazyHandle(Promise.reject(new Error('native pty unavailable')));
    await Promise.resolve();

    const errors: string[] = [];
    handle.onError((error) => errors.push(error.message));

    expect(errors).toEqual(['native pty unavailable']);
  });
});

describe('ScrollbackBuffer', () => {
  it('accumulates appended chunks and snapshots them with zero dropped bytes', () => {
    const buffer = new ScrollbackBuffer();
    buffer.append('hello ');
    buffer.append('world');
    expect(buffer.snapshot()).toEqual({ data: 'hello world', dropped: 0 });
  });

  it('tolerates overshoot within the trim slack (no copy on every chunk)', () => {
    const buffer = new ScrollbackBuffer();
    buffer.append('x'.repeat(SERVER_SCROLLBACK_CAP_BYTES));
    buffer.append('y'.repeat(1000));
    const snap = buffer.snapshot();
    expect(snap.data.length).toBe(SERVER_SCROLLBACK_CAP_BYTES + 1000);
    expect(snap.dropped).toBe(0);
  });

  it('trims back to exactly the cap once past cap+slack, tracking dropped bytes', () => {
    const buffer = new ScrollbackBuffer();
    buffer.append('x'.repeat(SERVER_SCROLLBACK_CAP_BYTES));
    const overflow = 'y'.repeat(SERVER_SCROLLBACK_TRIM_SLACK_BYTES + 500);
    buffer.append(overflow);
    const snap = buffer.snapshot();
    expect(snap.data.length).toBe(SERVER_SCROLLBACK_CAP_BYTES);
    expect(snap.dropped).toBe(SERVER_SCROLLBACK_TRIM_SLACK_BYTES + 500);
    expect(snap.data.endsWith(overflow)).toBe(true);
  });

  it('supports a custom cap for tests and small sessions', () => {
    const buffer = new ScrollbackBuffer(10, 4);
    buffer.append('0123456789'); // exactly at cap
    buffer.append('abcde'); // 15 > cap+slack(14): trim to cap
    expect(buffer.snapshot()).toEqual({ data: '56789abcde', dropped: 5 });
  });
});
