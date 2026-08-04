/**
 * Tags, as things you can see and remove — not a comma-separated string.
 *
 * The string version is the tempting one to write and the wrong one to use: it
 * makes the person the parser. They have to guess whether the separator is a
 * comma or a space, whether a trailing comma makes an empty tag, and whether
 * "co-op, roguelike" has a leading space in the second one. All of that is
 * work the control should be doing, and every bit of it is invisible until the
 * listing is live and wrong.
 *
 * So: text goes in, a chip comes out, and a chip has an X. Enter and comma
 * both commit, because both are what people reach for. Backspace on an empty
 * field takes the last one back, which is the one gesture that makes a chip
 * field feel like text rather than a widget.
 *
 * Fully controlled, including the half-typed text. The parent owns that
 * because it belongs in the draft — see publishDraft.ts — and because a tag
 * typed but not committed still has to reach the server on submit.
 */
import React, { useRef } from 'react';
import { addTag, removeTag } from './publishDraft';

export function TagField({
  id,
  tags,
  text,
  onTags,
  onText,
  disabled = false,
}: {
  id: string;
  tags: readonly string[];
  /** The uncommitted text in the input. */
  text: string;
  onTags: (tags: string[]) => void;
  onText: (text: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function commit(): void {
    const next = addTag(tags, text);
    // Only announce a change when there was one: committing a blank, or a
    // duplicate, should leave the list alone rather than re-render it as new.
    if (next.length !== tags.length) onTags(next);
    // The text clears either way. A duplicate that stayed in the field would
    // look like the control had simply failed to respond.
    if (text !== '') onText('');
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter must not reach the form. This is a six-field dialog, and a
      // stray Enter while adding tags publishing the game would be the
      // single worst accident this surface could have.
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === 'Backspace' && text === '' && tags.length > 0) {
      event.preventDefault();
      onTags(tags.slice(0, -1));
    }
  }

  function drop(tag: string): void {
    onTags(removeTag(tags, tag));
    // The removed chip's button is gone, and focus with it. Without this the
    // caret lands back on <body> and the keyboard path through the form is
    // broken at exactly the point someone is using it most.
    inputRef.current?.focus();
  }

  return (
    <div className={disabled ? 'tag-field is-disabled' : 'tag-field'}>
      {tags.length > 0 && (
        <ul className="tag-chips">
          {tags.map((tag) => (
            <li className="tag-chip" key={tag}>
              <span className="tag-chip-text">{tag}</span>
              <button
                type="button"
                className="tag-chip-remove"
                // Named, because "×" read aloud on its own is a symbol, not an
                // action, and there may be six of them in a row.
                aria-label={`Remove tag ${tag}`}
                disabled={disabled}
                onClick={() => drop(tag)}
              >
                <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M3 3l6 6M9 3l-6 6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        id={id}
        className="input tag-input"
        value={text}
        disabled={disabled}
        autoComplete="off"
        placeholder={tags.length === 0 ? 'platformer, co-op, short' : 'Add another'}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={onKeyDown}
        // Committed on the way out too. Text left in the field when someone
        // tabs on is text they finished typing, and losing it silently is the
        // failure this whole control exists to avoid.
        onBlur={commit}
      />
    </div>
  );
}
