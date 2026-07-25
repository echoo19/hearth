// @vitest-environment jsdom
/**
 * Text.binding's Inspector control — a nullable { key, format, precision }
 * group. These pin the properties that make it worth having over the generic
 * value-driven path: the key is a DROPDOWN of declared gameState keys (never a
 * text input, which is the typo class the binding exists to remove), a project
 * with no declared keys explains itself instead of showing an empty dropdown,
 * precision hides for non-number keys, and every write commits the whole
 * binding object (or null) rather than a nested path into a nullable field.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { TextBindingField } from '../src/components/TextBindingField';
import {
  formatShowsValue,
  isTextBinding,
  newBinding,
  precisionApplies,
  withBindingField,
} from '../src/textBinding';
import type { GameStateEntry } from '../src/types';
import type { TextBinding } from '../src/textBinding';

afterEach(() => cleanup());

const GAME_STATE: Record<string, GameStateEntry> = {
  score: { type: 'number', initial: 0, persist: false },
  lives: { type: 'number', initial: 3, persist: false },
  playerName: { type: 'string', initial: 'Ember', persist: true },
};

function field(value: TextBinding | null, gameState = GAME_STATE) {
  const onCommit = vi.fn();
  render(<TextBindingField value={value} gameState={gameState} onCommit={onCommit} />);
  return { onCommit };
}

describe('textBinding helpers', () => {
  it('recognizes a binding object and rejects everything else', () => {
    expect(isTextBinding({ key: 'score', format: '{value}', precision: 0 })).toBe(true);
    expect(isTextBinding(null)).toBe(false);
    expect(isTextBinding({ key: 'score' })).toBe(false);
    expect(isTextBinding([{ key: 'score', format: '', precision: 0 }])).toBe(false);
  });

  it('newBinding matches TextBindingSchema defaults', () => {
    expect(newBinding('score')).toEqual({ key: 'score', format: '{value}', precision: 0 });
  });

  it('withBindingField replaces one field without mutating the original', () => {
    const binding = newBinding('score');
    expect(withBindingField(binding, 'precision', 2)).toEqual({
      key: 'score',
      format: '{value}',
      precision: 2,
    });
    expect(binding.precision).toBe(0);
  });

  it('precision applies to number keys, and to an undeclared key we cannot judge', () => {
    expect(precisionApplies({ type: 'number', initial: 0, persist: false })).toBe(true);
    expect(precisionApplies({ type: 'string', initial: '', persist: false })).toBe(false);
    expect(precisionApplies({ type: 'boolean', initial: false, persist: false })).toBe(false);
    expect(precisionApplies(undefined)).toBe(true);
  });

  it('formatShowsValue detects a missing {value} placeholder', () => {
    expect(formatShowsValue('Score: {value}')).toBe(true);
    expect(formatShowsValue('Score')).toBe(false);
  });
});

describe('TextBindingField', () => {
  it('offers the declared gameState keys as a dropdown, not a text input', () => {
    field(newBinding('score'));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['score', 'lives', 'playerName']);
    expect(select.value).toBe('score');
  });

  it('binds by committing a whole binding object seeded with the first key', () => {
    const { onCommit } = field(null);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCommit).toHaveBeenCalledWith({ key: 'score', format: '{value}', precision: 0 });
  });

  it('unbinds by committing null', () => {
    const { onCommit } = field(newBinding('score'));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('commits the whole object when the key changes', () => {
    const { onCommit } = field({ key: 'score', format: 'Score: {value}', precision: 2 });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lives' } });
    expect(onCommit).toHaveBeenCalledWith({ key: 'lives', format: 'Score: {value}', precision: 2 });
  });

  it('commits format and precision as whole-object writes', () => {
    const { onCommit } = field(newBinding('score'));
    const format = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(format, { target: { value: 'Score: {value}' } });
    fireEvent.blur(format);
    expect(onCommit).toHaveBeenCalledWith({ key: 'score', format: 'Score: {value}', precision: 0 });

    const precision = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(precision, { target: { value: '2' } });
    fireEvent.blur(precision);
    expect(onCommit).toHaveBeenCalledWith({ key: 'score', format: '{value}', precision: 2 });
  });

  it('explains an empty gameState instead of showing an empty dropdown', () => {
    field(null, {});
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/declares no game state/i)).toBeTruthy();
  });

  it('hides precision for a non-number key and says why', () => {
    field(newBinding('playerName'));
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByText(/number keys only/i)).toBeTruthy();
  });

  it('keeps an undeclared key selectable-but-marked, with an error', () => {
    field(newBinding('scoer'));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('scoer');
    expect([...select.options].find((o) => o.value === 'scoer')?.disabled).toBe(true);
    expect(screen.getByText(/isn't declared in hearth.json/i)).toBeTruthy();
  });

  it("warns when the format has no {value} so the label can't show one", () => {
    field({ key: 'score', format: 'Score', precision: 0 });
    expect(screen.getByText(/No .*in the format/i)).toBeTruthy();
  });

  it('never renders a raw-JSON dump or textarea', () => {
    field({ key: 'score', format: '{value}', precision: 0 });
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.queryByText(/\{"/)).toBeNull();
  });
});
