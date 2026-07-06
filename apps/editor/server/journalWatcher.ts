/**
 * Follows a project's command journal (.hearth/log/commands.jsonl) and
 * delivers newly appended entries as they land — the plumbing that lets the
 * editor notice when a CLI/MCP agent (or another editor window) mutates the
 * project out from under it.
 *
 * Primary signal is `fs.watch` on the log directory; a 2s poll is kept
 * running alongside it as a fallback (fs.watch is not fully reliable on
 * every platform/filesystem, e.g. some network mounts or Docker volumes).
 * Both paths funnel through the same debounced `poll()`, which always reads
 * "everything since the last delivered seq", so bursts of events collapse
 * into a single batch and nothing is ever delivered twice.
 *
 * Startup ordering matters: the fs.watch listener is installed (synchronously,
 * no intervening `await`) *before* the initial `lastSeq()` read that seeds
 * the "already seen" baseline. Doing it the other way around — reading
 * lastSeq first, then installing the watcher — leaves a window where a write
 * that lands in between is invisible to fs.watch (it started too late to see
 * it) and only recoverable by the slow poll fallback. With the watcher first,
 * any write from that point on triggers a (debounced) poll, so at worst it's
 * caught by the explicit catch-up poll performed right after the baseline
 * read resolves.
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

  async function poll(): Promise<void> {
    if (disposed || !ready) return;
    try {
      const entries = await store.read({ since: lastDelivered });
      if (entries.length > 0) {
        lastDelivered = entries[entries.length - 1].seq;
        onEntries(entries);
      }
    } catch {
      // Transient read error (e.g. mid-rotation rewrite): the next poll
      // tick or watch event will retry from the same lastDelivered.
    }
  }

  function scheduleDebounced(): void {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void poll();
    }, DEBOUNCE_MS);
  }

  // fs.watch throws synchronously on a missing path, so make sure the
  // directory exists first. Best-effort: if this fails, the poll fallback
  // below still runs (it tolerates a missing journal file/dir via
  // JournalStore.read's own exists() check).
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* ignore */
  }

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(logDir, () => scheduleDebounced());
  } catch {
    watcher = null;
  }

  const pollHandle = setInterval(() => void poll(), POLL_INTERVAL_MS);

  // Seed the baseline only *after* the watcher above is already listening
  // (see the ordering note in the file header), then do one immediate poll
  // to flush anything that landed in the microtask gap while lastSeq() was
  // resolving.
  void (async () => {
    lastDelivered = await store.lastSeq();
    ready = true;
    await poll();
  })();

  return () => {
    if (disposed) return;
    disposed = true;
    if (watcher) watcher.close();
    clearInterval(pollHandle);
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
