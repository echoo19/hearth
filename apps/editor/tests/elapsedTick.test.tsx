// @vitest-environment jsdom
/**
 * The counter beside a live turn.
 *
 * It is watched, one second at a time, by someone waiting — so it has to count
 * the way a person counts. It did not: the value on screen is derived from the
 * wall clock but the update was a repeating interval, which keeps its own
 * phase, drifts, and eventually fires a tick that straddles two whole seconds.
 * The line then reads 5s, 6s, 8s: one number never shown, one shown twice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { useElapsed } from '../src/components/chat/WorkingRow';
import { formatElapsed } from '../src/chat/duration';

function Counter({ startedAt }: { startedAt: number }) {
  const elapsed = useElapsed(startedAt, true);
  return <span data-testid="c">{elapsed === null ? '' : formatElapsed(elapsed) ?? ''}</span>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the elapsed counter', () => {
  it('shows every second exactly once, however the timer lands', () => {
    vi.useFakeTimers();
    // Deliberately off a whole-second boundary: the turn's clock is its own.
    const started = 1_000_000_137;
    vi.setSystemTime(started);
    const { getByTestId } = render(<Counter startedAt={started} />);

    const seen: string[] = [];
    // Sampled far finer than it ticks, so nothing can be missed between reads.
    // Real timers fire late, never early, and by a varying amount; the jitter
    // here is that drift, exaggerated.
    for (let step = 0; step < 300; step += 1) {
      act(() => {
        vi.advanceTimersByTime(100 + (step % 5));
      });
      const shown = getByTestId('c').textContent ?? '';
      if (shown !== '' && shown !== seen[seen.length - 1]) seen.push(shown);
    }

    // Below the floor the line says nothing at all, so counting starts at 3.
    expect(seen.slice(0, 8)).toEqual(['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s']);
    // No value repeated, none skipped: consecutive all the way up.
    const numbers = seen.map((text) => Number(text.replace(/[^0-9]/g, '')));
    expect(numbers).toEqual(numbers.map((_, index) => numbers[0] + index));
  });

  it('holds its width as the minutes roll over inside an hour', () => {
    // The padding is there so a watched line cannot twitch. It stopped at the
    // hour: `1h 9m 00s` became `1h 10m 00s` and every character to the right
    // of the minutes moved one place along.
    expect(formatElapsed(3_600_000 + 9 * 60_000)).toBe('1h 09m 00s');
    expect(formatElapsed(3_600_000 + 10 * 60_000)).toBe('1h 10m 00s');
    const widths = [9, 10, 59].map((m) => (formatElapsed(3_600_000 + m * 60_000) ?? '').length);
    expect(new Set(widths).size).toBe(1);
  });

  it('lets a frozen tab tell the truth when it comes back', () => {
    // The one jump that is honest: the time really did pass. A counter that
    // resumed from where it left off would be a stopwatch that lies.
    vi.useFakeTimers();
    const started = 1_000_000_000;
    vi.setSystemTime(started);
    const { getByTestId } = render(<Counter startedAt={started} />);
    act(() => {
      vi.advanceTimersByTime(65_010);
    });
    expect(getByTestId('c').textContent).toBe('1m 05s');
  });
});
