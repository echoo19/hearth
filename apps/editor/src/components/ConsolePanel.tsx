import React, { useEffect, useRef } from 'react';
import { useEditor } from '../store';
import type { ValidationReport } from '../types';

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
      log('info', 'validate', 'Project is valid — no errors, no warnings.');
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
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
