/**
 * Tests for PtyManager against a fake PtyBackend — no real pseudo-terminal
 * is spawned in this suite (the real @lydell/node-pty backend is exercised
 * only through manual smoke testing, per the project's test policy for
 * native modules).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PtyManager, type PtyBackend, type PtyHandle } from '../server/ptyManager';

class FakePtyHandle implements PtyHandle {
  dataCbs: Array<(d: string) => void> = [];
  exitCbs: Array<(e: { exitCode: number }) => void> = [];
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.push(cb);
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

describe('PtyManager', () => {
  it('spawns "shell" as $SHELL (or /bin/bash) with no args and cwd=root', () => {
    const savedShell = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    try {
      manager.start('/proj/a', 'shell', { cols: 80, rows: 24 });
      expect(backend.spawns).toHaveLength(1);
      expect(backend.spawns[0].file).toBe('/bin/zsh');
      expect(backend.spawns[0].args).toEqual([]);
      expect(backend.spawns[0].opts.cwd).toBe('/proj/a');
      expect(backend.spawns[0].opts.cols).toBe(80);
      expect(backend.spawns[0].opts.rows).toBe(24);
    } finally {
      if (savedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = savedShell;
    }
  });

  it('spawns "claude" bare (PATH-resolved), no args, never -p/--print', () => {
    manager.start('/proj/b', 'claude', { cols: 80, rows: 24 });
    expect(backend.spawns[0].file).toBe('claude');
    expect(backend.spawns[0].args).toEqual([]);
  });

  it('spawns "codex" bare, no args', () => {
    manager.start('/proj/c', 'codex', { cols: 80, rows: 24 });
    expect(backend.spawns[0].file).toBe('codex');
    expect(backend.spawns[0].args).toEqual([]);
  });

  it('spawns "opencode" and "hermes" bare (PATH-resolved), no args', () => {
    manager.start('/proj/oc', 'opencode', { cols: 80, rows: 24 });
    manager.start('/proj/hm', 'hermes', { cols: 80, rows: 24 });
    expect(backend.spawns[0].file).toBe('opencode');
    expect(backend.spawns[0].args).toEqual([]);
    expect(backend.spawns[1].file).toBe('hermes');
    expect(backend.spawns[1].args).toEqual([]);
  });

  it('passes a caller-supplied env to the backend (the hearth-shim PATH)', () => {
    const env = { PATH: '/shim:/usr/bin' } as NodeJS.ProcessEnv;
    manager.start('/proj/env', 'shell', { cols: 80, rows: 24, env });
    expect(backend.spawns[0].opts.env).toBe(env);
  });

  it('defaults env to process.env when none is supplied', () => {
    manager.start('/proj/env2', 'shell', { cols: 80, rows: 24 });
    expect(backend.spawns[0].opts.env).toBe(process.env);
  });

  it('write() forwards to the active pty for that root', () => {
    manager.start('/proj', 'shell', { cols: 80, rows: 24 });
    manager.write('/proj', 'echo hi\r');
    expect(backend.spawns[0].handle.writes).toEqual(['echo hi\r']);
  });

  it('write() to a root with no pty is a silent no-op', () => {
    expect(() => manager.write('/nowhere', 'x')).not.toThrow();
  });

  it('resize() forwards cols/rows to the active pty', () => {
    manager.start('/proj', 'shell', { cols: 80, rows: 24 });
    manager.resize('/proj', 120, 40);
    expect(backend.spawns[0].handle.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('kill() kills the active pty and clears it', () => {
    manager.start('/proj', 'shell', { cols: 80, rows: 24 });
    manager.kill('/proj');
    expect(backend.spawns[0].handle.killed).toBe(true);
    // Further writes are now no-ops (nothing to forward to).
    manager.write('/proj', 'x');
    expect(backend.spawns[0].handle.writes).toEqual([]);
  });

  it('kill() on a root with no pty is a silent no-op', () => {
    expect(() => manager.kill('/nowhere')).not.toThrow();
  });

  it('a second start() for the same root kills the first pty before spawning the second', () => {
    manager.start('/proj', 'shell', { cols: 80, rows: 24 });
    const first = backend.spawns[0].handle;
    expect(first.killed).toBe(false);

    manager.start('/proj', 'claude', { cols: 80, rows: 24 });
    expect(first.killed).toBe(true);
    expect(backend.spawns).toHaveLength(2);

    // Writes now go to the second pty only.
    manager.write('/proj', 'y');
    expect(first.writes).toEqual([]);
    expect(backend.spawns[1].handle.writes).toEqual(['y']);
  });

  it('starting ptys for different roots does not interfere with each other', () => {
    manager.start('/a', 'shell', { cols: 80, rows: 24 });
    manager.start('/b', 'shell', { cols: 80, rows: 24 });
    manager.write('/a', 'to-a');
    manager.write('/b', 'to-b');
    expect(backend.spawns[0].handle.writes).toEqual(['to-a']);
    expect(backend.spawns[1].handle.writes).toEqual(['to-b']);
  });

  it('when the pty exits on its own, the manager forgets it (no double-kill on close)', () => {
    manager.start('/proj', 'shell', { cols: 80, rows: 24 });
    const handle = backend.spawns[0].handle;
    handle.emitExit(0);
    // kill() on an already-exited pty must not call kill() again.
    manager.kill('/proj');
    expect(handle.killed).toBe(false);
  });

  it('killAll() tears down every live pty', () => {
    manager.start('/a', 'shell', { cols: 80, rows: 24 });
    manager.start('/b', 'shell', { cols: 80, rows: 24 });
    manager.killAll();
    expect(backend.spawns[0].handle.killed).toBe(true);
    expect(backend.spawns[1].handle.killed).toBe(true);
  });

  it('routes backend data/exit events through onData/onExit registered by the caller', () => {
    const handle = manager.start('/proj', 'shell', { cols: 80, rows: 24 });
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
