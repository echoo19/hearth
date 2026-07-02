import React, { useState } from 'react';
import { useEditor } from '../store';
import { ConfirmDialog } from './ui';
import type { ProjectDiff } from '../types';

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

  async function snapshot() {
    const result = await exec('snapshotProject', {}, { quiet: true });
    if (result.success) {
      log('info', 'command', 'Snapshot saved — future diffs compare against this baseline.');
      await refreshDiff();
    }
  }

  return (
    <>
      <div className="panel-toolbar">
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
          title="revertProject — restore the last snapshot"
        >
          Revert to snapshot
        </button>
      </div>

      <div className="panel-body">
        {!diff ? (
          <div className="empty-state">
            <span>No baseline to compare against</span>
            <span className="hint">
              The review workflow: press Snapshot before edits (yours or an agent's), make changes, then
              Refresh diff to see exactly what changed — scenes, entities, component properties, scripts, and
              assets. Revert restores the snapshot.
            </span>
          </div>
        ) : !diff.hasChanges ? (
          <div className="empty-state">
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
        body="All scene, script, and asset-index changes since the last snapshot are discarded. This cannot be undone."
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
