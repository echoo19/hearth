/**
 * Toolbar scene actions menu: the ⋯ button next to the scene picker.
 * Duplicate / Rename / Set as initial / Delete for the currently selected
 * scene. The popover mechanics (open/close, click-outside, Escape, arrow-key
 * focus) come from the shared MenuButton primitive; this file only declares the
 * items and owns the duplicate/rename/delete modals (which mirror the "+ Scene"
 * modal in Toolbar.tsx).
 */
import React, { useState } from 'react';
import { useEditor } from '../store';
import { uniqueName } from '../uniqueName';
import { Icon, Modal } from './ui';
import { MenuButton, type MenuItem } from './ui/Menu';

export function SceneMenu() {
  const info = useEditor((s) => s.info);
  const sceneId = useEditor((s) => s.sceneId);
  const selectScene = useEditor((s) => s.selectScene);
  const exec = useEditor((s) => s.exec);

  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [duplicateName, setDuplicateName] = useState('');
  const [duplicateWithPlaytests, setDuplicateWithPlaytests] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const scenes = info?.scenes ?? [];
  const scene = scenes.find((s) => s.id === sceneId) ?? null;
  const isInitial = scene !== null && info?.initialScene === scene.id;
  const onlyScene = scenes.length <= 1;

  function openDuplicate() {
    if (!scene) return;
    setDuplicateName(uniqueName(scenes.map((s) => s.name), `${scene.name} copy`));
    setDuplicateWithPlaytests(false);
    setDuplicateError(null);
    setDuplicateOpen(true);
  }

  function openRename() {
    if (!scene) return;
    setRenameName(scene.name);
    setRenameError(null);
    setRenameOpen(true);
  }

  async function setInitial() {
    if (!scene || isInitial) return;
    await exec('setInitialScene', { scene: scene.id });
  }

  async function confirmDuplicate() {
    if (!scene) return;
    const name = duplicateName.trim();
    if (!name) return;
    setDuplicating(true);
    setDuplicateError(null);
    const result = await exec<{ sceneId: string }>('duplicateScene', {
      scene: scene.id,
      newName: name,
      withPlaytests: duplicateWithPlaytests,
    });
    setDuplicating(false);
    if (result.success && result.data) {
      setDuplicateOpen(false);
      await selectScene(result.data.sceneId);
    } else {
      setDuplicateError(result.errors[0]?.message ?? 'Could not duplicate the scene.');
    }
  }

  async function confirmRename() {
    if (!scene) return;
    const name = renameName.trim();
    if (!name || name === scene.name) {
      setRenameOpen(false);
      return;
    }
    setRenaming(true);
    setRenameError(null);
    const result = await exec('renameScene', { scene: scene.id, newName: name });
    setRenaming(false);
    if (result.success) {
      setRenameOpen(false);
    } else {
      setRenameError(result.errors[0]?.message ?? 'Could not rename the scene.');
    }
  }

  async function confirmDelete() {
    if (!scene) return;
    setDeleting(true);
    setDeleteError(null);
    // deleteScene reassigns initialScene server-side when the deleted scene
    // was it; the store's refresh() (run by exec() after every mutation)
    // already falls back sceneId to info.initialScene when the current
    // sceneId no longer exists, so deleting the active scene lands on the
    // (possibly new) initial scene with no extra bookkeeping here.
    const result = await exec('deleteScene', { scene: scene.id });
    setDeleting(false);
    if (result.success) {
      setDeleteOpen(false);
    } else {
      setDeleteError(result.errors[0]?.message ?? 'Could not delete the scene.');
    }
  }

  const items: MenuItem[] = [
    { label: 'Duplicate…', onSelect: openDuplicate },
    { label: 'Rename…', onSelect: openRename },
    // "This is the initial scene" is exactly what `checked` models; disabled
    // once it already is, so this reads as a one-way toggle.
    { label: 'Set as initial', checked: isInitial, disabled: isInitial, onSelect: () => void setInitial() },
    { separator: true },
    {
      label: 'Delete…',
      danger: true,
      disabled: onlyScene,
      disabledReason: onlyScene ? 'Cannot delete the only scene in a project' : undefined,
      onSelect: () => {
        setDeleteError(null);
        setDeleteOpen(true);
      },
    },
  ];

  return (
    <>
      <MenuButton trigger={<Icon name="more" />} label="Scene actions" items={items} disabled={!scene} />

      <Modal open={duplicateOpen} title="Duplicate scene" onClose={() => setDuplicateOpen(false)}>
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label" htmlFor="duplicate-scene-name">
              New scene name
            </label>
            <input
              id="duplicate-scene-name"
              className={`input${duplicateError ? ' invalid' : ''}`}
              value={duplicateName}
              autoFocus
              onChange={(e) => {
                setDuplicateName(e.target.value);
                setDuplicateError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmDuplicate();
              }}
            />
            {duplicateError && <span className="field-error">{duplicateError}</span>}
          </div>
          <label className="input-checkbox-label">
            <input
              type="checkbox"
              checked={duplicateWithPlaytests}
              onChange={(e) => setDuplicateWithPlaytests(e.target.checked)}
            />
            Also copy playtests targeting this scene
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setDuplicateOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void confirmDuplicate()}
            disabled={!duplicateName.trim() || duplicating}
          >
            {duplicating ? 'Duplicating…' : 'Duplicate scene'}
          </button>
        </div>
      </Modal>

      <Modal open={renameOpen} title="Rename scene" onClose={() => setRenameOpen(false)}>
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label" htmlFor="rename-scene-name">
              Scene name
            </label>
            <input
              id="rename-scene-name"
              className={`input${renameError ? ' invalid' : ''}`}
              value={renameName}
              autoFocus
              onChange={(e) => {
                setRenameName(e.target.value);
                setRenameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmRename();
              }}
            />
            {renameError && <span className="field-error">{renameError}</span>}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setRenameOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void confirmRename()}
            disabled={!renameName.trim() || renaming}
          >
            {renaming ? 'Renaming…' : 'Rename scene'}
          </button>
        </div>
      </Modal>

      <Modal open={deleteOpen} title={`Delete "${scene?.name ?? ''}"?`} onClose={() => setDeleteOpen(false)}>
        <div className="modal-body">
          <p>This removes the scene file from the project. It shows up in your undo history, so Ctrl/Cmd+Z brings it back.</p>
          {deleteError && (
            <span className="field-error">
              Couldn't delete "{scene?.name ?? ''}": {deleteError}
            </span>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setDeleteOpen(false)}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={() => void confirmDelete()} disabled={deleting} autoFocus>
            {deleting ? 'Deleting…' : 'Delete scene'}
          </button>
        </div>
      </Modal>
    </>
  );
}
