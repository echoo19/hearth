/**
 * Agent panel trust layer: an activity timeline over the journal feed
 * (../../store.ts's `journalFeed` — every structured command run through
 * `HearthSession.execute`, from this editor, the CLI, or an MCP agent; see
 * @hearth/core's project/journal.ts) plus the session-level controls that
 * make that feed actionable (Checkpoint / Review changes / Revert session).
 *
 * Two layers, same split as useAgentSocket.ts next door:
 *  - Pure functions (`entryToRow`, `commandIcon`, `relativeTime`) mapping a
 *    JournalEntry to what a row renders — no DOM, unit tested directly in
 *    apps/editor/tests/timeline.test.ts.
 *  - The `Timeline` component wiring those to the store and to dockview's
 *    panel-focus mechanism (via the store's `requestDiffFocus`, mirrored by
 *    Workspace.tsx the same way it already reacts to `playing`).
 */
import React, { useEffect, useRef, useState } from 'react';
import { useEditor } from '../../store';
import type { JournalEntry } from '../../types';
import { ConfirmDialog, Icon } from '../ui';
import { Button } from '../ui/Button';

export interface TimelineRow {
  icon: string;
  label: string;
  status: 'ok' | 'error';
  meta?: string;
  time: string;
}

/**
 * Maps a journaled command name to the closest existing icon glyph from
 * ui.tsx's set — no new SVGs. The journal only ever records mutating
 * commands plus the two read-only entries on JOURNAL_ALLOWLIST
 * (runPlaytest, validateProject; see core's project/journal.ts), so this
 * covers that closed set with a handful of buckets and falls back to the
 * generic entity glyph (matching ui.tsx's own entityIcon default) for
 * anything added later that doesn't fit yet.
 */
