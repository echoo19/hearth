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

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!info) return;
    const next = info.personalization;
    const previous = savedRef.current;
    savedRef.current = next;
    // Only a field still holding exactly what the server last said is
    // refreshed. Saving the name would otherwise reach over and overwrite a
    // half-typed paragraph in the box below it.
    setName((current) => (current === previous.name ? next.name : current));
    setInstructions((current) => (current === previous.instructions ? next.instructions : current));
  }, [info]);

  async function commit(field: keyof Personalization, value: string): Promise<void> {
    if (value === savedRef.current[field]) return;
    const ok = await save(field === 'name' ? { name: value } : { instructions: value });
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
          hint="A first name, a handle, whatever you would rather be called than nothing."
          control={
            <input
              id="set-personal-name"
              className="input set-field"
              value={name}
              placeholder="Not set"
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void commit('name', name)}
            />
          }
        />

        <SettingsRow
          stacked
          label="Standing instructions"
          htmlFor="set-personal-instructions"
          hint="How you like to work, in every game: what to check before it says it is done, what you never want it to touch, how much to explain."
          control={
            <textarea
              id="set-personal-instructions"
              className="textarea set-textarea"
              value={instructions}
              placeholder="Anything that is true of every project, not just this one."
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
