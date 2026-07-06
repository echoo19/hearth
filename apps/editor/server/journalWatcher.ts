/**
 * Follows a project's command journal (.hearth/log/commands.jsonl) and
 * delivers newly appended entries as they land — the plumbing that lets the
 * editor notice when a CLI/MCP agent (or another editor window) mutates the
 * project out from under it.
 *
 * Primary signal is `fs.watch` on the log directory; a 2s poll is kept
 * running alongside it as a fallback (fs.watch is not fully reliable on
 * every platform/filesystem, e.g. some network mounts or Docker volumes, and
 * can also fail asynchronously post-install — see the watcher `'error'`
 * handler below). Both paths funnel through the same debounced `poll()`,
 * which always reads "everything since the last delivered seq" and — thanks
 * to an in-flight guard that coalesces overlapping triggers into a single
 * rerun rather than a concurrent second read — each seq is delivered in
 * exactly one batch, never zero and never twice.
 *
 * Startup ordering matters, but the other way around from what you'd first
 * guess: the initial `lastSeq()` read that seeds the "already seen" baseline
 * happens *before* the `fs.watch` listener is installed, and an explicit
 * catch-up `poll()` runs right after. Installing the watcher first (reading
 * the baseline second) can *lose* a write outright: if it lands after the
 * watcher starts but before the baseline read resolves, the baseline can
 * fold its seq in as "already seen" — since the baseline just reflects
 * whatever's on disk at the moment it reads, not the moment the watcher
 * attached — and no later event ever re-delivers it. Baseline-first closes
 * that hole: anything appended after the baseline read has a seq strictly
 * greater than `lastDelivered`, so it's necessarily caught either by the
 * immediate poll performed right after (b) or by the watcher/interval once
 * installed (c) — there's no ordering of events that makes it fall between
 * both.
 */
import { watch, mkdirSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { JournalStore, type JournalEntry } from '@hearth/core';
import type { FsLike } from '@hearth/core';

const POLL_INTERVAL_MS = 2000;
const DEBOUNCE_MS = 150;

/**
 * Start following `root`'s journal. `onEntries` is called with each new
 * batch of entries (seq > the last delivered seq, ascending), never
 * including anything already delivered. Returns a disposer that stops the
 * watcher and the poll fallback; safe to call multiple times.
 */
export function startJournalWatcher(
  root: string,
  fs: FsLike,
  onEntries: (entries: JournalEntry[]) => void,
): () => void {
  const store = new JournalStore(fs, root);
  const logDir = path.join(root, '.hearth', 'log');

  let lastDelivered = 0;
  let ready = false;
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;

  // In-flight guard: if a trigger (debounce or interval) fires while a
  // poll's read is still in progress, don't start a second concurrent read
  // (which could re-observe entries the first read is about to deliver,
  // delivering them twice). Instead flag a rerun and let the current poll
  // kick it off once its read has settled.
  let inFlight = false;
  let pendingRerun = false;

  async function poll(): Promise<void> {
    if (disposed || !ready) return;
    if (inFlight) {
      pendingRerun = true;
      return;
    }
    inFlight = true;
    let entries: JournalEntry[] = [];
    let readFailed = false;
    try {
      entries = await store.read({ since: lastDelivered });
    } catch {
      // Transient read error (e.g. mid-rotation rewrite): the next poll
      // tick or watch event will retry from the same lastDelivered.
      readFailed = true;
    }
    if (!readFailed && entries.length > 0) {
      lastDelivered = entries[entries.length - 1].seq;
    }
    // Release the in-flight guard (and capture any rerun request) before
    // calling out to onEntries, so a rerun isn't blocked — or, if onEntries
    // throws, permanently stuck — behind a consumer callback.
    inFlight = false;
    const rerun = pendingRerun;
    pendingRerun = false;

    if (!readFailed && entries.length > 0) {
      // Deliberately outside the try/catch above: onEntries is consumer
      // code, and a throw from it is a different failure class than a
      // transient journal-file read error. Conflating the two would
      // silently swallow bugs in the consumer instead of surfacing them.
      onEntries(entries);
    }
    if (rerun) void poll();
  }

  function scheduleDebounced(): void {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void poll();
    }, DEBOUNCE_MS);
  }

  // Close (if open) and null out the watcher. Centralized so every call site
  // gets the same null-then-close-once behavior instead of re-deriving it
  // (and to sidestep TS forgetting the `watcher` narrowing across the
  // installWatcher()/dispose() call boundaries below).
  function closeWatcher(): void {
    const w = watcher;
    if (!w) return;
    watcher = null;
    w.close();
  }

  function installWatcher(): void {
    // fs.watch throws synchronously on a missing path, so make sure the
    // directory exists first. Best-effort: if this fails, the poll fallback
    // still runs (it tolerates a missing journal file/dir via
    // JournalStore.read's own exists() check).
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      watcher = watch(logDir, () => scheduleDebounced());
      watcher.on('error', () => {
        // fs.watch can fail asynchronously after install (e.g. the watched
        // directory is removed/renamed out from under it on some
        // platforms), delivered as an 'error' event rather than a thrown
        // exception. An FSWatcher is an EventEmitter, so an unlistened
        // 'error' event throws and crashes the whole process — this
        // listener is what stands between one flaky watch and a process
        // crash. Close and drop the watcher; the 2000ms poll fallback keeps
        // the feature working without it.
        closeWatcher();
      });
    } catch {
      watcher = null;
    }
  }

  const pollHandle = setInterval(() => void poll(), POLL_INTERVAL_MS);

  // (a) read the baseline lastSeq, (b) install the fs.watch listener, (c) do
  // one immediate poll — see the ordering note in the file header for why
  // this order (and not watch-then-read) is the one that can't lose a
  // concurrently-appended entry.
  void (async () => {
    lastDelivered = await store.lastSeq();
    if (disposed) return;
    installWatcher();
    if (disposed) {
      // dispose() ran while lastSeq() was resolving: tear down what we just
      // installed instead of leaking a live FSWatcher past the disposer.
      closeWatcher();
      return;
    }
    ready = true;
    await poll();
  })();

  return () => {
    if (disposed) return;
    disposed = true;
    closeWatcher();
    clearInterval(pollHandle);
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
