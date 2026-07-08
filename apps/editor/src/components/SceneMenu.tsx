/**
 * Toolbar scene actions menu: the ⋯ button next to the scene picker.
 * Duplicate / Rename / Set as initial / Delete for the currently selected
 * scene. Popover mechanics (click-outside / Escape) mirror ViewMenu; the
 * duplicate/rename forms mirror the "+ Scene" modal in Toolbar.tsx.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { uniqueName } from '../uniqueName';
import { ConfirmDialog, Icon, Modal } from './ui';

export function SceneMenu() {
  const info = useEditor((s) => s.info);
  const sceneId = useEditor((s) => s.sceneId);
  const selectScene = useEditor((s) => s.selectScene);
  const exec = useEditor((s) => s.exec);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

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

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

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
    setOpen(false);
  }

  function openRename() {
    if (!scene) return;
    setRenameName(scene.name);
    setRenameError(null);
    setRenameOpen(true);
    setOpen(false);
  }

  async function setInitial() {
    setOpen(false);
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
    setDeleteOpen(false);
    if (!scene) return;
    // deleteScene reassigns initialScene server-side when the deleted scene
    // was it; the store's refresh() (run by exec() after every mutation)
    // already falls back sceneId to info.initialScene when the current
    // sceneId no longer exists, so deleting the active scene lands on the
    // (possibly new) initial scene with no extra bookkeeping here.
    await exec('deleteScene', { scene: scene.id });
  }

  return (
    <span className="menu-root" ref={rootRef}>
      <button
        ref={buttonRef}
        className="btn btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Scene actions"
        title="Scene actions"
        disabled={!scene}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" />
      </button>
      {open && scene && (
        <div className="menu-popover" role="menu" aria-label="Scene actions">
          <button className="menu-item" role="menuitem" onClick={openDuplicate}>
            <span className="menu-check" aria-hidden="true" />
            Duplicate…
          </button>
          <button className="menu-item" role="menuitem" onClick={openRename}>
            <span className="menu-check" aria-hidden="true" />
            Rename…
          </button>
          <button className="menu-item" role="menuitem" disabled={isInitial} onClick={() => void setInitial()}>
            <span className="menu-check" aria-hidden="true">
              {isInitial ? '★' : ''}
            </span>
            Set as initial
          </button>
          <div className="menu-separator" role="separator" />
          <button
            className="menu-item menu-item-danger"
            role="menuitem"
            disabled={onlyScene}
            title={onlyScene ? 'Cannot delete the only scene in a project' : undefined}
            onClick={() => {
              setDeleteOpen(true);
              setOpen(false);
            }}
          >
            <span className="menu-check" aria-hidden="true" />
            Delete…
          </button>
        </div>
      )}

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

      <ConfirmDialog
        open={deleteOpen}
        title={`Delete “${scene?.name ?? ''}”?`}
        body="This removes the scene file from the project. This mutation is recorded like any other command; checkpoint first if you want an undo point."
        confirmLabel="Delete scene"
        danger
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void confirmDelete()}
      />
    </span>
  );
}
