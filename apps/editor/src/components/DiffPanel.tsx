import React, { useEffect, useState } from 'react';
import { useEditor } from '../store';
import { ConfirmDialog, Icon } from './ui';
import type { HistoryEntry, HistoryList, ProjectDiff } from '../types';

function fmt(value: unknown): string {
  const s = JSON.stringify(value);
  return s === undefined ? 'undefined' : s.length > 48 ? s.slice(0, 45) + '…' : s;
}

function statusClass(status: 'added' | 'removed' | 'modified'): string {
  return `diff-${status}`;
}

export function DiffPanel() {
  const diff = useEditor((s) => s.diff);
  const refreshDiff = useEditor((s) => s.refreshDiff);
  const exec = useEditor((s) => s.exec);
  const log = useEditor((s) => s.log);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [history, setHistory] = useState<HistoryList | null>(null);

  async function loadHistory() {
    const result = await exec<HistoryList>('listHistory', {}, { quiet: true });
    setHistory(result.success ? (result.data ?? null) : null);
  }

  // Refetch whenever the diff is (re)loaded — the "Refresh diff" button and
  // the panel-focus refresh in Workspace both bump `diff`, so this piggybacks
  // on that instead of needing its own store wiring. Also covers first mount.
  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff]);

  async function snapshot() {
    const result = await exec('snapshotProject', {}, { quiet: true });
    if (result.success) {
      log('info', 'command', 'Snapshot saved. Future diffs compare against this baseline.');
      await refreshDiff();
    }
  }

  const cursor = history?.cursor ?? 0;
  const entries = history?.entries ?? [];
  const undoTarget = cursor > 0 ? entries[cursor - 1] : null;
  const redoTarget = cursor < entries.length ? entries[cursor] : null;

  async function undo() {
    const result = await exec<{ undone: string; seq: number }>('undo');
    if (result.success && result.data) {
      log('info', 'command', `Undo: reverted "${result.data.undone}" (#${result.data.seq}).`);
    }
    await loadHistory();
  }

  async function redo() {
    const result = await exec<{ redone: string; seq: number }>('redo');
    if (result.success && result.data) {
      log('info', 'command', `Redo: reapplied "${result.data.redone}" (#${result.data.seq}).`);
    }
    await loadHistory();
  }

  return (
    <>
      <div className="panel-toolbar">
        <button
          className="btn btn-sm"
          onClick={() => void undo()}
          disabled={!undoTarget}
          title="undo"
        >
          {undoTarget ? `Undo ${undoTarget.command}` : 'Undo'}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => void redo()}
          disabled={!redoTarget}
          title="redo"
        >
          {redoTarget ? `Redo ${redoTarget.command}` : 'Redo'}
        </button>
        <span className="panel-divider" />
        <button className="btn btn-sm" onClick={() => void snapshot()} title="snapshotProject">
          Snapshot
        </button>
        <button className="btn btn-sm" onClick={() => void refreshDiff()} title="diffProject">
          Refresh diff
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-danger btn-sm"
          onClick={() => setConfirmRevert(true)}
          disabled={!diff?.hasChanges}
          title="revertProject: restore the last snapshot"
        >
          Revert to snapshot
        </button>
      </div>

      <div className="panel-body">
        <HistorySection entries={entries} />

        {!diff ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="duplicate" size={16} />
            </span>
            <span>No baseline to compare against</span>
            <span className="hint">
              The review workflow: press Snapshot before edits (yours or an agent's), make changes, then
              Refresh diff to see exactly what changed: scenes, entities, component properties, scripts, and
              assets. Revert restores the snapshot.
            </span>
          </div>
        ) : !diff.hasChanges ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="duplicate" size={16} />
            </span>
            <span>No changes since the last snapshot</span>
            <span className="hint">Edit the scene (or let an agent work), then refresh.</span>
          </div>
        ) : (
          <DiffBody diff={diff} />
        )}
      </div>

      <ConfirmDialog
        open={confirmRevert}
        title="Revert to snapshot?"
        body="All scene, script, and asset-index changes since the last snapshot are discarded. A revert isn't recorded in the undo history, so it can't be reversed with Undo — unlike other edits."
        confirmLabel="Revert everything"
        danger
        onCancel={() => setConfirmRevert(false)}
        onConfirm={() => {
          setConfirmRevert(false);
          void exec('revertProject', { confirm: true }).then(() => refreshDiff());
        }}
      />
    </>
  );
}

