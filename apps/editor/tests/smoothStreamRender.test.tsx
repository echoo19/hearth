// @vitest-environment jsdom
/**
 * The paced reveal, through the component that actually renders prose.
 *
 * The pure rate is tested next door; this is the half that can rot silently —
 * that Markdown reveals a PREFIX while a turn is live, catches up on its own,
 * and hands the whole thing over the moment the turn is not live any more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { Markdown } from '../src/components/chat/Markdown';

const LUMP = 'The folder has a scaffold only: an index page, a canvas and a bare loop. No engine, no game logic, no assets.';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * A stand-in for the reduced-motion query that can be flipped after mount, the
 * way the real one is when someone changes the setting mid-turn.
 */
function stubReducedMotion(initial: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) => void listeners.add(fn),
    removeEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) => void listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  };
  vi.stubGlobal(
    'matchMedia',
    (media: string) => (media.includes('reduced-motion') ? query : { ...query, matches: false }),
  );
  return {
    set(matches: boolean) {
      query.matches = matches;
      for (const fn of listeners) fn({ matches } as MediaQueryListEvent);
    },
  };
}

function shown(container: HTMLElement): string {
  return container.textContent ?? '';
}

describe('prose arriving in one lump', () => {
  it('is laid down over several frames rather than in one paint', () => {
    vi.useFakeTimers();
    // Mounted empty, the way a turn's first bubble is: everything after this
    // is growth, and growth is what gets paced.
    const { container, rerender } = render(<Markdown text="" live />);
    act(() => { rerender(<Markdown text={LUMP} live />); });

    act(() => { vi.advanceTimersByTime(16); });
    const first = shown(container);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(LUMP.length);
    expect(LUMP.startsWith(first)).toBe(true);

    act(() => { vi.advanceTimersByTime(64); });
    const later = shown(container);
    expect(later.length).toBeGreaterThan(first.length);
    expect(LUMP.startsWith(later)).toBe(true);

    // And it gets there on its own, without another delta to push it.
    act(() => { vi.advanceTimersByTime(1000); });
    expect(shown(container)).toBe(LUMP);
  });

  it('shows a finished turn whole, with nothing to wait for', () => {
    // A replayed transcript is not a stream and must never be typed out.
    const { container } = render(<Markdown text={LUMP} live={false} />);
    expect(shown(container)).toBe(LUMP);
  });

  it('stops holding anything back the moment the turn ends', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Markdown text="" live />);
    act(() => { rerender(<Markdown text={LUMP} live />); });
    act(() => { vi.advanceTimersByTime(16); });
    expect(shown(container).length).toBeLessThan(LUMP.length);

    act(() => { rerender(<Markdown text={LUMP} live={false} />); });
    expect(shown(container)).toBe(LUMP);
  });

  it('takes text that is not a continuation as it is', () => {
    // A different message reusing the element, or a rewind: showing characters
    // that are no longer in the transcript would be worse than a jump.
    vi.useFakeTimers();
    const { container, rerender } = render(<Markdown text="" live />);
    act(() => { rerender(<Markdown text={LUMP} live />); });
    act(() => { vi.advanceTimersByTime(16); });

    act(() => { rerender(<Markdown text="Something else entirely." live />); });
    expect(shown(container)).toBe('Something else entirely.');
  });
});

describe('a reader who has asked for less motion', () => {
  it('gets the text whole rather than a slower crawl', () => {
    // Pacing text onto the screen is motion: the eye tracks the moving edge
    // the same way it tracks a sliding panel. With the setting on there is no
    // edge to track — the words are simply there.
    stubReducedMotion(true);
    vi.useFakeTimers();
    const { container, rerender } = render(<Markdown text="" live />);
    act(() => { rerender(<Markdown text={LUMP} live />); });
    expect(shown(container)).toBe(LUMP);
  });

  it('snaps a crawl already under way when the setting is turned on', () => {
    const motion = stubReducedMotion(false);
    vi.useFakeTimers();
    const { container, rerender } = render(<Markdown text="" live />);
    act(() => { rerender(<Markdown text={LUMP} live />); });
    act(() => { vi.advanceTimersByTime(16); });
    expect(shown(container).length).toBeLessThan(LUMP.length);

    act(() => { motion.set(true); });
    expect(shown(container)).toBe(LUMP);
  });
});