export function commandIcon(command: string): string {
  switch (command) {
    case 'createEntity':
    case 'deleteEntity':
    case 'renameEntity':
    case 'moveEntity':
    case 'setEntityEnabled':
    case 'setEntityTags':
    case 'addComponent':
    case 'removeComponent':
    case 'setComponentProperty':
      return 'entity';
    case 'createScene':
    case 'deleteScene':
    case 'duplicateScene':
    case 'renameScene':
    case 'setInitialScene':
      return 'camera';
    case 'importAsset':
    case 'createSpriteAsset':
    case 'createTileAsset':
    case 'createSound':
    case 'createAnimationAsset':
    case 'setAssetMetadata':
    case 'removeAsset':
    case 'sliceSpritesheet':
    case 'createAnimationFromSheet':
      return 'image';
    case 'createScript':
    case 'editScript':
    case 'attachScript':
      return 'script';
    case 'createPlaytest':
    case 'runPlaytest':
    case 'runScene':
      return 'play';
    case 'updateSettings':
    case 'setInputMapping':
    case 'validateProject':
      return 'grid';
    case 'undo':
    case 'redo':
    case 'revertProject':
      return 'duplicate';
    default:
      return 'entity';
  }
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * `meta` text for the two detail shapes the journal actually produces (see
 * session.ts's `extractJournalDetail`) — treated defensively, since
 * `detail` is a free-form bag and a shape mismatch there must never throw
 * or garble a row, just omit the meta text.
 */
function detailMeta(entry: JournalEntry): string | undefined {
  const detail = entry.detail;
  if (!detail) return undefined;

  if (entry.command === 'runPlaytest') {
    const assertions = detail.assertions;
    const failures = detail.failures;
    if (typeof assertions !== 'number' || typeof failures !== 'number') return undefined;
    return failures > 0 ? `${failures} failed` : `${assertions}/${assertions} assertions`;
  }

  if (entry.command === 'validateProject') {
    const errors = detail.errors;
    const warnings = detail.warnings;
    if (typeof errors !== 'number' || typeof warnings !== 'number') return undefined;
    return `${pluralize(errors, 'error')}, ${pluralize(warnings, 'warning')}`;
  }

  return undefined;
}

/** A tiny local "2m ago" formatter — no new deps. `now` defaults to
 * `Date.now()` but is a parameter so it's exercised deterministically in
 * tests. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/** Pure: JournalEntry -> what a timeline row renders. */
export function entryToRow(entry: JournalEntry, now: number = Date.now()): TimelineRow {
  const status: 'ok' | 'error' = entry.ok ? 'ok' : 'error';
  return {
    icon: commandIcon(entry.command),
    label: entry.summary || entry.command,
    status,
    meta: entry.ok ? detailMeta(entry) : entry.error,
    time: relativeTime(entry.ts, now),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Re-render periodically so "2m ago" keeps advancing without a per-second timer. */
const TICK_MS = 30_000;
/** Distance from the top still considered "pinned" (matches a small tolerance
 * rather than requiring exactly 0, since some browsers report a stray pixel). */
const PIN_TOLERANCE_PX = 4;

export function Timeline() {
  const journalFeed = useEditor((s) => s.journalFeed);
  const snapshotTaken = useEditor((s) => s.snapshotTaken);
  const diff = useEditor((s) => s.diff);
  const exec = useEditor((s) => s.exec);
  const refreshDiff = useEditor((s) => s.refreshDiff);
  const requestDiffFocus = useEditor((s) => s.requestDiffFocus);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [, setTick] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Newest-first. Pinned to the top unless the user has scrolled down to
  // read older entries — matches ConsolePanel's pin-to-bottom, mirrored for
  // a newest-first list.
  const entries = journalFeed.slice().reverse();

  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = 0;
  }, [journalFeed.length]);

  function handleScroll() {
    const el = bodyRef.current;
    if (el) pinnedRef.current = el.scrollTop <= PIN_TOLERANCE_PX;
  }

  async function snapshot() {
    await exec('snapshotProject', {}, { quiet: true });
  }

  function reviewChanges() {
    // Workspace.tsx's diffFocusRequest effect owns both the panel focus and
    // the refreshDiff() call, so this fires it exactly once whether or not
    // the Diff panel happened to be active already (see that effect).
    requestDiffFocus();
  }

  return (
    <div className="agent-timeline">
      <div className="panel-toolbar agent-timeline-toolbar">
        <Button
          size="sm"
          onClick={() => void snapshot()}
          title="Save a checkpoint you can review and restore"
        >
          {snapshotTaken && <span className="timeline-check">✓</span>} Checkpoint
        </Button>
        <Button size="sm" onClick={reviewChanges} title="Focus the Changes panel">
          Review changes
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmRevert(true)}
          disabled={!diff?.hasChanges}
          title="Restore the project to the last checkpoint"
        >
          Restore checkpoint
        </Button>
      </div>

      <div className="agent-timeline-body" ref={bodyRef} onScroll={handleScroll}>
        {entries.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="script" size={16} />
            </span>
            <span>No activity yet</span>
            <span className="hint">
              Every structured command shows up here as it runs — from this editor, the CLI, or an MCP
              agent — even without the terminal above open.
            </span>
          </div>
        ) : (
          entries.map((entry) => {
            const row = entryToRow(entry);
            return (
              <div key={entry.seq} className={`timeline-row timeline-${row.status}`} title={entry.ts}>
                <span className="timeline-icon" aria-hidden="true">
                  <Icon name={row.icon} size={12} />
                </span>
                <span className="timeline-label">{row.label}</span>
                {row.meta && <span className="timeline-meta">{row.meta}</span>}
                <span className="timeline-time">{row.time}</span>
              </div>
            );
          })
        )}
      </div>

      <ConfirmDialog
        open={confirmRevert}
        title="Restore checkpoint?"
        body="All scene, script, and asset-index changes since the last checkpoint are discarded — including anything the agent just did. A revert isn't recorded in the undo history, so it can't be reversed with Undo."
        confirmLabel="Revert everything"
        danger
        onCancel={() => setConfirmRevert(false)}
        onConfirm={() => {
          setConfirmRevert(false);
          void exec('revertProject', { confirm: true }).then(() => refreshDiff());
        }}
      />
    </div>
  );
}