function HistorySection({ entries }: { entries: HistoryEntry[] }) {
  return (
    <div className="diff-section history-section">
      <h4>History</h4>
      {entries.length === 0 ? (
        <div className="diff-row" style={{ color: 'var(--ink-faint)' }}>
          No recorded changes yet — this fills up as you edit the project.
        </div>
      ) : (
        entries.map((entry) => (
          <div className={`diff-row history-row${entry.undone ? ' history-row-undone' : ''}`} key={entry.seq}>
            <span className="history-seq">#{entry.seq}</span> {entry.command}
            {entry.summary ? <span style={{ color: 'var(--ink-faint)' }}> — {entry.summary}</span> : null}
          </div>
        ))
      )}
    </div>
  );
}

function DiffBody({ diff }: { diff: ProjectDiff }) {
  return (
    <>
      <div className="diff-summary">{diff.summary}</div>

      {diff.scenes.map((sceneDiff) => (
        <div className="diff-section" key={sceneDiff.id}>
          <h4>
            Scene <span className={statusClass(sceneDiff.status)}>{sceneDiff.name}</span>{' '}
            <span style={{ color: 'var(--ink-faint)' }}>({sceneDiff.status})</span>
          </h4>
          {sceneDiff.entities.map((entityDiff) => (
            <div key={entityDiff.id} style={{ marginBottom: 4 }}>
              <div className={`diff-row entity-head ${statusClass(entityDiff.status)}`}>
                {entityDiff.status === 'added' ? '+ ' : entityDiff.status === 'removed' ? '− ' : '~ '}
                {entityDiff.name}
              </div>
              {entityDiff.fieldChanges.map((change) => (
                <div className="diff-row diff-change" key={change.path}>
                  {change.path}: {fmt(change.before)}
                  <span className="arrow">→</span>
                  {fmt(change.after)}
                </div>
              ))}
              {entityDiff.components.map((componentDiff) => (
                <React.Fragment key={componentDiff.type}>
                  <div className={`diff-row ${statusClass(componentDiff.status)}`}>
                    {componentDiff.status === 'added' ? '+ ' : componentDiff.status === 'removed' ? '− ' : '~ '}
                    {componentDiff.type}
                  </div>
                  {componentDiff.status === 'modified' &&
                    componentDiff.changes.map((change) => (
                      <div className="diff-row diff-change" key={change.path}>
                        {componentDiff.type}.{change.path}: {fmt(change.before)}
                        <span className="arrow">→</span>
                        {fmt(change.after)}
                      </div>
                    ))}
                </React.Fragment>
              ))}
            </div>
          ))}
        </div>
      ))}

      {diff.assets.length > 0 && (
        <div className="diff-section">
          <h4>Assets</h4>
          {diff.assets.map((asset) => (
            <div className={`diff-row ${statusClass(asset.status)}`} key={asset.id}>
              {asset.status === 'added' ? '+ ' : asset.status === 'removed' ? '− ' : '~ '}
              {asset.name} <span style={{ color: 'var(--ink-faint)' }}>({asset.type}, {asset.path})</span>
            </div>
          ))}
        </div>
      )}

      {diff.scripts.length > 0 && (
        <div className="diff-section">
          <h4>Scripts</h4>
          {diff.scripts.map((script) => (
            <div className={`diff-row ${statusClass(script.status)}`} key={script.path}>
              {script.status === 'added' ? '+ ' : script.status === 'removed' ? '− ' : '~ '}
              {script.path}{' '}
              <span style={{ color: 'var(--ink-faint)' }}>
                ({script.linesBefore} → {script.linesAfter} lines)
              </span>
            </div>
          ))}
        </div>
      )}

      {diff.projectChanges.length > 0 && (
        <div className="diff-section">
          <h4>Project settings</h4>
          {diff.projectChanges.map((change) => (
            <div className="diff-row diff-change" key={change.path}>
              {change.path}: {fmt(change.before)}
              <span className="arrow">→</span>
              {fmt(change.after)}
            </div>
          ))}
        </div>
      )}

      {diff.playtests.length > 0 && (
        <div className="diff-section">
          <h4>Playtests</h4>
          {diff.playtests.map((pt) => (
            <div className={`diff-row ${statusClass(pt.status)}`} key={pt.id}>
              {pt.status === 'added' ? '+ ' : pt.status === 'removed' ? '− ' : '~ '}
              {pt.name}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
