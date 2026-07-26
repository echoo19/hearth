/**
 * Follows a project's evidence journal (`.hearth/evidence/journal.jsonl`) and
 * delivers newly appended events as they land — the feed behind the app's
 * evidence rail.
 *
 * Same shape as journalWatcher.ts (fs.watch primary, poll fallback, debounce,
 * in-flight coalescing, baseline-read-before-watch ordering) but over a plain
 * JSONL file rather than @hearth/core's JournalStore: the evidence journal is
 * written by the probe, which is engine-agnostic and must not require the
 * editor to link a store implementation to read it.
 *
 * The file usually does NOT exist — a project that has never been playtested
 * has no evidence — so a missing file is the normal case, not an error, and
 * the watcher simply delivers nothing until one appears.
 */
import { watch, mkdirSync, type FSWatcher } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const POLL_INTERVAL_MS = 2000;
const DEBOUNCE_MS = 150;

/** Relative location of the evidence directory and journal within a project. */
export const EVIDENCE_DIR = path.join('.hearth', 'evidence');
export const EVIDENCE_JOURNAL = path.join(EVIDENCE_DIR, 'journal.jsonl');

/**
 * One line of the evidence journal. Structurally mirrors
 * `packages/probe-core/src/evidence.ts`'s `EvidenceEvent`, kept here rather
 * than imported so the editor does not gain a build-order dependency on a
 * package that ships on its own schedule. `kind` is left open (`string`) for
 * forward compatibility: an unknown event renders as a plain note instead of
 * being dropped.
 */
export interface EvidenceEvent {
  kind: string;
  seq: number;
  ts: string;
  [key: string]: unknown;
}

/**
 * Parse a JSONL body into events, skipping blank and malformed lines. A
 * half-written trailing line (the probe appending while we read) is simply
 * skipped and picked up whole by the next poll, since delivery is keyed on
 * `seq` rather than byte offset.
 */
export function parseEvidenceLines(text: string, since: number): EvidenceEvent[] {
  const out: EvidenceEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const event = parsed as Partial<EvidenceEvent>;
    if (typeof event.seq !== 'number' || typeof event.kind !== 'string') continue;
    if (event.seq <= since) continue;
    out.push({ ...(event as EvidenceEvent), ts: typeof event.ts === 'string' ? event.ts : new Date().toISOString() });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/**
 * Start following `root`'s evidence journal. `onEvents` receives each batch of
 * events with `seq` greater than everything already delivered. Returns a
 * disposer; safe to call more than once.
 */
export function startEvidenceWatcher(
  root: string,
  onEvents: (events: EvidenceEvent[]) => void,
): () => void {
  const dir = path.join(root, EVIDENCE_DIR);
  const journal = path.join(root, EVIDENCE_JOURNAL);

  let lastDelivered = 0;
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  let inFlight = false;
  let pendingRerun = false;

  async function readAll(): Promise<string | null> {
    try {
      return await fsp.readFile(journal, 'utf8');
    } catch {
      return null; // absent (the common case) or transiently unreadable
    }
  }

  async function poll(): Promise<void> {
    if (disposed) return;
    if (inFlight) {
      pendingRerun = true;
      return;
    }
    inFlight = true;
    const text = await readAll();
    if (disposed) {
      inFlight = false;
      return;
    }
    const events = text === null ? [] : parseEvidenceLines(text, lastDelivered);
    if (events.length > 0) lastDelivered = events[events.length - 1].seq;
    inFlight = false;
    const rerun = pendingRerun;
    pendingRerun = false;
    // Outside any try/catch: a throw from the consumer is a bug worth
    // surfacing, not a transient read failure to swallow.
    if (events.length > 0) onEvents(events);
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

  function closeWatcher(): void {
    const w = watcher;
    if (!w) return;
    watcher = null;
    w.close();
  }

  function installWatcher(): void {
    // fs.watch throws synchronously on a missing path. The evidence dir is
    // normally absent, so create it — the probe writes here anyway, and an
    // empty dir is cheaper than a 2s-only poll for the whole session.
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* poll fallback still works */
    }
    try {
      watcher = watch(dir, () => scheduleDebounced());
      // An FSWatcher is an EventEmitter: an unhandled 'error' would crash the
      // process. Drop the watcher and let the poll carry the feature.
      watcher.on('error', () => closeWatcher());
    } catch {
      watcher = null;
    }
  }

  const pollHandle = setInterval(() => void poll(), POLL_INTERVAL_MS);
  installWatcher();
  void poll();

  return () => {
    if (disposed) return;
    disposed = true;
    closeWatcher();
    clearInterval(pollHandle);
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
