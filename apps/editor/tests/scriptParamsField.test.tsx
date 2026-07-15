// @vitest-environment jsdom
/**
 * Script.params typed key/value editor (L-034) — the last Inspector field that
 * used to fall back to a read-only raw-JSON dump. These pin: typed controls
 * per value kind, per-key writes through Script.params.<key>, whole-record
 * writes for add/remove/rename, and that NO raw-JSON escape hatch renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { ScriptParamsField, ScriptPathField } from '../src/components/Inspector';

afterEach(() => cleanup());

function paramsField(value: Record<string, unknown>) {
  const onWriteKey = vi.fn().mockResolvedValue(true);
  const onWriteAll = vi.fn();
  render(<ScriptParamsField value={value} onWriteKey={onWriteKey} onWriteAll={onWriteAll} />);
  return { onWriteKey, onWriteAll };
}

describe('ScriptParamsField', () => {
  it('renders a typed number control and writes Script.params.<key> on commit', () => {
    const { onWriteKey } = paramsField({ speed: 170 });
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe('170');
    fireEvent.change(input, { target: { value: '200' } });
    fireEvent.blur(input);
    expect(onWriteKey).toHaveBeenCalledWith('speed', 200);
  });

  it('renders a checkbox for a boolean param', () => {
    const { onWriteKey } = paramsField({ invincible: false });
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onWriteKey).toHaveBeenCalledWith('invincible', true);
  });

  it('never renders a raw-JSON textarea or a JSON dump', () => {
    paramsField({ speed: 170, nested: { a: 1 }, tags: ['x'] });
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.queryByText(/\{"/)).toBeNull();
  });

  it('adds a new param by writing the whole record', () => {
    const { onWriteAll } = paramsField({ speed: 170 });
    fireEvent.change(screen.getByPlaceholderText('New parameter'), { target: { value: 'maxHp' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(onWriteAll).toHaveBeenCalledWith({ speed: 170, maxHp: 0 });
  });

  it('removes a param by writing the whole record', () => {
    const { onWriteAll } = paramsField({ speed: 170, maxHp: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'Remove “maxHp”' }));
    expect(onWriteAll).toHaveBeenCalledWith({ speed: 170 });
  });

  it('renames a key, preserving order, via a whole-record write', () => {
    const { onWriteAll } = paramsField({ speed: 170, maxHp: 100 });
    // The key inputs are the textboxes (spinbuttons are the numeric values).
    const keyInput = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    expect(keyInput.value).toBe('speed');
    fireEvent.change(keyInput, { target: { value: 'velocity' } });
    fireEvent.blur(keyInput);
    expect(onWriteAll).toHaveBeenCalledWith({ velocity: 170, maxHp: 100 });
  });

  it('shows an empty-state hint when there are no params', () => {
    paramsField({});
    expect(screen.getByText('No parameters')).toBeTruthy();
  });
});

describe('ScriptPathField', () => {
  it('lists project scripts and commits a pick', () => {
    const onCommit = vi.fn();
    render(
      <ScriptPathField
        value="scripts/player.lua"
        scripts={['scripts/player.lua', 'scripts/enemy.lua']}
        onCommit={onCommit}
      />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('scripts/player.lua');
    // Options are label-stripped of the scripts/ prefix.
    expect(screen.getByRole('option', { name: 'enemy.lua' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'scripts/enemy.lua' } });
    expect(onCommit).toHaveBeenCalledWith('scripts/enemy.lua');
  });

  it('falls back to a free-text field for an unknown path', () => {
    const onCommit = vi.fn();
    render(<ScriptPathField value="scripts/new.lua" scripts={['scripts/player.lua']} onCommit={onCommit} />);
    // Unknown value -> Custom mode reveals a text input carrying the value.
    const text = screen.getByRole('textbox') as HTMLInputElement;
    expect(text.value).toBe('scripts/new.lua');
  });
});
