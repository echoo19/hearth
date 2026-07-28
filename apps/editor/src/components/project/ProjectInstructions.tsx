/**
 * Standing instructions for a project — the things you would otherwise retype
 * at the top of every conversation.
 *
 * Written to the project's own `AGENTS.md`, not to a Hearth-only store, for
 * one reason that matters more than tidiness: both agents Hearth ships read
 * that file on their own, and so does whatever CLI agent someone runs in the
 * terminal here. Putting the text anywhere else would mean it only worked
 * inside this app, which is exactly the kind of lock-in the project format
 * exists to avoid.
 *
 * Editing is in place and saves on blur. There is no Save button because there
 * is nothing to confirm: this is a text file, and the only failure mode worth
 * showing is that the write did not land.
 */
import React, { useEffect, useRef, useState } from 'react';
import { apiProjectDoc, apiWriteProjectDoc } from '../../api';
import { Icon } from '../ui';

/** Where the text lives, relative to the project root. Shown to the user. */
export const INSTRUCTIONS_FILE = 'AGENTS.md';

export function ProjectInstructions({ projectPath }: { projectPath: string }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // What the server last confirmed, so a save is skipped when nothing changed
  // and a failed one can say what it failed to replace.
  const savedRef = useRef('');

  useEffect(() => {
    let live = true;
    void apiProjectDoc(projectPath, INSTRUCTIONS_FILE).then((body) => {
      if (!live) return;
      setText(body ?? '');
      savedRef.current = body ?? '';
    });
    return () => {
      live = false;
    };
  }, [projectPath]);

  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  async function commit(): Promise<void> {
    setEditing(false);
    if (text === savedRef.current) return;
    const ok = await apiWriteProjectDoc(projectPath, INSTRUCTIONS_FILE, text);
    if (ok) {
      savedRef.current = text;
      setError(null);
    } else {
      setError(`Could not write ${INSTRUCTIONS_FILE}.`);
    }
  }

  return (
    <section className="proj-card" aria-label="Instructions">
      <header className="proj-card-head">
        <h2 className="proj-card-title">Instructions</h2>
        {!editing && (
          <button type="button" className="proj-card-add" aria-label="Edit instructions" onClick={() => setEditing(true)}>
            <Icon name={text.trim() === '' ? 'plus' : 'pencil'} size={12} />
          </button>
        )}
      </header>

      {editing ? (
        <textarea
          ref={areaRef}
          className="proj-instructions-edit"
          value={text}
          placeholder={`Anything the agent should know every time. Saved to ${INSTRUCTIONS_FILE}.`}
          aria-label="Instructions"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setText(savedRef.current);
              setEditing(false);
            }
          }}
        />
      ) : text.trim() === '' ? (
        <p className="proj-card-hint">Add instructions to shape how the agent works on this game.</p>
      ) : (
        // Click-to-edit rather than an always-live textarea: this is read far
        // more often than it is changed, and a box with a cursor in it invites
        // an accidental keystroke into the thing every future turn reads.
        <button type="button" className="proj-instructions-read" onClick={() => setEditing(true)}>
          {text}
        </button>
      )}

      {error && (
        <p className="proj-card-error" role="status">
          {error}
        </p>
      )}
      <p className="proj-card-note">
        <span className="mono">{INSTRUCTIONS_FILE}</span> is read by every agent, not just Hearth
      </p>
    </section>
  );
}
