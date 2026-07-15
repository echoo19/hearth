// @vitest-environment jsdom
/**
 * L-124 — the Export/Modal dialog must open as a live top-layer MODAL
 * (showModal), never in normal flow. A dialog left with `open` set but out of
 * the top layer lays out bottom-right of its DOM parent instead of centered;
 * that is the reported symptom. These tests pin:
 *   - `isModalOpen`: reads `:modal` when the engine supports it, and falls back
 *     to the plain `open` flag where it doesn't (jsdom throws on `:modal`).
 *   - Modal's open effect calls `showModal()` (not `show()` / an `open`
 *     attribute) when it opens, and `close()` when it closes.
 *   - When the dialog is open but NOT a modal (top-layer lost), the effect
 *     re-shows it — the recovery path.
 *
 * jsdom has no top-layer/`:modal`, so `matches(':modal')` is stubbed per test
 * to model the two engine states.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { Modal, isModalOpen } from '../src/components/ui';

// jsdom implements neither the dialog top layer nor showModal/show/close, so
// polyfill them as plain open/close toggles the tests can spy on. This models
// exactly the surface the Modal effect touches.
beforeEach(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.show = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('isModalOpen', () => {
  it('returns the `:modal` match when the selector is supported', () => {
    const dialog = document.createElement('dialog');
    vi.spyOn(dialog, 'matches').mockReturnValue(true);
    expect(isModalOpen(dialog)).toBe(true);
    vi.spyOn(dialog, 'matches').mockReturnValue(false);
    expect(isModalOpen(dialog)).toBe(false);
  });

  it('falls back to the `open` flag when `:modal` is unsupported (throws)', () => {
    const dialog = document.createElement('dialog');
    vi.spyOn(dialog, 'matches').mockImplementation(() => {
      throw new SyntaxError("unknown pseudo-class ':modal'");
    });
    expect(isModalOpen(dialog)).toBe(false);
    dialog.open = true;
    expect(isModalOpen(dialog)).toBe(true);
  });
});

describe('Modal — always opens as a top-layer modal (L-124)', () => {
  it('calls showModal() when it opens and close() when it closes', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const show = vi.spyOn(HTMLDialogElement.prototype, 'show');
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close');

    const { rerender } = render(
      <Modal open={false} title="Export" onClose={() => {}}>
        <div>body</div>
      </Modal>,
    );
    expect(showModal).not.toHaveBeenCalled();

    act(() => {
      rerender(
        <Modal open title="Export" onClose={() => {}}>
          <div>body</div>
        </Modal>,
      );
    });
    expect(showModal).toHaveBeenCalledTimes(1);
    // Never opened non-modally (show() / the `open` attribute) — those are the
    // paths that strand the dialog in normal flow.
    expect(show).not.toHaveBeenCalled();

    act(() => {
      rerender(
        <Modal open={false} title="Export" onClose={() => {}}>
          <div>body</div>
        </Modal>,
      );
    });
    expect(close).toHaveBeenCalled();
  });

  it('re-shows a dialog that is open but no longer a modal (top-layer lost)', () => {
    // Model a browser that reports `:modal === false` (the dialog fell out of
    // the top layer, e.g. after a remount). The effect must recover it.
    const matches = vi
      .spyOn(HTMLDialogElement.prototype, 'matches')
      .mockReturnValue(false);
    const showModal = vi
      .spyOn(HTMLDialogElement.prototype, 'showModal')
      .mockImplementation(function (this: HTMLDialogElement) {
        this.open = true;
      });
    const close = vi
      .spyOn(HTMLDialogElement.prototype, 'close')
      .mockImplementation(function (this: HTMLDialogElement) {
        this.open = false;
      });

    // Mount already-open: isModalOpen() is false (stub), so the guard shows it.
    act(() => {
      render(
        <Modal open title="Export" onClose={() => {}}>
          <div>body</div>
        </Modal>,
      );
    });

    expect(showModal).toHaveBeenCalled();
    expect(matches).toHaveBeenCalled();
  });
});
