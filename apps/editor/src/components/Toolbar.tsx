import React, { useState } from 'react';
import { useEditor } from '../store';
import { Icon, Modal } from './ui';

export function Toolbar() {
  const info = useEditor((s) => s.info);
  const sceneId = useEditor((s) => s.sceneId);
  const playing = useEditor((s) => s.playing);
  const selectScene = useEditor((s) => s.selectScene);
  const setPlaying = useEditor((s) => s.setPlaying);
  const setBottomTab = useEditor((s) => s.setBottomTab);
  const refreshDiff = useEditor((s) => s.refreshDiff);
  const exec = useEditor((s) => s.exec);
  const closeProject = useEditor((s) => s.closeProject);
  const log = useEditor((s) => s.log);

  const [newSceneOpen, setNewSceneOpen] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');

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
      log('info', 'command', 'Snapshot saved — the Diff panel now compares against this baseline.');
    }
  }

  return (
    <header className="toolbar">
      <span className="wordmark">
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Icon name="flame" size={16} />
        </span>
        Hearth
      </span>
      <span className="project-name" title={info?.description || info?.name}>
        {info?.name}
      </span>

      <span className="divider" />

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
      <button className="btn btn-sm" onClick={() => setNewSceneOpen(true)} title="New scene">
        <Icon name="plus" /> Scene
      </button>

      <span className="divider" />

      <button
        className={playing ? 'btn btn-sm' : 'btn btn-primary btn-sm'}
        onClick={() => setPlaying(!playing)}
        title={playing ? 'Stop the preview' : 'Play the current scene in the Game tab'}
      >
        <Icon name={playing ? 'stop' : 'play'} /> {playing ? 'Stop' : 'Play'}
      </button>

      <span className="divider" />

      <button className="btn btn-sm" onClick={() => void snapshot()} title="Save the diff baseline (snapshotProject)">
        Snapshot
      </button>
      <button
        className="btn btn-sm"
        onClick={() => {
          setBottomTab('diff');
          void refreshDiff();
        }}
        title="Show changes since the last snapshot"
      >
        Diff
      </button>

      <span className="spacer" />

      <span className="save-note">Every change saves automatically</span>
      <button className="btn btn-ghost btn-sm" onClick={closeProject}>
        Close project
      </button>

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
