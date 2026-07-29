/**
 * Raw output, as a tab under the game pane. Everything the app itself and the
 * agent layer had to say, with timestamps.
 *
 * NOT the running game. `ConsoleSource` has a 'game' member and nothing has
 * ever written one: there is no error handler on this window and no bridge out
 * of the game's frame. The empty state used to promise the game's errors
 * anyway, which is the worst possible thing for this panel to do, because the
 * reader's conclusion from an empty console is that their game is fine.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import type { ConsoleEntry } from '../types';
import { Icon } from './ui';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';

/**
 * Level-filter chips: 'all' or a single level.
 * Kept as a plain union (not a Set) — one chip active at a time reads better
 * than combinable toggles for a three-level console.
 */
export type ConsoleFilter = 'all' | ConsoleEntry['level'];

/** Apply a level filter — pure so the chip logic is unit-testable. */
export function filterConsoleEntries(entries: readonly ConsoleEntry[], filter: ConsoleFilter): ConsoleEntry[] {
  return filter === 'all' ? [...entries] : entries.filter((e) => e.level === filter);
}

/**
 * Plain-text form of the visible entries for the Copy affordance: one line
 * per entry, file location appended when the entry links one.
 */
export function consoleEntriesText(entries: readonly ConsoleEntry[]): string {
  return entries
    .map((e) => {
      const loc = e.link ? ` (${e.link.line != null ? `${e.link.path}:${e.link.line}` : e.link.path})` : '';
      return `${e.time} [${e.level}] ${e.source}: ${e.message}${loc}`;
    })
    .join('\n');
}

/**
 * Clickable `path:line` suffix for a Console entry that names a file. The
 * click opens that file in the code peek.
 *
 * Pulled to module scope (not a component-local closure) so the click
 * behavior is unit-testable without a DOM.
 */
export function openConsoleLink(link: NonNullable<ConsoleEntry['link']>, openFile: (path: string) => void): void {
  openFile(link.path);
}

/**
 * Whether a scroll container is parked at (or within `slack` px of) its
 * bottom — the scroll-lock predicate for the Console's auto-follow. Pulled to
 * module scope (no DOM) so the threshold is unit-testable without a real
 * layout (see consoleAutoScroll.test.ts). jsdom reports all three metrics as
 * 0, so this must read `true` at the origin — matching the intent that an
 * empty/short console counts as "at the bottom".
 */
export function isNearBottom(metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack = 24): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < slack;
}

/**
 * The scrollTop to apply when the Console surface mounts. A fresh mount starts
 * at scrollTop 0, which reads as "stuck at the top" on a full console.
 * Restores the intent instead: snap to the bottom when parked there
 * (auto-follow), else the saved offset. Pure (no DOM) so the decision is
 * unit-testable without a real layout — jsdom reports zero metrics, the same
 * reason isNearBottom is pure.
 */
export function scrollRestoreTop(
  metrics: { scrollHeight: number },
  stickToBottom: boolean,
  savedScrollTop: number,
): number {
  return stickToBottom ? metrics.scrollHeight : savedScrollTop;
}

function ConsoleLink({ link }: { link: NonNullable<ConsoleEntry['link']> }) {
  const openCodePeek = useApp((s) => s.openCodePeek);
  const label = link.line != null ? `${link.path}:${link.line}` : link.path;

  return (
    <Tooltip content={`Open ${label}`}>
      <button type="button" className="console-link" onClick={() => openConsoleLink(link, openCodePeek)}>
        {label}
      </button>
    </Tooltip>
  );
}

