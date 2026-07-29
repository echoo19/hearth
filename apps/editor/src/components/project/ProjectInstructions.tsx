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
 *
 * The resting view is CLIPPED, and it has to be. AGENTS.md is a file people
 * grow: a few hundred lines is ordinary, and rendered whole this card ran past
 * eight thousand pixels tall, which pushed every other card on the project
 * screen below the fold and turned one long paragraph into the whole page.
 * Clipping is only honest if the rest is reachable, so it says how much it is
 * holding back and opens on a press.
 */
import React, { useEffect, useRef, useState } from 'react';
import { apiProjectDoc, apiWriteProjectDoc } from '../../api';
import { Icon } from '../ui';

/** Where the text lives, relative to the project root. Shown to the user. */
export const INSTRUCTIONS_FILE = 'AGENTS.md';

export function ProjectInstructions({ projectPath }: { projectPath: string }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Whether the resting view is actually holding something back. Measured
  // rather than guessed from the character count: what overflows depends on
  // the card's width and the reader's font size, and a "Read all" offered over
  // text that is entirely visible is a control that does nothing.
  const [clipped, setClipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
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

  // Re-measured on width as well as on text: the same instructions clip on a
  // narrow window and fit on a wide one.
  useEffect(() => {
    const box = readRef.current;
    if (!box || editing) return;
    const measure = (): void => setClipped(box.scrollHeight > box.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text, editing, expanded]);

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
        //
        // A div with a click handler and no role, deliberately. It was a
        // <button>, which meant a screen reader announced the entire file as
        // one enormous button label and offered no way to read it as prose.
        // Editing has its own real button in the header, which is where an
        // assistive user was always going to find it.
        <>
          <div
            ref={readRef}
            className={`proj-instructions-read${expanded ? ' is-open' : ''}`}
            onClick={() => setEditing(true)}
          >
            {text}
          </div>
          {(clipped || expanded) && (
            <button
              type="button"
              className="proj-instructions-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? 'Show less' : 'Read all of it'}
            </button>
          )}
        </>
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
