// @vitest-environment jsdom
/**
 * Tooltip primitive behavior. Runs under jsdom (per-file docblock; the rest of
 * the editor suite stays on the Node env). Positioning is not asserted here —
 * jsdom reports zeroed rects — so these cover the interaction contract:
 * hover delay, keyboard focus instant-show, warm-state re-show, aria wiring,
 * Escape/blur dismissal, the shortcut chip, and timer cleanup on unmount.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';
import { Tooltip, resetTooltipWarmState } from '../src/components/ui/Tooltip';

const WARM_WINDOW = 500; // must match the module-level warm window in Tooltip

function renderTip(props?: { shortcut?: string }) {
  return render(
    <Tooltip content="Play" shortcut={props?.shortcut}>
      <button>Play</button>
    </Tooltip>,
  );
}

const trigger = () => screen.getByRole('button', { name: 'Play' });
const tip = () => screen.queryByRole('tooltip');

beforeEach(() => {
  vi.useFakeTimers();
  resetTooltipWarmState();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('Tooltip', () => {
  it('renders nothing until interaction', () => {
    renderTip();
    expect(tip()).toBeNull();
  });

  it('shows on hover only after the delay', () => {
    renderTip();
    act(() => {
      fireEvent.pointerEnter(trigger());
    });
    // Not yet — the show is debounced.
    expect(tip()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(tip()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(tip()).not.toBeNull();
    expect(tip()!.textContent).toContain('Play');
  });

  it('shows immediately on keyboard focus', () => {
    renderTip();
    act(() => {
      fireEvent.focus(trigger());
    });
    // No timer advance — keyboard focus is instant.
    expect(tip()).not.toBeNull();
  });

  it('re-shows instantly while warm (within 500ms of the last hide)', () => {
    renderTip();
    // Warm the tooltip up: hover, wait out the delay, then leave.
    act(() => {
      fireEvent.pointerEnter(trigger());
      vi.advanceTimersByTime(300);
    });
    expect(tip()).not.toBeNull();
    act(() => {
      fireEvent.pointerLeave(trigger());
    });
    expect(tip()).toBeNull();
    // Re-enter shortly after — should appear with no delay.
    act(() => {
      vi.advanceTimersByTime(200);
      fireEvent.pointerEnter(trigger());
    });
    expect(tip()).not.toBeNull();
  });

  it('wires aria-describedby to the tooltip while shown, and clears it when hidden', () => {
    renderTip();
    expect(trigger().getAttribute('aria-describedby')).toBeNull();
    act(() => {
      fireEvent.focus(trigger());
    });
    const id = tip()!.getAttribute('id');
    expect(id).toBeTruthy();
    expect(trigger().getAttribute('aria-describedby')).toBe(id);
    act(() => {
      fireEvent.blur(trigger());
    });
    expect(tip()).toBeNull();
    expect(trigger().getAttribute('aria-describedby')).toBeNull();
  });

  it('hides on Escape', () => {
    renderTip();
    act(() => {
      fireEvent.focus(trigger());
    });
    expect(tip()).not.toBeNull();
    act(() => {
      fireEvent.keyDown(trigger(), { key: 'Escape' });
    });
    expect(tip()).toBeNull();
  });

  it('renders the shortcut as a kbd chip', () => {
    const { baseElement } = renderTip({ shortcut: 'Space' });
    act(() => {
      fireEvent.focus(trigger());
    });
    const kbd = baseElement.querySelector('kbd');
    expect(kbd).not.toBeNull();
    expect(kbd!.textContent).toBe('Space');
  });

  it('cleans up a pending show timer on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = renderTip();
    // The warm-state timestamp is module-level (shared across tooltips by
    // design); step past the warm window so this hover arms the real delay.
    act(() => {
      vi.advanceTimersByTime(WARM_WINDOW + 100);
      fireEvent.pointerEnter(trigger()); // arms the 300ms show timer
    });
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    // Advancing past the delay must not resurrect a tooltip or throw.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    clearSpy.mockRestore();
  });
});
