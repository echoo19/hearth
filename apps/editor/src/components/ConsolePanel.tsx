import React, { useEffect, useRef } from 'react';
import { useEditor } from '../store';
import type { ConsoleEntry, ValidationReport } from '../types';
import { Icon } from './ui';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';

/**
 * Clickable `path:line` suffix for a Console entry that names an exact
 * script location (a runtime error or a hot-reload compile failure — see
 * store.ts's `formatRuntimeError`/`applyReload`). `line` is null when only
 * the file is known; the click still opens it, just at the top.
 *
 * Styling lives in the `.console-link` rule in styles.css (base ink-faint,
 * ember hover, mono font, focus-visible ring). Keyboard focus is a real
 * `<button>` — reachable in Console tab order and activatable with Enter/Space.
 */
// Click behavior, pulled out of the JSX closure (module scope, not a
// component-local closure) so it's unit-testable without a DOM — mirrors
// Hierarchy.tsx's isActivationKey. `line: null` maps to `undefined` for
// openScriptAt, which opens the file at the top.
export function openConsoleLink(link: NonNullable<ConsoleEntry['link']>, openScriptAt: (path: string, line?: number) => void): void {
  openScriptAt(link.path, link.line ?? undefined);
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

function ConsoleLink({ link }: { link: NonNullable<ConsoleEntry['link']> }) {
  const openScriptAt = useEditor((s) => s.openScriptAt);
  const label = link.line != null ? `${link.path}:${link.line}` : link.path;

  return (
    <Tooltip content={`Open ${label}`}>
      <button type="button" className="console-link" onClick={() => openConsoleLink(link, openScriptAt)}>
        {label}
      </button>
    </Tooltip>
  );
}

export function ConsolePanel() {
  const entries = useEditor((s) => s.consoleEntries);
  const clearConsole = useEditor((s) => s.clearConsole);
  const exec = useEditor((s) => s.exec);
  const log = useEditor((s) => s.log);
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

  // Key on the last entry's id, NOT entries.length: the list is capped at
  // MAX_CONSOLE, so once the cap is hit length pins forever and a
  // length-keyed effect goes dormant mid-list while entries keep arriving
  // (CONSOLE-CHANGES-1). The id is monotonic, so this re-fires on every real
  // append. Combined with the scroll-lock guard it also fixes the "any new
  // line yanks you back to bottom" complaint (CONSOLE-CHANGES-2).
  const lastEntryId = entries.length > 0 ? entries[entries.length - 1].id : 0;

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lastEntryId]);

  function handleScroll() {
    const el = bodyRef.current;
    if (!el) return;
    // Within ~24px of the bottom counts as "parked at the bottom" so a
    // sub-pixel rounding or a short overscroll doesn't unstick auto-follow.
    stickToBottomRef.current = isNearBottom(el);
  }

  async function validate() {
    const result = await exec<ValidationReport>('validateProject', {}, { quiet: true });
    if (!result.success || !result.data) return;
    const report = result.data;
    for (const issue of report.errors) {
      log('error', 'validate', `[${issue.code}] ${issue.message}`);
    }
    for (const issue of report.warnings) {
      log('warn', 'validate', `[${issue.code}] ${issue.message}`);
    }
    if (report.valid && report.warnings.length === 0) {
      log('info', 'validate', 'Project is valid, with no errors or warnings.');
    } else if (report.valid) {
      log('info', 'validate', `Project is valid with ${report.warnings.length} warning(s).`);
    } else {
      log('error', 'validate', `Validation failed: ${report.errors.length} error(s), ${report.warnings.length} warning(s).`);
    }
  }

  return (
    <>
      <div className="panel-toolbar">
        <Button size="sm" onClick={() => void validate()}>
          Validate project
        </Button>
        <span style={{ flex: 1 }} />
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
            <span>Console is quiet</span>
            <span className="hint">
              Command results, warnings, validation reports, and runtime logs from the Game preview show up
              here with timestamps.
            </span>
          </div>
        ) : (
          <div className="console-list">
            {entries.map((entry) => (
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
