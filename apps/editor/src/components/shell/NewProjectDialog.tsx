/**
 * Naming a project that doesn't exist yet. The ONE place that asks.
 *
 * There used to be two ways to make a project and only one of them asked. The
 * rail asked; a first message with nowhere to land did not, and the server
 * named the folder off the sentence you had typed. So "a game where a raccoon
 * steals bins" became a folder you had not chosen, and the name is the one
 * thing about a project that is hard to change afterwards. Both routes come
 * here now, and the message route arrives with a draft of the answer already
 * in the field and selected, so it is still one keystroke to accept.
 *
 * The dialog owns the request rather than handing the name back to its caller,
 * because the only honest place to show a refusal is next to the name that
 * caused it. A create that fails keeps the dialog, the typed name, and the
 * server's own reason; it closes only once a folder really exists.
 *
 * Mounted once, at the shell, driven by `naming` in the store — so neither
 * asker owns it and the two can never drift apart.
 */
import React, { useEffect, useRef, useState } from 'react';
import { apiCreateWorkspace } from '../../api';
import { useApp } from '../../store';
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

/**
 * The shell's single instance. Everything that wants a project asks the store
 * (`askProjectName`) and waits; this is what answers.
 */
export function ProjectNamer() {
  const naming = useApp((s) => s.naming);
  const answer = useApp((s) => s.answerProjectName);
  return (
    <NewProjectDialog
      open={naming !== null}
      suggestion={naming?.suggestion ?? ''}
      onCancel={() => answer(null)}
      onCreated={(path) => answer(path)}
    />
  );
}

export function NewProjectDialog({
  open,
  suggestion = '',
  onCancel,
  onCreated,
}: {
  open: boolean;
  /**
   * A first draft of the name, from whatever the person was already saying.
   * Arrives selected, so accepting it is Enter and replacing it is typing.
   */
  suggestion?: string;
  onCancel: () => void;
  /** The new folder, once it exists on disk and the server has opened it. */
  onCreated: (path: string) => void;
}) {
  const [name, setName] = useState(suggestion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped every time the dialog opens or closes, so a reply that lands after
  // someone gave up on the dialog can't navigate the app out from under them.
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    if (!open) return;
    // Every opening starts from the draft it was given, and nothing else: a
    // name typed into a dialog that was closed belongs to a decision already
    // abandoned.
    setName(suggestion);
    setBusy(false);
    setError(null);
    // Effects run child-first, so Modal has already called showModal() (which
    // focuses the first focusable itself) by the time this lands — the field
    // is what should have the caret, and it wins by going last.
    inputRef.current?.focus();
    // Selected, not just filled. A draft you have to clear before you can
    // disagree with it is a draft that gets accepted by default.
    if (suggestion !== '') inputRef.current?.select();
  }, [open, suggestion]);

  async function create(): Promise<void> {
    if (!canCreateProject(name, busy)) return;
    const mine = generation.current;
    setBusy(true);
    setError(null);
    // This await cannot reject: postJson answers a server it could not reach
    // as `ok: false` with the reason in words (see api.ts). That is what keeps
    // the lines below reachable — a throw here once left the button on
    // "Creating…" forever, with no error and no way to retry.
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
          {/* What it used to say was "A folder with this name is made under
              ~/Hearth", and that was not true: the folder is a plain ASCII
              slug of the name, so a name written in Korean produced a folder
              called `new-game` and a promise the app had just broken. It says
              what happens now. */}
          <p className="new-project-note">
            Hearth calls the project this, exactly as you type it. The folder it makes under ~/Hearth uses a plainer
            version of the name. Everything the game is made of lives in there.
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
