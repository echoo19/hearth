// @vitest-environment jsdom
/**
 * L-108 — shared field-commit-feedback contract for the scalar primitives
 * (NumberField / TextField / ColorField in ui.tsx).
 *
 * The systemic bug: a field's local `draft` only re-syncs from the `value`
 * prop, so a rejected commit (which leaves `value` unchanged) left the bad
 * draft on screen and, for NumberField, silently committed `0` for an emptied
 * field. These tests pin the fix:
 *   - client-side validation (empty/NaN/out-of-range number, bad hex) reverts
 *     the draft and never calls onCommit;
 *   - the rejection contract: onCommit may return `false`/a reason string
 *     (or a Promise/throw) to reject → the draft reverts and an `invalid`
 *     rejection cue is shown; a returned reason string surfaces inline on
 *     TextField.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { NumberField, TextField, ColorField } from '../src/components/ui';

afterEach(() => cleanup());

function type(input: HTMLElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
}

describe('NumberField', () => {
  it('commits a valid numeric change on blur', () => {
    const onCommit = vi.fn();
    render(<NumberField value={5} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    type(input, '12');
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(12);
  });

  it('reverts an emptied field instead of committing 0', () => {
    const onCommit = vi.fn();
    render(<NumberField value={7} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    type(input, '');
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('7');
    expect(input.className).toContain('invalid');
  });

  it('reverts non-numeric garbage without committing', () => {
    const onCommit = vi.fn();
    render(<NumberField value={3} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    type(input, 'abc');
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('3');
  });

  it('rejects a value above max (client-side, no commit)', () => {
    const onCommit = vi.fn();
    render(<NumberField value={1} min={0} max={3} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    type(input, '999');
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('1');
    expect(input.className).toContain('invalid');
  });

  it('rejects a value below min (client-side, no commit)', () => {
    const onCommit = vi.fn();
    render(<NumberField value={1} min={0} max={3} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    type(input, '-5');
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('1');
  });

  it('accepts an in-range value with min/max set', () => {
    const onCommit = vi.fn();
    render(<NumberField value={1} min={0} max={3} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    type(input, '2.5');
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(2.5);
  });

  it('reverts + flags invalid when onCommit rejects with false', async () => {
    const onCommit = vi.fn(() => false);
    render(<NumberField value={4} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    type(input, '9');
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe('4'));
    expect(input.className).toContain('invalid');
  });

  it('rejects a non-integer draft when integer is set (pixelate.size-style)', () => {
    const onCommit = vi.fn();
    render(<NumberField value={4} min={1} max={64} integer onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    type(input, '3.5');
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('4');
    expect(input.className).toContain('invalid');
  });

  it('accepts an in-range integer when integer is set', () => {
    const onCommit = vi.fn();
    render(<NumberField value={4} min={1} max={64} integer onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    type(input, '8');
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(8);
  });

  it('ignores a stale async rejection once a newer commit superseded it', async () => {
    // First commit: slow rejection. Second commit: fast accept. The late
    // rejection must not clobber the newer draft or flash the cue.
    let rejectLate: (v: boolean) => void = () => {};
    const onCommit = vi
      .fn<(v: number) => Promise<boolean> | boolean>()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (rejectLate = resolve)))
      .mockImplementationOnce(() => true);
    render(<NumberField value={5} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    type(input, '9');
    fireEvent.blur(input); // commit 1 — pending
    type(input, '8');
    fireEvent.blur(input); // commit 2 — accepted immediately
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    rejectLate(false); // commit 1 settles late as a rejection
    await new Promise((r) => setTimeout(r, 20));
    expect(input.value).toBe('8'); // not clobbered back to '5'
    expect(input.className).not.toContain('invalid');
  });
});

describe('TextField', () => {
  it('commits a changed value on blur', () => {
    const onCommit = vi.fn();
    render(<TextField value="moveX" onCommit={onCommit} />);
    const input = screen.getByRole('textbox');
    type(input, 'aim');
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('aim');
  });

  it('reverts and shows the reason when onCommit returns a rejection string', async () => {
    const onCommit = vi.fn(() => 'An axis named "moveY" already exists');
    render(<TextField value="moveX" onCommit={onCommit} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    type(input, 'moveY');
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe('moveX'));
    expect(screen.getByText(/already exists/)).toBeTruthy();
    expect(input.className).toContain('invalid');
  });

  it('reverts on an async (Promise<false>) rejection', async () => {
    const onCommit = vi.fn(() => Promise.resolve(false));
    render(<TextField value="keep" onCommit={onCommit} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    type(input, 'nope');
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe('keep'));
  });

  it('rejects a blanked draft when the consumer returns a reason (entity Name style)', async () => {
    // The Inspector Name field's wiring: blank → reason string, else rename.
    const rename = vi.fn();
    const onCommit = (v: string) => {
      if (!v.trim()) return 'Name can’t be empty.';
      rename(v.trim());
    };
    render(<TextField value="Player" onCommit={onCommit} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    type(input, '   ');
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe('Player'));
    expect(rename).not.toHaveBeenCalled();
    expect(screen.getByText('Name can’t be empty.')).toBeTruthy();
    expect(input.className).toContain('invalid');
  });

  it("treats a bare '' return as accepted (consumers must return a reason to reject)", async () => {
    const onCommit = vi.fn(() => '');
    render(<TextField value="old" onCommit={onCommit} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    type(input, 'new');
    fireEvent.blur(input);
    await new Promise((r) => setTimeout(r, 20));
    // No revert, no cue — '' means accepted per the contract.
    expect(input.value).toBe('new');
    expect(input.className).not.toContain('invalid');
  });
});

describe('ColorField', () => {
  it('commits a valid #rrggbb hex on blur', () => {
    const onCommit = vi.fn();
    render(<ColorField value="#ffffff" onCommit={onCommit} />);
    const text = screen.getByRole('textbox');
    type(text, '#ff8800');
    fireEvent.blur(text);
    expect(onCommit).toHaveBeenCalledWith('#ff8800');
  });

  it('accepts #rgb and #rrggbbaa short/long forms', () => {
    const onCommit = vi.fn();
    render(<ColorField value="#000000" onCommit={onCommit} />);
    const text = screen.getByRole('textbox');
    type(text, '#f80');
    fireEvent.blur(text);
    expect(onCommit).toHaveBeenLastCalledWith('#f80');
    type(text, '#ff8800cc');
    fireEvent.blur(text);
    expect(onCommit).toHaveBeenLastCalledWith('#ff8800cc');
  });

  it('reverts invalid hex without committing and flags invalid', () => {
    const onCommit = vi.fn();
    render(<ColorField value="#ffffff" onCommit={onCommit} />);
    const text = screen.getByRole('textbox') as HTMLInputElement;
    type(text, 'notacolor');
    fireEvent.blur(text);
    expect(onCommit).not.toHaveBeenCalled();
    expect(text.value).toBe('#ffffff');
    expect(text.className).toContain('invalid');
  });

  it('keeps the native swatch on a valid color while the draft is invalid', () => {
    render(<ColorField value="#123456" onCommit={vi.fn()} />);
    const swatch = screen.getByLabelText('Pick color') as HTMLInputElement;
    const text = screen.getByRole('textbox');
    type(text, 'garbage');
    // Swatch must not jump to the fallback while typing an invalid draft.
    expect(swatch.value).toBe('#123456');
  });
});
