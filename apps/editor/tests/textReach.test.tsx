// @vitest-environment jsdom
/**
 * Text that is longer than the box it is in.
 *
 * Three separate places where a string the app does not choose could run past
 * its container, and in every one of them the reader got no sign of it. Found
 * in a browser, because jsdom does no layout at all: every box measures zero
 * by zero, so an overflow, a clipped control and a missing ellipsis are all
 * invisible to the other two thousand tests in this suite. What can be checked
 * here is the rule that fixes it, so that is what is checked, the same way
 * tests/composerReach.test.ts and tests/columnReach.test.ts do, and through
 * the same all-rules-in-all-media-blocks reader (tests/support/cssRules.ts).
 *
 * The three, with the measurements that found them, all at a 500px window with
 * the rail expanded unless stated otherwise:
 *
 *  1. `.conversation-provider` had no max-width, no overflow and no
 *     text-overflow. It names who is answering, and that name is not always a
 *     short word: a 143 character label measured 811px inside a head whose
 *     content box was 792px, so at 1600px the head ran 107px past its own
 *     edge, at 500px the label ran straight through .app-region's
 *     `overflow: hidden`, and nothing on screen said anything had been cut.
 *
 *  2. `.model-pill` was `flex: none` with `max-width: 15rem`, which is a cap
 *     that doubles as a floor: nothing could give the width back. With a long
 *     name in it the pill sat at x 299..539 on its own wrapped line inside an
 *     .app-region ending at 496. The name did ellipsize, at 205px of a wanted
 *     374, and then the ellipsis itself was clipped: the only sign of
 *     truncation was the part that went off the edge. Truncation you cannot
 *     see is worse than truncation, because it reads as a name that simply
 *     ends there.
 *
 *  3. The tooltip bubble itself could not hold what it was handed. `.tooltip`
 *     paired `max-width: 260px` with `white-space: nowrap`, so the label just
 *     ran out of the bubble and lay across the page, unbordered and unbacked:
 *     528px of text in a 260px box for a title and a path, 272px for the title
 *     alone. That one mattered twice over, because the fix for the top bar's
 *     tooltip (tests below) is to put MORE in it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { everyDeclaration, rulesUsingClass } from './support/cssRules';
import { TopBar } from '../src/components/shell/TopBar';
import { resetTooltipWarmState } from '../src/components/ui/Tooltip';
import { useApp } from '../src/store';

const CHAT_CSS = path.resolve(__dirname, '../src/styles/app/chat.css');
const TOOLTIP_CSS = path.resolve(__dirname, '../src/styles/primitives/tooltip.css');

const chat = fs.readFileSync(CHAT_CSS, 'utf8');
const tooltip = fs.readFileSync(TOOLTIP_CSS, 'utf8');

/** Every value the stylesheet gives one property on one class, wherever written. */
function stated(css: string, className: string, property: string) {
  return everyDeclaration(rulesUsingClass(css, className), property);
}

/** Asserts a property is set somewhere, and that no rule anywhere contradicts it. */
function pinned(css: string, className: string, property: string, expected: RegExp): void {
  const found = stated(css, className, property);
  expect(found.length).toBeGreaterThan(0);
  for (const { value, selector, where } of found) {
    expect(value, `${property} on ${selector} (${where})`).toMatch(expected);
  }
}

/** The three declarations that turn overflow into an ellipsis rather than a cut. */
function truncatesWithAnEllipsis(css: string, className: string): void {
  pinned(css, className, 'overflow', /^hidden$/);
  pinned(css, className, 'text-overflow', /^ellipsis$/);
  pinned(css, className, 'white-space', /^nowrap$/);
}

describe('the head label that says who is answering', () => {
  it('is bounded, because the string in it can be a command line', () => {
    // A cap at all. Without one there is nothing between a 1024 character
    // command and the width of the strip.
    pinned(chat, 'conversation-provider', 'max-width', /^\d/);
  });

  it('says so with an ellipsis rather than by running off the edge', () => {
    truncatesWithAnEllipsis(chat, 'conversation-provider');
  });

  it('gives width back when the column is narrower than its cap', () => {
    // The cap alone is not enough: at 500px the head's content box is under
    // 240px, so a label pinned at its cap would still overhang. `flex: none`
    // is what this replaced.
    const flex = stated(chat, 'conversation-provider', 'flex').filter((d) => d.selector === '.conversation-provider');
    expect(flex.length).toBeGreaterThan(0);
    for (const { value } of flex) {
      expect(value).not.toMatch(/^none$/);
      // grow shrink basis: the shrink factor is the middle number and must not
      // be zero, which is the whole difference between this and `flex: none`.
      expect(value).toMatch(/^0 1 /);
    }
    pinned(chat, 'conversation-provider', 'min-width', /^0\b/);
  });

  it('never abbreviates the one word the app chose itself', () => {
    // "Chat", "Terminal" and "Dev team" are the app's own words, already the
    // shortest thing in the strip. "Ter..." would be the head reporting a
    // squeeze rather than stating a fact.
    //
    // This used to be checked by requiring every rule to be written as the
    // compound `.conversation-provider.conversation-kind`, because the mode
    // BORROWED the provider's class and needed the extra specificity to beat
    // its shrink rule. It does not borrow it any more: a mode and an agent name
    // are opposite kinds of thing, and sharing one class is precisely what made
    // them render identically. With nothing to override, the compound selector
    // is no longer the mechanism, so what is checked here is the outcome it
    // existed to produce.
    const kind = rulesUsingClass(chat, 'conversation-kind');
    expect(kind.length).toBeGreaterThan(0);
    // Nothing may re-couple the two, which would drag the shrink back with it.
    for (const rule of kind) {
      expect(rule.selector, 'the mode must not borrow the provider treatment').not.toMatch(
        /\.conversation-provider\b/,
      );
    }
    // It never gives up width, and it never ellipsizes.
    pinned(chat, 'conversation-kind', 'flex', /^none$/);
    expect(stated(chat, 'conversation-kind', 'text-overflow')).toHaveLength(0);
  });
});

