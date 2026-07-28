/**
 * Naming a project that doesn't exist yet.
 *
 * Home makes projects the other way round — the first message names the folder,
 * so nobody is ever asked to fill in a form before they can say anything. From
 * the rail there is no message to take a name from, so this asks for one, and
 * asks for exactly one thing: a project is a game is a folder, and a folder
 * needs a name and nothing else.
 *
 * The dialog owns the request rather than handing the name back to the rail,
 * because the only honest place to show a refusal is next to the name that
 * caused it. A create that fails keeps the dialog, the typed name, and the
 * server's own reason; the dialog closes only once a folder really exists.
 */
import React, { useEffect, useRef, useState } from 'react';
import { apiCreateWorkspace } from '../../api';
import { Modal } from '../ui';
import { Button } from '../ui/Button';

/**
 * When Create is live: a name with something in it, and no request already out.
 * Pure, because the rule outlives the markup — and "something in it" means
 * after trimming, since a folder called "   " is nobody's intent.
 */
export function canCreateProject(name: string, busy: boolean): boolean {
  return name.trim() !== '' && !busy;
}

export function NewProjectDialog({
  open,
  onCancel,
  onCreated,
}: {
  open: boolean;
  onCancel: () => void;
  /** The new folder, once it exists on disk and the server has opened it. */
  onCreated: (path: string) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped every time the dialog opens or closes, so a reply that lands after
  // someone gave up on the dialog can't navigate the app out from under them.
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    if (!open) return;
    // Every opening starts clean: a name typed into a dialog that was closed
    // belongs to a decision already abandoned.
    setName('');
    setBusy(false);
    setError(null);
    // Effects run child-first, so Modal has already called showModal() (which
    // focuses the first focusable itself) by the time this lands — the field
    // is what should have the caret, and it wins by going last.
    inputRef.current?.focus();
  }, [open]);

  async function create(): Promise<void> {
    if (!canCreateProject(name, busy)) return;
    const mine = generation.current;
    setBusy(true);
    setError(null);
    const result = await apiCreateWorkspace(undefined, name.trim());
    if (mine !== generation.current) return; // the dialog was closed meanwhile
    setBusy(false);
    if (!result.ok || !result.info) {
      setError(result.error ?? 'Could not create that project.');
      return;
    }
    onCreated(result.info.path);
  }

  return (
    <Modal open={open} title="New project" onClose={onCancel}>
      {/* A form, so Enter in the field means the same as pressing Create —
          this is a one-field question and reaching for the mouse to answer it
          would be the wrong shape. Escape is the dialog's own cancel. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="modal-body new-project-body">
          <div className="form-field">
            <label className="field-label" htmlFor="new-project-name">
              Project name
            </label>
            <input
              ref={inputRef}
              id="new-project-name"
              className="input"
              value={name}
              placeholder="Lighthouse"
              autoComplete="off"
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </div>
          <p className="new-project-note">
            A folder with this name is made under ~/Hearth and opened here. Everything the game is made of lives in
            it.
          </p>
          {/* The server's own words, where the name that caused them still is.
              role="alert" because nothing else on screen moved: the dialog is
              still open, so a reader is owed the reason out loud. */}
          {error !== null && (
            <p className="new-project-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!canCreateProject(name, busy)}>
            {busy ? 'Creating…' : 'Create project'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
