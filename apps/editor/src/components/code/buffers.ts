/**
 * Pure buffer model for the Code panel's tab strip. The panel edits many
 * scripts at once; each open script is a `Buffer`, and the whole set is a
 * plain `Buffer[]` + `activePath`. All the list mutations that need to be
 * exactly right — dirty derivation, the open-past-the-cap eviction rule,
 * neighbour selection on close — live here as side-effect-free reducers so
 * they can be unit-tested without React, the store, or CodeMirror (see
 * codePanelBuffers.test.ts). CodeMirror-free on purpose: this module sits
 * outside the lazy CM6 chunk boundary, same as scriptLanguage.ts.
 */
import type { ExternalChangeEntry } from './externalChange';
import type { JournalEntry } from '../../types';

/** One open script. `revision` bumps only on an external reload (forces the
 * CodeEditor to rebuild that path's state from fresh content); tab switches
 * do NOT bump it — they restore the cached EditorState instead. */
export interface Buffer {
  path: string;
  source: string;
  savedSource: string;
  revision: number;
  conflict: boolean;
  saveError: string | null;
  scriptMissing: boolean;
  /** True until the initial disk read resolves. */
  loading: boolean;
  /** Set when the initial disk read failed. */
  loadError: string | null;
}

export interface BufferState {
  buffers: Buffer[];
  activePath: string | null;
}

/** Soft cap on simultaneously-open tabs. Opening past this auto-closes the
 * oldest CLEAN buffer; dirty buffers are never auto-closed even if that means
 * temporarily exceeding the cap. */
export const MAX_BUFFERS = 12;

export function makeBuffer(path: string): Buffer {
  return {
    path,
    source: '',
    savedSource: '',
    revision: 0,
    conflict: false,
    saveError: null,
    scriptMissing: false,
    loading: true,
    loadError: null,
  };
}

/** Dirty is derived, never stored: a loaded buffer whose live source has
 * diverged from what was last saved. A still-loading or failed buffer is
 * never dirty (there is nothing meaningful to lose yet). */
export function isDirty(b: Buffer): boolean {
  return !b.loading && b.loadError === null && b.source !== b.savedSource;
}

export function findBuffer(buffers: Buffer[], path: string): Buffer | undefined {
  return buffers.find((b) => b.path === path);
}

/** Immutably patch the buffer at `path`; returns the same array reference
 * when the path is not open (so callers can skip a re-render). */
export function patchBuffer(buffers: Buffer[], path: string, patch: Partial<Buffer>): Buffer[] {
  if (!findBuffer(buffers, path)) return buffers;
  return buffers.map((b) => (b.path === path ? { ...b, ...patch } : b));
}

/**
 * Open (or focus) `path`. An already-open path is simply activated — no
 * reorder, no reload. A new path is appended in open order and activated;
 * if that pushes the count over `max`, the oldest CLEAN buffers are evicted
 * (returned in `evicted` so the caller can drop their cached EditorState and
 * per-buffer refs). Dirty buffers are skipped: unsaved work is never
 * auto-discarded, so the count can exceed `max` when everything is dirty.
 */
export function openBuffer(
  state: BufferState,
  path: string,
  max: number = MAX_BUFFERS,
): { state: BufferState; evicted: string[] } {
  if (findBuffer(state.buffers, path)) {
    return { state: { ...state, activePath: path }, evicted: [] };
  }
  let buffers = [...state.buffers, makeBuffer(path)];
  const evicted: string[] = [];
  while (buffers.length > max) {
    const idx = buffers.findIndex((b) => b.path !== path && !isDirty(b));
    if (idx === -1) break; // only dirty buffers (and the new one) remain — never auto-close dirty
    evicted.push(buffers[idx].path);
    buffers = buffers.filter((_, i) => i !== idx);
  }
  return { state: { buffers, activePath: path }, evicted };
}

/**
 * Close `path`. When it was the active tab, focus moves to the tab that
 * slides into its slot (or the previous one if it was last); the active path
 * goes null when the last buffer closes. Returns `closed: false` and the
 * unchanged state for a path that was not open.
 */
export function closeBuffer(state: BufferState, path: string): { state: BufferState; closed: boolean } {
  const idx = state.buffers.findIndex((b) => b.path === path);
  if (idx === -1) return { state, closed: false };
  const buffers = state.buffers.filter((b) => b.path !== path);
  let activePath = state.activePath;
  if (state.activePath === path) {
    activePath = buffers.length === 0 ? null : (buffers[idx] ?? buffers[idx - 1]).path;
  }
  return { state: { buffers, activePath }, closed: true };
}

/**
 * Map a raw journal entry to the external-change entries the panel reasons
 * over. Most script commands touch one path (`detail.path`); the bulk
 * commands formatScript / replaceInScripts carry `detail.paths` and fan out
 * to one entry per path, so each open buffer can be evaluated independently.
 * When neither is present the entry still yields a single path-less script
 * entry (decideExternalChange treats an unknown path conservatively).
 */
const SCRIPT_COMMANDS = new Set(['editScript', 'createScript', 'formatScript', 'replaceInScripts']);

export function toExternalChangeEntries(entry: JournalEntry): ExternalChangeEntry[] {
  const kind = SCRIPT_COMMANDS.has(entry.command) ? 'script' : entry.command;
  const paths = entry.detail?.paths;
  if (Array.isArray(paths) && paths.length > 0) {
    return paths
      .filter((p): p is string => typeof p === 'string')
      .map((path) => ({ kind, source: entry.source, path }));
  }
  const detailPath = entry.detail?.path;
  const path = typeof detailPath === 'string' ? detailPath : undefined;
  return [{ kind, source: entry.source, path }];
}
