/**
 * The window can always get narrower than its contents want to be.
 *
 * Companion to tests/composerReach.test.ts, and the other half of the same
 * bug. That file made the composer's control row wrap so Send could not be
 * pushed off the window; found in a real browser afterwards, Send was STILL
 * off the window below about 770px, because the row was wrapping inside a
 * column that refused to get any narrower.
 *
 * Both floors were the same mistake on the same axis. `.app-main` and
 * `.chat-column` are single-column grids that stated only their rows, so the
 * column track defaulted to `auto` — and an `auto` track is sized by its
 * content's minimum, not by the box around it. Measured at a 500px viewport
 * with the rail expanded:
 *
 *   - `.app-main`'s track sat at 509px inside a 240px box (the top bar's own
 *     minimum, most of it the project name), putting the Chat/Game switch and
 *     the playtest toggle at x 534..759 in a 500px window;
 *   - `.chat-column`'s track sat at 346px inside the same 240px box, putting
 *     the composer at x 260..606 and Send at 700..732.
 *
 * Nothing scrolled to any of it: `.app-body` and `.app-region` are
 * `overflow: hidden`, so the controls were not clipped-but-scrollable, they
 * were gone. `minmax(0, 1fr)` lets each track be as narrow as its box, which
 * is what the row axis beside it already said. Verified in a browser: with
 * both tracks stated, Send stays on screen down to 380px, and at 1440/1280/
 * 1024/900 every box measures byte-identical to before the change.
 *
 * CSS assertions rather than layout ones, for the reason composerReach.test.ts
 * gives: jsdom does no layout at all, reports every box as zero by zero, and
 * so cannot see this class of failure. That is exactly why it went unnoticed
 * twice.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { everyDeclaration, rulesUsingClass } from './support/cssRules';

const SHELL_CSS = path.resolve(__dirname, '../src/styles/app/shell.css');
const CHAT_CSS = path.resolve(__dirname, '../src/styles/app/chat.css');

/**
 * A single-column grid track that cannot be inflated by its content.
 * `1fr` alone is not enough: an `fr` track still floors at min-content unless
 * the minimum is stated as 0, which is the whole point of the `minmax` form.
 */
const UNCONSTRAINED_COLUMN = /^minmax\(\s*0\s*,\s*1fr\s*\)$/;

/**
 * Every value the stylesheet gives one property on one class, wherever it is
 * written. This used to be a `.exec` that took the first match and stopped,
 * which meant a `@media` block could quietly restore the `auto` track this
 * file exists to forbid; see the note at the top of
 * tests/composerReach.test.ts.
 */
function stated(css: string, className: string, property: string) {
  return everyDeclaration(rulesUsingClass(css, className), property);
}

describe('the working area', () => {
  const css = fs.readFileSync(SHELL_CSS, 'utf8');

  it('lets its column be as narrow as the window, so the top bar cannot outgrow it', () => {
    const found = stated(css, 'app-main', 'grid-template-columns');
    expect(found.length).toBeGreaterThan(0);
    for (const { value, selector, where } of found) expect(value, `${selector} (${where})`).toMatch(UNCONSTRAINED_COLUMN);
  });

  it('still states its rows, which is what holds the top bar above the screen', () => {
    // The column rule is an addition, not a replacement; losing the rows would
    // trade a horizontal bug for a vertical one.
    const found = stated(css, 'app-main', 'grid-template-rows');
    expect(found.length).toBeGreaterThan(0);
    for (const { value, selector, where } of found) expect(value, `${selector} (${where})`).toMatch(/^auto 1fr$/);
  });
});

describe('the conversation column', () => {
  const css = fs.readFileSync(CHAT_CSS, 'utf8');

  it('lets its column be as narrow as the region, so the composer cannot hang over the edge', () => {
    const found = stated(css, 'chat-column', 'grid-template-columns');
    expect(found.length).toBeGreaterThan(0);
    for (const { value, selector, where } of found) expect(value, `${selector} (${where})`).toMatch(UNCONSTRAINED_COLUMN);
  });

  it('keeps the transcript-and-composer rows it already had', () => {
    const found = stated(css, 'chat-column', 'grid-template-rows');
    expect(found.length).toBeGreaterThan(0);
    for (const { value, selector, where } of found) {
      expect(value, `${selector} (${where})`).toMatch(/^auto minmax\(\s*0\s*,\s*1fr\s*\)$/);
    }
  });

  /**
   * The same mistake, two levels further in, and the reason the model pill
   * could not be fixed from the pill's own rules. `.conversation-stack` and
   * `.conversation-layer` are single-column grids that named only their rows,
   * so their column track was `auto` and sized by its content's minimum.
   * Measured at a 376px window with the rail expanded: both boxes 116px wide
   * with a 316px track inside them, and `.composer` sitting in that track at
   * 316px, which put the pill 43px past .app-region's clipped edge whatever
   * the pill said about itself.
   */
  for (const layer of ['conversation-stack', 'conversation-layer'] as const) {
    it(`lets ${layer} be as narrow as the column, so the composer cannot inflate it`, () => {
      const found = stated(css, layer, 'grid-template-columns');
      expect(found.length).toBeGreaterThan(0);
      for (const { value, selector, where } of found) expect(value, `${selector} (${where})`).toMatch(UNCONSTRAINED_COLUMN);
    });
  }

  it('keeps both mode layers stacked in one cell', () => {
    // The column track is an addition. The layers share a grid area so the
    // chat/terminal swap cannot move anything around it.
    const found = stated(css, 'conversation-layer', 'grid-area');
    expect(found.map((d) => d.value)).toContain('1 / 1');
  });
});
