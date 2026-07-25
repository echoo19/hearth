/**
 * Inspector control for Text.binding — a nullable `{ key, format, precision }`
 * group (TextBindingSchema in @hearth/core) that mirrors a declared game-state
 * value into the label every frame. Lives in its own file for the same reason
 * PostEffectsField does: it's a structured component field with more than one
 * input and its own empty/unavailable states.
 *
 * The key is a DROPDOWN of the project's declared `gameState` keys, never a
 * text input — a mistyped key is exactly the failure this binding exists to
 * remove (core's validator reports UNDECLARED_STATE_KEY for it), so the
 * Inspector should make it unrepresentable rather than catch it later. When
 * the project declares no keys at all, the control says so instead of showing
 * an empty dropdown that looks broken.
 *
 * Every change commits the WHOLE binding object (or null to unbind) through
 * one setComponentProperty on `Text.binding` — see ../textBinding for why, and
 * for the bind/unbind logic itself, which lives there so it stays testable
 * without a DOM.
 */
import React from 'react';
import type { GameStateEntry } from '../types';
import {
  BINDING_PRECISION_MAX,
  BINDING_PRECISION_MIN,
  BINDING_VALUE_TOKEN,
  formatShowsValue,
  newBinding,
  precisionApplies,
  withBindingField,
  type TextBinding,
} from '../textBinding';
import { NumberField, TextField } from './ui';

/** "score (number)" — the declared type is what decides whether precision applies. */
function keyLabel(key: string, entry: GameStateEntry | undefined): string {
  return entry ? `${key} (${entry.type})` : key;
}

function BindingRow({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    // Nested-row grid with a tighter label track than PostEffects' 84px
    // default: these rows sit inside Text's control column AND inside the
    // indented bound-group body, so the standard track would starve the
    // control down to a few characters (see .editor-row--nested's comment).
    <div
      className="inspector-row editor-row--nested"
      style={{ '--nested-label-w': '56px' } as React.CSSProperties}
    >
      <label className="field-label" title={title}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function TextBindingField({
  value,
  gameState,
  onCommit,
}: {
  /** The current binding, or null when the label's content is script-owned. */
  value: TextBinding | null;
  /** The project's declared gameState (hearth.json), keyed by state key. */
  gameState: Record<string, GameStateEntry>;
  /** Commits the whole `Text.binding` value: an object to bind, null to unbind. */
  onCommit: (next: TextBinding | null) => void;
}) {
  const keys = Object.keys(gameState);
  // A binding whose key is no longer declared (gameState edited out from under
  // it, or authored by hand) still has to be selectable in the dropdown —
  // otherwise the <select> would silently present someone else's key as this
  // entity's binding. It's offered as a marked, disabled option instead.
  const staleKey = value !== null && !Object.prototype.hasOwnProperty.call(gameState, value.key);
  const entry = value ? gameState[value.key] : undefined;

  // No declared keys: nothing to bind TO. Say that, rather than render a
  // toggle that can only produce an invalid binding.
  if (keys.length === 0 && value === null) {
    return (
      <span className="field-fallback-note">
        This project declares no game state, so there's nothing to bind to. Add a key under{' '}
        <span className="mono">gameState</span> in hearth.json (e.g.{' '}
        <span className="mono">score</span>) and it shows up here.
      </span>
    );
  }

  return (
    <div className="text-binding">
      <label className="text-binding-toggle">
        <input
          type="checkbox"
          checked={value !== null}
          onChange={(e) => onCommit(e.target.checked ? newBinding(keys[0] ?? '') : null)}
        />
        <span>{value !== null ? 'Bound to game state' : 'Bind to game state'}</span>
      </label>
      {value === null ? (
        <span className="field-fallback-note">
          Content is script-owned: nothing overwrites it each frame.
        </span>
      ) : (
        <div className="text-binding-body">
          <BindingRow label="Key" title="Text.binding.key">
            <select
              className="select"
              value={value.key}
              onChange={(e) => onCommit(withBindingField(value, 'key', e.target.value))}
            >
              {staleKey && (
                <option value={value.key} disabled>
                  {value.key} (not declared)
                </option>
              )}
              {keys.map((key) => (
                <option key={key} value={key}>
                  {keyLabel(key, gameState[key])}
                </option>
              ))}
            </select>
          </BindingRow>
          {staleKey && (
            <span className="field-error">
              "{value.key}" isn't declared in hearth.json gameState, so this label stays blank at
              runtime. Pick a declared key.
            </span>
          )}
          <BindingRow label="Format" title="Text.binding.format">
            <TextField
              value={value.format}
              placeholder={BINDING_VALUE_TOKEN}
              onCommit={(next) => onCommit(withBindingField(value, 'format', next))}
            />
          </BindingRow>
          {!formatShowsValue(value.format) && (
            <span className="field-fallback-note">
              No <span className="mono">{BINDING_VALUE_TOKEN}</span> in the format, so the label
              shows this text unchanged.
            </span>
          )}
          {/* Precision is dead weight for a boolean or string key (the schema
              says as much), so it's hidden rather than offered as a knob that
              provably does nothing — same reasoning as the Respawn point /
              spawn-position pairing in Inspector.tsx. */}
          {precisionApplies(entry) ? (
            <BindingRow label="Precision" title="Text.binding.precision">
              <NumberField
                value={value.precision}
                min={BINDING_PRECISION_MIN}
                max={BINDING_PRECISION_MAX}
                integer
                onCommit={(next) => onCommit(withBindingField(value, 'precision', next))}
              />
            </BindingRow>
          ) : (
            <span className="field-fallback-note">
              Precision applies to number keys only; "{value.key}" is a {entry?.type}.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
