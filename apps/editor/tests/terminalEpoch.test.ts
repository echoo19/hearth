import { describe, expect, it, vi } from 'vitest';
import { resendTerminalSizeThenFocus } from '../src/components/agent/Terminal';

describe('resendTerminalSizeThenFocus', () => {
  it('reports the current grid after pty-start and only then focuses', () => {
    const calls: string[] = [];
    const onResize = vi.fn((cols: number, rows: number) => calls.push(`resize:${cols}x${rows}`));
    const focus = vi.fn(() => calls.push('focus'));

    resendTerminalSizeThenFocus({ cols: 132, rows: 44, focus }, onResize);

    expect(calls).toEqual(['resize:132x44', 'focus']);
  });
});
