/**
 * Tests for the journal file watcher: fs.watch on .hearth/log/ plus a poll
 * fallback, debounced, delivering only newly appended entries (no
 * duplicates, no missed writes between watcher start and the first read),
 * and tolerating both a failing fs.watch and overlapping poll triggers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fsp, watch } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JournalStore, type JournalEntry } from '@hearth/core';
import type { FsLike } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { startJournalWatcher } from '../server/journalWatcher';

// `watch` is replaced with a `vi.fn` wrapper around the real implementation
// so most tests exercise real fs.watch unchanged, while the "async error"
// test below can swap in a fake watcher for a single call via
// `mockReturnValueOnce` (self-consuming, so it never leaks into other
// tests).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const disposers: (() => void)[] = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

describe('startJournalWatcher', () => {
  it('delivers appended entries in batches, without duplicates', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-journal-watch-'));
    const fs = new NodeFileSystem();
    const writer = new JournalStore(fs, root);

    const batches: JournalEntry[][] = [];
    const dispose = startJournalWatcher(root, fs, (entries) => batches.push(entries));
    disposers.push(dispose);

    // Give the watcher a moment to install and read its starting seq.
    await wait(50);

    // Two rapid appends should coalesce into a single delivered batch
    // (debounced), not two separate callbacks.
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'A', ok: true });
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'B', ok: true });

    await wait(400);

    const delivered = batches.flat();
    expect(delivered.map((e) => e.summary)).toEqual(['A', 'B']);
    expect(batches.length).toBeGreaterThanOrEqual(1);
    // No duplicates: every seq appears exactly once across all batches.
    const seqs = delivered.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);

    // A further append after the first batch is delivered as new, not
    // re-delivering the earlier entries.
    await writer.append({ ts: new Date().toISOString(), source: 'editor', command: 'createEntity', summary: 'C', ok: true });
    await wait(400);

    const delivered2 = batches.flat();
    expect(delivered2.map((e) => e.summary)).toEqual(['A', 'B', 'C']);

    dispose();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('does not miss an entry written immediately after the watcher starts, even racing the baseline read', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-journal-watch-'));
    const fs = new NodeFileSystem();
    const writer = new JournalStore(fs, root);

    // Pre-seed the journal with real entries so the startup lastSeq() call
    // does a real file read (backward scan for the trailing line) instead
    // of short-circuiting on the "file doesn't exist yet" exists() check —
    // this exercises the actual race the baseline-first ordering protects
    // against, not just the degenerate empty-journal case.
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'seed-1', ok: true });
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'seed-2', ok: true });
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'seed-3', ok: true });

    const batches: JournalEntry[][] = [];
    const dispose = startJournalWatcher(root, fs, (entries) => batches.push(entries));
    disposers.push(dispose);

    // No delay here on purpose: append as soon as possible after starting
    // the watcher, so it races the in-flight lastSeq() baseline read rather
    // than landing safely after it resolves.
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'racer', ok: true });

    await wait(500);

    const delivered = batches.flat();
    expect(delivered.some((e) => e.summary === 'racer')).toBe(true);
    // The pre-seeded entries were already on disk before the baseline read,
    // so they're "already seen" — never (re-)delivered as a new batch.
    expect(delivered.some((e) => e.summary.startsWith('seed-'))).toBe(false);

    dispose();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('stops delivering after dispose', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-journal-watch-'));
    const fs = new NodeFileSystem();
    const writer = new JournalStore(fs, root);

    const batches: JournalEntry[][] = [];
    const dispose = startJournalWatcher(root, fs, (entries) => batches.push(entries));
    await wait(50);

    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'before', ok: true });
    await wait(400);
    expect(batches.flat().map((e) => e.summary)).toEqual(['before']);

    dispose();

    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'after', ok: true });
    await wait(400);
    expect(batches.flat().map((e) => e.summary)).toEqual(['before']);

    await fsp.rm(root, { recursive: true, force: true });
  });

  it('closes and drops the watcher on an async fs.watch error, without crashing, and keeps delivering via the poll fallback', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-journal-watch-'));
    const fs = new NodeFileSystem();
    const writer = new JournalStore(fs, root);

    class FakeWatcher extends EventEmitter {
      close = vi.fn();
    }
    const fakeWatcher = new FakeWatcher();
    vi.mocked(watch).mockReturnValueOnce(fakeWatcher as unknown as FSWatcher);

    const batches: JournalEntry[][] = [];
    const dispose = startJournalWatcher(root, fs, (entries) => batches.push(entries));
    disposers.push(dispose);

    // Let startup install the (fake) watcher.
    await wait(50);

    // Simulate fs.watch failing asynchronously (e.g. EPERM after the
    // watched directory is removed out from under it). Emitting 'error' on
    // an EventEmitter with no listener throws and crashes the process —
    // if this line throws, the fix's 'error' listener is missing.
    expect(() => fakeWatcher.emit('error', new Error('EPERM simulated'))).not.toThrow();
    expect(fakeWatcher.close).toHaveBeenCalled();

    // With fs.watch gone, an append must still be delivered — only the
    // 2000ms poll fallback can catch it now, not the (dead) watcher.
    await writer.append({
      ts: new Date().toISOString(),
      source: 'cli',
      command: 'createScene',
      summary: 'via-poll-fallback',
      ok: true,
    });
    await wait(2500);

    const delivered = batches.flat();
    expect(delivered.some((e) => e.summary === 'via-poll-fallback')).toBe(true);

    dispose();
    await fsp.rm(root, { recursive: true, force: true });
  }, 8000);

  it('does not deliver the same entries twice when polls overlap (slow read)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-journal-watch-'));
    const inner = new NodeFileSystem();
    const writer = new JournalStore(inner, root);

    // A JournalStore backed by an fs whose readFile() can be made to hang,
    // so a poll's read is still in flight when a second trigger (another
    // watch event) fires — deterministically forcing the overlap the
    // in-flight guard exists to collapse into a single rerun instead of a
    // concurrent second read.
    let delayMs = 0;
    let activeReads = 0;
    let maxActiveReads = 0;
    const delayedFs: FsLike = {
      async readFile(p: string) {
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        try {
          if (delayMs > 0) await wait(delayMs);
          return await inner.readFile(p);
        } finally {
          activeReads--;
        }
      },
      readFileBinary: (p) => inner.readFileBinary(p),
      writeFile: (p, c) => inner.writeFile(p, c),
      appendFile: (p, t) => inner.appendFile(p, t),
      exists: (p) => inner.exists(p),
      mkdir: (p) => inner.mkdir(p),
      readdir: (p) => inner.readdir(p),
      stat: (p) => inner.stat(p),
      remove: (p) => inner.remove(p),
      copyFile: (s, d) => inner.copyFile(s, d),
    };

    const batches: JournalEntry[][] = [];
    const dispose = startJournalWatcher(root, delayedFs, (entries) => batches.push(entries));
    disposers.push(dispose);

    await wait(50); // let the (fast, empty-journal) baseline read settle

    // From here on, every read of the journal file takes 400ms.
    delayMs = 400;

    // Append A: its watch event debounces to a poll ~150ms later, whose
    // store.read() then hangs for 400ms (in flight roughly t=150..550).
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'A', ok: true });

    // Append B while A's poll is still in flight: this fires another watch
    // event, debouncing to a second poll() call around t=350 — squarely
    // inside A's poll's in-flight window. Without the guard this starts a
    // second concurrent store.read({since: 0}), which (since lastDelivered
    // hasn't been bumped yet) would see both A and B again and re-deliver
    // them once A's read also completes: a duplicate. With the guard, this
    // trigger only sets pendingRerun and does not start a second read.
    await wait(200);
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'B', ok: true });

    // Give A's poll time to finish, the guarded rerun to fire and (finding
    // nothing new) complete, and everything to settle.
    await wait(1500);

    const delivered = batches.flat();
    expect(delivered.map((e) => e.summary).sort()).toEqual(['A', 'B']);
    const seqs = delivered.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // every seq exactly once
    expect(maxActiveReads).toBeLessThanOrEqual(1); // never two concurrent reads

    dispose();
    await fsp.rm(root, { recursive: true, force: true });
  }, 8000);
});
