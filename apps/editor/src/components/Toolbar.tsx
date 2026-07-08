import React, { useEffect, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { useEditor } from '../store';
import { Icon, Modal } from './ui';
import { ExportDialog } from './ExportDialog';
import { SceneMenu } from './SceneMenu';
import { ViewMenu } from '../workspace/ViewMenu';
import { showPanel } from '../workspace/Workspace';
import type { HistoryList } from '../types';

// TODO(Task 8): this belongs in keybinds.ts once that module exists — inlined
// here for now since this is the first place that needs a platform-aware
// shortcut label.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform);

export function Toolbar({ dock, storageKey }: { dock: DockviewApi | null; storageKey: string }) {
  const info = useEditor((s) => s.info);
  const sceneId = useEditor((s) => s.sceneId);
  const playing = useEditor((s) => s.playing);
  const debugDraw = useEditor((s) => s.debugDraw);
  const diff = useEditor((s) => s.diff);
  const commandSeq = useEditor((s) => s.commandSeq);
  const selectScene = useEditor((s) => s.selectScene);
  const setPlaying = useEditor((s) => s.setPlaying);
  const setDebugDraw = useEditor((s) => s.setDebugDraw);
  const refreshDiff = useEditor((s) => s.refreshDiff);
  const exec = useEditor((s) => s.exec);
  const closeProject = useEditor((s) => s.closeProject);
  const log = useEditor((s) => s.log);

  const [newSceneOpen, setNewSceneOpen] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [history, setHistory] = useState<HistoryList | null>(null);

  async function createScene() {
    const name = newSceneName.trim();
    if (!name) return;
    const result = await exec<{ sceneId: string }>('createScene', { name });
    setNewSceneOpen(false);
    setNewSceneName('');
    if (result.success && result.data) {
      await selectScene(result.data.sceneId);
    }
  }

  async function snapshot() {
    const result = await exec<{ scenes: number }>('snapshotProject', {}, { quiet: true });
    if (result.success) {
      log('info', 'command', 'Checkpoint saved. The Changes panel now compares against this checkpoint.');
    }
  }

  // Same enabled-state wiring as DiffPanel.tsx's Undo/Redo buttons: reload
  // listHistory whenever a mutation lands (commandSeq) or the diff is
  // (re)loaded, and derive undo/redo availability from the history cursor.
  async function loadHistory() {
    const result = await exec<HistoryList>('listHistory', {}, { quiet: true });
    setHistory(result.success ? (result.data ?? null) : null);
  }

  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, commandSeq]);

  const cursor = history?.cursor ?? 0;
  const entries = history?.entries ?? [];
  const undoTarget = cursor > 0 ? entries[cursor - 1] : null;
  const redoTarget = cursor < entries.length ? entries[cursor] : null;

  // quiet: the custom log lines below replace exec()'s generic changed-summary.
  async function undo() {
    const result = await exec<{ undone: string; seq: number }>('undo', {}, { quiet: true });
    if (result.success && result.data) {
      log('info', 'command', `Undo: reverted "${result.data.undone}" (#${result.data.seq}).`);
    }
  }

  async function redo() {
    const result = await exec<{ redone: string; seq: number }>('redo', {}, { quiet: true });
    if (result.success && result.data) {
      log('info', 'command', `Redo: reapplied "${result.data.redone}" (#${result.data.seq}).`);
    }
  }

  return (
    <header className="toolbar">
      <span className="wordmark">
        <span className="flame">
          <Icon name="flame" size={16} />
        </span>
        Hearth
      </span>
      <span className="project-name" title={info?.description || info?.name}>
        {info?.name}
      </span>

      <span className="divider" />

      <span className="toolbar-group">
        <select
          className="select"
          value={sceneId ?? ''}
          onChange={(e) => void selectScene(e.target.value)}
          aria-label="Scene"
          style={{ maxWidth: 200 }}
        >
          {(info?.scenes ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {info?.initialScene === s.id ? ' (initial)' : ''}
            </option>
          ))}
        </select>
        <SceneMenu />
        <button className="btn btn-sm" onClick={() => setNewSceneOpen(true)} title="New scene">
          <Icon name="plus" /> Scene
        </button>
      </span>

      <span className="divider" />

      <button
        className={playing ? 'btn btn-sm btn-stop' : 'btn btn-primary btn-sm btn-play'}
        onClick={() => setPlaying(!playing)}
        title={playing ? 'Stop the preview' : 'Play the current scene in the Game tab'}
      >
        <Icon name={playing ? 'stop' : 'play'} /> {playing ? 'Stop' : 'Play'}
      </button>

      <span className="toolbar-group">
        <button
          className="btn btn-sm"
          onClick={() => void undo()}
          disabled={!undoTarget}
          title={`Undo (${isMac ? '⌘Z' : 'Ctrl+Z'})`}
        >
          Undo
        </button>
        <button
          className="btn btn-sm"
          onClick={() => void redo()}
          disabled={!redoTarget}
          title={`Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Shift+Z'})`}
        >
          Redo
        </button>
      </span>

      <button
        className={debugDraw ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
        onClick={() => setDebugDraw(!debugDraw)}
        title="Toggle the Game preview's debug overlay (collider outlines, velocity vectors, light radii)"
        aria-pressed={debugDraw}
      >
        Debug
      </button>

      <span className="divider" />

      <ViewMenu dock={dock} storageKey={storageKey} />

      <span className="spacer" />

      <span className="toolbar-group">
        <button
          className="btn btn-sm"
          onClick={() => void snapshot()}
          title="Save a checkpoint to compare against later (snapshotProject)"
        >
          Checkpoint
        </button>
        <button
          className="btn btn-sm"
          onClick={() => {
            if (dock) showPanel(dock, 'diff');
            void refreshDiff();
          }}
          title="Show changes since the last checkpoint"
        >
          Review
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setExportOpen(true)}
          title="Export a playable web build (exportWeb)"
        >
          Export
        </button>
      </span>

      <span className="divider" />

      <span className="save-note">Every change saves automatically</span>
      <button className="btn btn-ghost btn-sm" onClick={closeProject}>
        Close project
      </button>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />

      <Modal open={newSceneOpen} title="New scene" onClose={() => setNewSceneOpen(false)}>
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label" htmlFor="scene-name">
              Scene name
            </label>
            <input
              id="scene-name"
              className="input"
              value={newSceneName}
              onChange={(e) => setNewSceneName(e.target.value)}
              placeholder="Level 2"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createScene();
              }}
            />
          </div>
          <p>A “Main Camera” entity is added automatically.</p>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setNewSceneOpen(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void createScene()} disabled={!newSceneName.trim()}>
            Create scene
          </button>
        </div>
      </Modal>
    </header>
  );
}