export function ConsolePanel() {
  const entries = useApp((s) => s.consoleEntries);
  const clearConsole = useApp((s) => s.clearConsole);
  const setConsoleAtBottom = useApp((s) => s.setConsoleAtBottom);
  const [filter, setFilter] = useState<ConsoleFilter>('all');
  const [copied, setCopied] = useState(false);
  const visible = filterConsoleEntries(entries, filter);
  const bodyRef = useRef<HTMLDivElement>(null);
  /**
   * Scroll-lock: only auto-scroll when the user was already parked at (or
   * near) the bottom before the new line arrived — the standard terminal/chat
   * idiom. Updated by the body's own scroll handler; appending content grows
   * scrollHeight without firing a scroll event, so this retains the last
   * user-intent value across new entries. Starts pinned (the empty console is
   * "at the bottom").
   */
  const stickToBottomRef = useRef(true);
  /**
   * The last user-intended scroll offset. Paired with `stickToBottomRef`,
   * this is the scroll INTENT restored on mount — see the layout effect below.
   */
  const lastScrollTopRef = useRef(0);

  // Key on the last entry's id, NOT entries.length: the list is capped, so
  // once the cap is hit length pins forever and a length-keyed effect goes
  // dormant mid-list while entries keep arriving. The id is monotonic, so this
  // re-fires on every real append; combined with the scroll-lock guard, a new
  // line never yanks a reader who scrolled up back to the bottom.
  const lastEntryId = entries.length > 0 ? entries[entries.length - 1].id : 0;

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lastEntryId]);

  /**
   * Land at the live tail on mount. The Console is a tab whose surface is
   * unmounted while another tab shows, so every reveal is a fresh mount and
   * the browser starts it at scrollTop 0 — which reads as "stuck at the top"
   * on a full console. A layout effect (before paint, no flash).
   */
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = scrollRestoreTop(el, stickToBottomRef.current, lastScrollTopRef.current);
  }, []);

  function handleScroll() {
    const el = bodyRef.current;
    // A hidden surface reports clientHeight 0; ignore the scroll events that
    // fire around a reveal so they don't clobber the restored intent.
    if (!el || el.clientHeight === 0) return;
    // Within ~24px of the bottom counts as "parked at the bottom" so a
    // sub-pixel rounding or a short overscroll doesn't unstick auto-follow.
    const atBottom = isNearBottom(el);
    // Mirror the scroll-lock into the store only on change — errors landing
    // while scrolled up count toward the unread badge (see store.log), and
    // returning to the bottom clears it.
    if (atBottom !== stickToBottomRef.current) setConsoleAtBottom(atBottom);
    stickToBottomRef.current = atBottom;
    lastScrollTopRef.current = el.scrollTop;
  }

  function copyVisible() {
    void navigator.clipboard.writeText(consoleEntriesText(visible));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  const FILTERS: { id: ConsoleFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'info', label: 'Info' },
    { id: 'warn', label: 'Warn' },
    { id: 'error', label: 'Errors' },
  ];

  return (
    <>
      <div className="panel-toolbar">
        {/* Level filter chips — one active at a time, like a segmented control. */}
        <span role="group" aria-label="Filter console by level" style={{ display: 'inline-flex', gap: 2 }}>
          {FILTERS.map((f) => (
            <Button
              key={f.id}
              size="sm"
              variant={filter === f.id ? 'primary' : 'ghost'}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </Button>
          ))}
        </span>
        <span style={{ flex: 1 }} />
        <Tooltip content="Copy the visible entries as text">
          <Button variant="ghost" size="sm" onClick={copyVisible} disabled={visible.length === 0}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={clearConsole} disabled={entries.length === 0}>
          Clear
        </Button>
      </div>
      <div className="panel-body" ref={bodyRef} onScroll={handleScroll} style={{ padding: 0 }}>
        {entries.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="script" size={16} />
            </span>
            <span>Nothing to report</span>
            {/* This used to promise "errors from the agent layer and from the
                running game". Half of that was not true: nothing anywhere logs
                with the 'game' source, there is no error handler on this window
                and no bridge out of the game's frame, so a game throwing on
                every frame produced exactly this empty panel. A person reading
                "nothing to report" concluded their game was fine.

                The game runs on its own loopback origin now, so a real bridge
                is possible along the channel the pane already uses for canvas
                sizing (server/gameServer.ts injects the sender, GamePane owns
                the receiver). Until that exists this says what it can actually
                deliver, and points at the place that does have the game's own
                errors. */}
            <span className="hint">
              What Hearth and the agent layer had to say, with timestamps. Your game&apos;s own errors do
              not reach here yet: open the browser devtools on the game window to see those.
            </span>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="script" size={16} />
            </span>
            {/* The level in the words the chips use — `warn` is a log token,
                not something anyone says out loud. */}
            <span>{filter === 'error' ? 'No errors' : filter === 'warn' ? 'No warnings' : 'Nothing at info level'}</span>
            <Button size="sm" onClick={() => setFilter('all')}>
              Show all
            </Button>
          </div>
        ) : (
          <div className="console-list">
            {visible.map((entry) => (
              <div key={entry.id} className={`console-line level-${entry.level}`}>
                <span className="console-time">{entry.time}</span>
                <span className="console-source">{entry.source}</span>
                <span className="console-msg">{entry.message}</span>
                {entry.link && <ConsoleLink link={entry.link} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
