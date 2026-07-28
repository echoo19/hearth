/**
 * The single transient message slot.
 *
 * The behaviour worth pinning is that it stays a slot: a burst of notices must
 * never become a stack, and a repeat of what is already showing must not
 * restart the card's entrance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { currentToast, dismissToast, resetToasts, showToast, subscribeToast } from '../src/toast';

beforeEach(() => {
  vi.useFakeTimers();
  resetToasts();
});

afterEach(() => {
  resetToasts();
  vi.useRealTimers();
});

describe('showToast', () => {
  it('holds one toast at a time, newest wins', () => {
    showToast('first');
    showToast('second');
    expect(currentToast()?.message).toBe('second');
  });

  it('keeps the id when the same message repeats, so the card does not re-enter', () => {
    showToast('Not connected. Wait a moment and send again.', 'error');
    const first = currentToast()?.id;
    showToast('Not connected. Wait a moment and send again.', 'error');
    expect(currentToast()?.id).toBe(first);
  });

  it('treats the same words at a different tone as a new toast', () => {
    showToast('Saved');
    const first = currentToast()?.id;
    showToast('Saved', 'error');
    expect(currentToast()?.id).not.toBe(first);
  });

  it('ignores an empty message rather than flashing a blank card', () => {
    showToast('   ');
    expect(currentToast()).toBeNull();
  });

  it('clears itself after its dwell, and errors linger longer than notes', () => {
    showToast('a note');
    vi.advanceTimersByTime(4000);
    expect(currentToast()).toBeNull();

    showToast('a failure', 'error');
    vi.advanceTimersByTime(4000);
    expect(currentToast()).not.toBeNull();
    vi.advanceTimersByTime(3000);
    expect(currentToast()).toBeNull();
  });

  it('restarts the clock on a repeat instead of expiring on the first one', () => {
    showToast('again', 'error');
    vi.advanceTimersByTime(5000);
    showToast('again', 'error');
    vi.advanceTimersByTime(5000);
    expect(currentToast()).not.toBeNull();
  });
});

describe('subscribeToast', () => {
  it('tells listeners about arrival and dismissal', () => {
    const seen: (string | null)[] = [];
    const stop = subscribeToast((toast) => seen.push(toast?.message ?? null));
    showToast('hello');
    dismissToast();
    stop();
    showToast('after unsubscribing');
    expect(seen).toEqual(['hello', null]);
  });

  it('cancels a pending dismissal when dismissed by hand', () => {
    showToast('hello');
    dismissToast();
    const seen: (string | null)[] = [];
    subscribeToast((toast) => seen.push(toast?.message ?? null));
    // The original dwell would have fired around here; it must not emit a
    // second null to a slot that is already empty.
    vi.advanceTimersByTime(10000);
    expect(seen).toEqual([]);
  });
});
