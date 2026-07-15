/**
 * L-059 (CONSOLE-CHANGES-1/2): the Console auto-follow must (a) key on the
 * last entry's monotonic id, not entries.length — which pins at MAX_CONSOLE
 * once the cap is hit and freezes the view mid-list — and (b) only snap to the
 * bottom when the user was already parked there (scroll-lock). This covers the
 * two pure pieces of that logic; the end-to-end scroll behaviour is verified
 * live (jsdom reports zero layout metrics).
 */
import { describe, expect, it } from 'vitest';
import { isNearBottom, scrollRestoreTop } from '../src/components/ConsolePanel';

describe('Console auto-scroll — isNearBottom (scroll-lock predicate)', () => {
  it('true at the origin (empty/short console counts as at-bottom; jsdom all-zero)', () => {
    expect(isNearBottom({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 })).toBe(true);
  });

  it('true when scrolled to the exact bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true);
  });

  it('true within the 24px slack of the bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 790, clientHeight: 200 })).toBe(true);
  });

  it('false when scrolled up to reread earlier output', () => {
    // scrollTop 542 of scrollHeight 10707, clientHeight 197 — the exact
    // frozen-mid-list state the audit captured.
    expect(isNearBottom({ scrollHeight: 10707, scrollTop: 542, clientHeight: 197 })).toBe(false);
  });

  it('false at the very top of a tall list', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 0, clientHeight: 200 })).toBe(false);
  });
});

/**
 * B5 follow-up (console scroll survives hide/reveal): dockview detaches the
 * Console panel DOM when a sibling tab activates, which resets scrollTop to 0;
 * on reveal the saved intent is reapplied via scrollRestoreTop. The pure
 * decision is unit-tested here; the live reattach is verified in the browser.
 */
describe('Console scroll restore — scrollRestoreTop (reveal after detach)', () => {
  it('snaps to the bottom (scrollHeight) when the user was parked there', () => {
    // stickToBottom true → follow the tail regardless of the stale saved offset.
    expect(scrollRestoreTop({ scrollHeight: 10707 }, true, 542)).toBe(10707);
  });

  it('restores the saved offset when the user had scrolled up', () => {
    // stickToBottom false → return to exactly where they were reading.
    expect(scrollRestoreTop({ scrollHeight: 10707 }, false, 542)).toBe(542);
  });

  it('at-bottom empty console stays at 0 (scrollHeight 0, stick true)', () => {
    expect(scrollRestoreTop({ scrollHeight: 0 }, true, 0)).toBe(0);
  });
});
