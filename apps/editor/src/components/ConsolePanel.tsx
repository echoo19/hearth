import React, { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import type { ConsoleEntry, ValidationReport } from '../types';
import { Icon } from './ui';

/**
 * Clickable `path:line` suffix for a Console entry that names an exact
 * script location (a runtime error or a hot-reload compile failure — see
 * store.ts's `formatRuntimeError`/`applyReload`). `line` is null when only
 * the file is known; the click still opens it, just at the top.
 *
 * No `.console-link` rule exists in styles.css yet (Task 7 ships this ahead
 * of the concurrent styles.css work this cycle to avoid a merge collision —
 * see task-7-brief.md); base look + accent hover are tokened inline so it
 * reads correctly today, and a future polish pass can lift this into a real
 * stylesheet rule. Keyboard focus is already covered by the global
 * `:focus-visible` button rule in styles.css.
 */
// Click behavior, pulled out of the JSX closure (module scope, not a
// component-local closure) so it's unit-testable without a DOM — mirrors
// Hierarchy.tsx's isActivationKey. `line: null` maps to `undefined` for
// openScriptAt, which opens the file at the top.
export function openConsoleLink(link: NonNullable<ConsoleEntry['link']>, openScriptAt: (path: string, line?: number) => void): void {
  openScriptAt(link.path, link.line ?? undefined);
}

function ConsoleLink({ link }: { link: NonNullable<ConsoleEntry['link']> }) {
  const openScriptAt = useEditor((s) => s.openScriptAt);
  const [hover, setHover] = useState(false);
  const label = link.line != null ? `${link.path}:${link.line}` : link.path;

  return (
    <button
      type="button"
      className="console-link"
      onClick={() => openConsoleLink(link, openScriptAt)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Open ${label}`}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '11px',
        lineHeight: 1.4,
        background: 'transparent',
        border: 'none',
        padding: 0,
        marginLeft: 8,
        cursor: 'pointer',
        color: hover ? 'var(--accent)' : 'var(--ink-faint)',
        textDecoration: hover ? 'underline' : 'none',
      }}
    >
      {label}
    </button>
  );
}

export function ConsolePanel() {
  const entries = useEditor((s) => s.consoleEntries);
  const clearConsole = useEditor((s) => s.clearConsole);
  const exec = useEditor((s) => s.exec);
  const log = useEditor((s) => s.log);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

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
        <button className="btn btn-sm" onClick={() => void validate()}>
          Validate project
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={clearConsole} disabled={entries.length === 0}>
          Clear
        </button>
      </div>
      <div className="panel-body" ref={bodyRef} style={{ padding: 0 }}>
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
