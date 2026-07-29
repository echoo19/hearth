/**
 * Personalization: the things that are about you rather than about a game.
 *
 * A project already has its own AGENTS.md — the instructions that belong to
 * that game and get committed with it. This is the other half: the things that
 * are true no matter what you are making, which you would otherwise retype at
 * the top of every project's file. They live in `~/.hearth`, outside any game
 * folder, so they follow you.
 *
 * Editing is in place and saves on blur, the same way project instructions do.
 * There is no Save button because there is nothing to confirm; the only
 * failure worth showing is that the write did not land.
 *
 * HONESTY, up front and in the lead where it cannot be missed. Both backends
 * now put these in the agent's system prompt when a conversation binds, so the
 * lead says they are in effect. It also says the two things that are true and
 * would otherwise look like bugs: a conversation already open keeps what it
 * bound with, and a project's own instructions outrank these. Neither is worth
 * hiding to make the pane read more confidently.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { Personalization } from '../../api';
import { useApp } from '../../store';
import { SettingsGroup, SettingsRow } from './SettingsRow';

/**
 * What the server will actually keep. `writeName` and `writeInstructions` in
 * server/personalization.ts slice to these before writing, so anything past
 * them was never saved.
 *
 * Mirrored here rather than imported because this bundle does not reach into
 * server code, and stated rather than left implicit because leaving it implicit
 * is what caused the bug: neither control had a `maxLength`, neither hint named
 * a limit, and a long paste was silently cut in half on its way to disk while
 * the box went on showing the whole thing. tests/personalizationLimits.test.ts
 * fails if these two ever drift from the server's own.
 */
export const MAX_NAME = 60;
export const MAX_INSTRUCTIONS = 20_000;

/**
 * When the counter under the instructions box appears.
 *
 * Not always: a character count over an empty box is a demand for brevity, and
 * this field wants the opposite. It shows up only once the limit is near
 * enough to be worth knowing about.
 */
export const COUNTER_FROM = MAX_INSTRUCTIONS - 2_000;

export function PersonalizationPane() {
  const info = useApp((s) => s.personalization);
  const load = useApp((s) => s.loadPersonalization);
  const save = useApp((s) => s.savePersonalization);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  // What the server last confirmed. A save is skipped when nothing changed,
  // and it is what tells an arriving value whether a field is safe to replace.
  const savedRef = useRef<Personalization>({ name: '', instructions: '' });
  // Fields with a save in flight. The server normalizes what it stores (it
  // slices to the limits above, folds CRLF and trims), so what comes back is
  // not always what went out, and for these fields the answer is authoritative
  // rather than merely newer. Without this the reconcile below compared the
  // typed text against the PRE-save value, found them different, kept the
  // typed text, and left the box displaying something the disk did not have.
  const pendingRef = useRef<Set<keyof Personalization>>(new Set());

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!info) return;
    const next = info.personalization;
    const previous = savedRef.current;
    const awaiting = pendingRef.current;
    pendingRef.current = new Set();
    savedRef.current = next;
    // A field this pane just saved takes the server's answer, whatever it is:
    // that answer IS what is on disk. Any other field is refreshed only while
    // it still holds exactly what the server last said, so saving the name
    // cannot reach over and overwrite a half-typed paragraph below it.
    setName((current) => (awaiting.has('name') || current === previous.name ? next.name : current));
    setInstructions((current) =>
      awaiting.has('instructions') || current === previous.instructions ? next.instructions : current,
    );
  }, [info]);

  async function commit(field: keyof Personalization, value: string): Promise<void> {
    if (value === savedRef.current[field]) return;
    pendingRef.current.add(field);
    const ok = await save(field === 'name' ? { name: value } : { instructions: value });
    // A failed write stored nothing, so there is no authoritative answer to
    // take and the field keeps what the user typed.
    if (!ok) pendingRef.current.delete(field);
    setError(ok ? null : 'Could not save that to ~/.hearth.');
  }

  return (
    <>
      <h2 className="set-pane-title">Personalization</h2>
      <p className="set-pane-lead">
        These belong to you rather than to one game, so they are the same in everything you make. Hearth saves them to{' '}
        <span className="mono">~/.hearth</span> and gives them to the agent at the start of a conversation, so one that
        is already open keeps what it started with. A project’s own instructions are more specific, and win wherever the
        two disagree.
      </p>

      <SettingsGroup title="About you">
        <SettingsRow
          label="What to call you"
          htmlFor="set-personal-name"
          hint={`A first name, a handle, whatever you would rather be called than nothing. Up to ${MAX_NAME} characters.`}
          control={
            <input
              id="set-personal-name"
              className="input set-field"
              value={name}
              placeholder="Not set"
              autoComplete="off"
              // The limit the server enforces anyway, enforced here as well so
              // that what is on screen is what is on disk. Silently dropping
              // the tail of a paste and then displaying it is worse than not
              // accepting it: the user has no way to tell the two apart.
              maxLength={MAX_NAME}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void commit('name', name)}
            />
          }
        />

        <SettingsRow
          stacked
          label="Standing instructions"
          htmlFor="set-personal-instructions"
          hint={
            <>
              How you like to work, in every game: what to check before it says it is done, what you never want it to
              touch, how much to explain. Up to {MAX_INSTRUCTIONS.toLocaleString()} characters, which is far more than
              anyone needs.
              {instructions.length >= COUNTER_FROM && (
                <span className="set-personal-count">
                  {instructions.length.toLocaleString()} of {MAX_INSTRUCTIONS.toLocaleString()} used.
                </span>
              )}
            </>
          }
          control={
            <textarea
              id="set-personal-instructions"
              className="textarea set-textarea"
              value={instructions}
              placeholder="Anything that is true of every project, not just this one."
              maxLength={MAX_INSTRUCTIONS}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={() => void commit('instructions', instructions)}
            />
          }
        />

        <SettingsRow
          label="Where these are kept"
          hint={
            info ? (
              <>
                <span className="mono">{info.files.name}</span> and <span className="mono">{info.files.instructions}</span>.
                Plain files. Edit them anywhere.
              </>
            ) : (
              'Reading ~/.hearth.'
            )
          }
        />
      </SettingsGroup>

      {error && (
        <p className="set-status" role="status">
          {error}
        </p>
      )}
    </>
  );
}
