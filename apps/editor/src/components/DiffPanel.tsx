import React, { useState } from 'react';
import { useEditor } from '../store';
import { ConfirmDialog, Icon } from './ui';
import { Button } from './ui/Button';
import { useHistoryList } from '../useHistoryList';
import type { HistoryEntry, ProjectDiff } from '../types';

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
  /** Which toolbar action is currently in flight, if any — drives the
   * disabled-state + label swap for Undo/Redo/Checkpoint/Refresh/Restore,
   * matching the "Syncing…"/"Duplicating…" convention used elsewhere. */
  const [busy, setBusy] = useState<'undo' | 'redo' | 'checkpoint' | 'refresh' | 'restore' | null>(null);

  // Refetches on mount, after any successful mutating exec() anywhere in the
  // editor (commandSeq — so Inspector/Hierarchy/SceneView edits show up while
  // this panel stays focused), and whenever the diff is (re)loaded (the
  // "Refresh changes" button and the panel-focus refresh in Workspace bump
  // `diff`). See useHistoryList.ts.
  const { undoTarget, redoTarget, history } = useHistoryList();
  const entries = history?.entries ?? [];

  async function snapshot() {
    setBusy('checkpoint');
    const result = await exec('snapshotProject', {}, { quiet: true });
    setBusy(null);
    if (result.success) {
      log('info', 'command', 'Checkpoint saved. The Changes panel now compares against this checkpoint.');
      await refreshDiff();
    }
  }

  // quiet: the custom log lines below replace exec()'s generic changed-summary;
  // history reloads via the commandSeq effect after the mutation lands.
  async function undo() {
    setBusy('undo');
    const result = await exec<{ undone: string; seq: number }>('undo', {}, { quiet: true });
    setBusy(null);
    if (result.success && result.data) {
      log('info', 'command', `Undo: reverted "${result.data.undone}" (#${result.data.seq}).`);
    }
  }

  async function redo() {
    setBusy('redo');
    const result = await exec<{ redone: string; seq: number }>('redo', {}, { quiet: true });
    setBusy(null);
    if (result.success && result.data) {
      log('info', 'command', `Redo: reapplied "${result.data.redone}" (#${result.data.seq}).`);
    }
  }

  async function doRefresh() {
    setBusy('refresh');
    await refreshDiff();
    setBusy(null);
  }

  return (
    <>
      <div className="panel-toolbar">
        <Button size="sm" onClick={() => void undo()} disabled={!undoTarget || busy !== null}>
          {busy === 'undo' ? 'Undoing…' : undoTarget ? `Undo ${undoTarget.command}` : 'Undo'}
        </Button>
        <Button size="sm" onClick={() => void redo()} disabled={!redoTarget || busy !== null}>
          {busy === 'redo' ? 'Redoing…' : redoTarget ? `Redo ${redoTarget.command}` : 'Redo'}
        </Button>
        <span className="panel-divider" />
        <Button
          size="sm"
          onClick={() => void snapshot()}
          disabled={busy !== null}
          title="Save a checkpoint you can review and restore"
        >
          {busy === 'checkpoint' ? 'Saving…' : 'Checkpoint'}
        </Button>
        <Button
          size="sm"
          onClick={() => void doRefresh()}
          disabled={busy !== null}
          title="See what changed since your last checkpoint"
        >
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh changes'}
        </Button>
        <span style={{ flex: 1 }} />
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmRevert(true)}
          disabled={!diff?.hasChanges || busy !== null}
          title="Restore the project to the last checkpoint"
        >
          {busy === 'restore' ? 'Restoring…' : 'Restore checkpoint'}
        </Button>
      </div>

      <div className="panel-body">
        <HistorySection entries={entries} />

        {!diff ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="duplicate" size={16} />
            </span>
            <span>No checkpoint to compare against</span>
            <span className="hint">
              The review workflow: press Checkpoint before edits (yours or an agent's), make changes, then
              Refresh changes to see exactly what changed: scenes, entities, component properties, scripts, and
              assets. Restore checkpoint undoes it all.
            </span>
          </div>
        ) : !diff.hasChanges ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="duplicate" size={16} />
            </span>
            <span>No changes since the last checkpoint</span>
            <span className="hint">Edit the scene (or let an agent work), then refresh.</span>
          </div>
        ) : (
          <DiffBody diff={diff} />
        )}
      </div>

      <ConfirmDialog
        open={confirmRevert}
        title="Restore checkpoint?"
        body="All scene, script, and asset-index changes since the last checkpoint are discarded. A revert isn't recorded in the undo history, so it can't be reversed with Undo — unlike other edits."
        confirmLabel="Revert everything"
        danger
        onCancel={() => setConfirmRevert(false)}
        onConfirm={() => {
          setConfirmRevert(false);
          setBusy('restore');
          void exec('revertProject', { confirm: true })
            .then(() => refreshDiff())
            .finally(() => setBusy(null));
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
          // `summary` already leads with the command name ("createScene Level2").
          <div className={`diff-row history-row${entry.undone ? ' history-row-undone' : ''}`} key={entry.seq}>
            <span className="history-seq">#{entry.seq}</span> {entry.summary}
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