describe('the composer pill that says which agent answers', () => {
  it('can give back the width its cap allows it to take', () => {
    // `max-width` with nothing that shrinks is a floor wearing a ceiling's
    // name. Both halves are needed: `flex` has to permit the shrink and
    // `min-width` has to lower the automatic minimum, which is otherwise the
    // whole name on one line clamped by that same cap.
    const flex = stated(chat, 'model-pill', 'flex').filter((d) => d.selector === '.model-pill');
    expect(flex.length).toBeGreaterThan(0);
    for (const { value } of flex) {
      expect(value).not.toMatch(/^none$/);
      expect(value).toMatch(/^0 1 /);
    }
    pinned(chat, 'model-pill', 'min-width', /^0\b/);
  });

  it('still refuses to grow past its cap', () => {
    pinned(chat, 'model-pill', 'max-width', /^\d/);
  });

  it('ellipsizes the name inside it rather than cutting it', () => {
    truncatesWithAnEllipsis(chat, 'model-pill-name');
  });
});

describe('the tooltip bubble', () => {
  it('wraps, because it is the thing that has to hold what does not fit elsewhere', () => {
    // `nowrap` against a max-width is a cap that cannot be honoured. Measured
    // before the change: a 528px label inside a 260px bubble.
    pinned(tooltip, 'tooltip', 'white-space', /^normal$/);
    pinned(tooltip, 'tooltip', 'max-width', /^\d/);
  });

  it('breaks a path, which has no spaces to break at', () => {
    // Wrapping alone does not save an unbroken run: one long path still
    // measures wider than the bubble and spills exactly as before.
    pinned(tooltip, 'tooltip-label', 'overflow-wrap', /^anywhere$/);
  });

  it('keeps a shortcut chip on one line', () => {
    // The chip is the one thing in here that must never split.
    pinned(tooltip, 'tooltip-kbd', 'white-space', /^nowrap$/);
  });
});

/**
 * The top bar named the conversation and, on hover, answered with a filesystem
 * path. `.topbar-name` caps at 34ch and a generated title routinely runs past
 * it: measured at a 500px window, "Fix the double jump so it feels less floaty
 * at the apex" wanted 300px and got 174, so 126px of it was behind the
 * ellipsis. The one gesture for reading the hidden part answered a question
 * nobody had asked.
 */
describe('hovering the conversation name in the top bar', () => {
  const TITLE = 'Fix the double jump so it feels less floaty at the apex';
  const PROJECT = '/Users/jakekang/projects/hearth/hearth-engine';

  function mount(over: Record<string, unknown> = {}) {
    useApp.setState({
      projectPath: PROJECT,
      projectName: 'hearth-engine',
      chats: [{ id: 'c1', title: TITLE, updatedAt: '' }],
      activeChatId: 'c1',
      composing: false,
      projectView: false,
      screen: null,
      ...over,
    } as never);
    return render(<TopBar narrow={false} paneOpen={false} />);
  }

  const name = () => document.querySelector('.topbar-name') as HTMLElement;
  const tip = () => screen.queryByRole('tooltip');

  beforeEach(() => {
    resetTooltipWarmState();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('answers with the title, which is the thing being cut off', () => {
    mount();
    expect(name().textContent).toBe(TITLE);
    act(() => {
      // Keyboard focus shows instantly; the hover path is the same content.
      fireEvent.focus(name());
    });
    expect(tip()).not.toBeNull();
    expect(tip()!.textContent).toContain(TITLE);
  });

  it('still states the path, which nothing else in this strip does', () => {
    mount();
    act(() => {
      fireEvent.focus(name());
    });
    expect(tip()!.textContent).toContain(PROJECT);
    // Title first: it is what the hover was asking about.
    const text = tip()!.textContent ?? '';
    expect(text.indexOf(TITLE)).toBeLessThan(text.indexOf(PROJECT));
  });

  it('never leaves a separator with nothing after it', () => {
    mount();
    act(() => {
      fireEvent.focus(name());
    });
    expect(tip()!.textContent?.trim()).not.toMatch(/·$/);
  });

  it('names nothing at all while a global screen is up', () => {
    // Guards the condition the tooltip hangs off: the strip renders no name on
    // Skills or Tester, so there is nothing to hover and nothing to answer.
    mount({ screen: 'skills' });
    expect(name()).toBeNull();
  });
});
