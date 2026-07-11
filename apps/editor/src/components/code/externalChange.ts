/**
 * Pure decision helper for the Code panel's external-change seam: given a
 * journal entry pushed over the WS channel, decide what the open script
 * buffer should do. No DOM, no store access — kept side-effect-free so the
 * full decision table is unit-testable (see externalChange.test.ts).
 *
 * The invariant this exists to protect (the Wave E stale-clobber bug
 * class): an external agent's edit must never be silently discarded by a
 * later Save from this panel. Concretely: whenever the local buffer is
 * dirty, a matching (or possibly-matching) external script edit always
 * resolves to 'banner', never 'reload' — the user must explicitly choose
 * "Reload" (discard local edits) or "Keep mine" (knowingly overwrite the
 * external edit on the next Save).
 */

export type ExternalChangeAction = 'reload' | 'banner' | 'ignore';

/**
 * A normalized view of a journal entry, as the Code panel maps it from the
 * store's `journalFeed` (JournalEntry from @hearth/core). `kind` mirrors the
 * `ChangedRef.kind` vocabulary ('script' is the only one this helper cares
 * about); `path`, when known, is the project-relative script path the
 * command touched — it is optional because not every command detail carries
 * one (see extractJournalDetail in packages/core/src/session.ts).
 */
export interface ExternalChangeEntry {
  kind: string;
  source: string;
  path?: string;
}

export function decideExternalChange(opts: {
  /** The script currently open in the panel (project-relative path), or null if none. */
  openPath: string | null;
  /** Whether the open buffer has unsaved local edits. */
  dirty: boolean;
  entry: ExternalChangeEntry;
}): ExternalChangeAction {
  const { openPath, dirty, entry } = opts;

  // Our own save, echoed back over the WS journal feed — already reflected
  // in the buffer (or about to be, by the exec() that caused it).
  if (entry.source === 'editor') return 'ignore';

  // Only script edits are relevant to this panel.
  if (entry.kind !== 'script') return 'ignore';

  // Nothing open for this to affect.
  if (openPath === null) return 'ignore';

  // A known path that names a different script is definitely unrelated.
  if (entry.path !== undefined && entry.path !== openPath) return 'ignore';

  // Either the path matches the open script, or it's unknown and can't be
  // ruled out — conservatively treat both as "might be my file". Local
  // dirty state decides whether that's safe to apply automatically.
  return dirty ? 'banner' : 'reload';
}
