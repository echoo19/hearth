/**
 * You can always reach Send.
 *
 * Found in a real browser at 500px with the rail expanded: the composer's
 * control row had about 190px to hold about 275px of controls, `nowrap`, and
 * nothing scrolling. The send button sat sixty pixels past the right edge of
 * the window. Not clipped, not scrollable, simply gone. You could type a whole
 * message and have no way to send it, which is the worst thing this surface
 * can do.
 *
 * A CSS assertion rather than a layout test, because jsdom does no layout at
 * all: it reports every box as zero by zero, so the failure this pins is
 * invisible to every other test in this suite. That is exactly why it went
 * unnoticed. The rule is small and load-bearing, so it is pinned where it can
 * actually be checked.
 *
 * The pinning itself was then wrong for a while, which is worth spelling out
 * because it is the failure mode this whole file exists to prevent. The old
 * helper here was `new RegExp(..., 'm').exec(css)`: first match, then stop.
 * Append `@media (max-width: 700px) { .composer-row { flex-wrap: nowrap } }`
 * to chat.css and the original bug is back at exactly the width where it
 * strands Send, while all three assertions below still pass, because the
 * helper never read past the rule at the top of the file. Measured that way on
 * a copy of chat.css before this was rewritten: two `.composer-row` rules in
 * the file, the second one saying `nowrap`, suite green.
 *
 * So every assertion here now reads EVERY rule that touches the property, in
 * every media block (tests/support/cssRules.ts), and a property counts as
 * pinned only when all of them agree.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { everyDeclaration, rulesUsingClass, rulesWithSelector } from './support/cssRules';

const CHAT_CSS = path.resolve(__dirname, '../src/styles/app/chat.css');

describe('the composer control row', () => {
  const css = fs.readFileSync(CHAT_CSS, 'utf8');

  it('wraps, so the send button cannot be pushed off the window', () => {
    const stated = everyDeclaration(rulesUsingClass(css, 'composer-row'), 'flex-wrap');
    // Said at least once...
    expect(stated.length).toBeGreaterThan(0);
    // ...and never contradicted, at any width. A `nowrap` in a media block is
    // the same bug back again, at the one viewport where it costs the most.
    for (const { value, selector, where } of stated) {
      expect(value, `flex-wrap on ${selector} (${where})`).toMatch(/^wrap\b/);
    }
  });

  it('lets its controls shrink, which is what keeps the model pill on screen', () => {
    // Each picker in this row renders a `.menu-root` wrapper, `display: flex`
    // and shrinkable, whose automatic minimum is its content's min-content.
    // For the model pill that min-content is the whole agent name on one line,
    // clamped by `max-width: 15rem`, so the wrapper floors at 240px and the
    // pill inside it cannot shrink however willing its own rules are.
    //
    // Measured in a browser at a 500px window with a registered agent's name
    // in the pill: with `min-width: 0` the pill is 160px and ends at x 459
    // inside an .app-region that ends at 496; without it the pill is 240px,
    // ends at 539, and the region's scrollWidth goes to 279 against a
    // clientWidth of 236. That is 43px of control, including the ellipsis that
    // was the only sign anything had been cut, clipped by a container that
    // does not scroll.
    //
    // This rule was inert until .model-pill was made shrinkable alongside it
    // (removed, every box in the row measured byte-identical at every width),
    // so the two move together or not at all.
    const stated = everyDeclaration(rulesWithSelector(css, '.composer-row > *'), 'min-width');
    expect(stated.length).toBeGreaterThan(0);
    for (const { value, selector, where } of stated) {
      expect(value, `min-width on ${selector} (${where})`).toMatch(/^0\b/);
    }
  });

  it('keeps send last, so a wrap gives it a line rather than stranding a pill', () => {
    // The gap element is what pushes send to the right; if it ever stopped
    // growing, the wrap would put send in the middle of the second line.
    const stated = everyDeclaration(rulesUsingClass(css, 'composer-row-gap'), 'flex');
    expect(stated.length).toBeGreaterThan(0);
    for (const { value, selector, where } of stated) {
      expect(value, `flex on ${selector} (${where})`).toMatch(/^1\b/);
    }
  });
});

/**
 * The helper itself, pinned. Every assertion above is worth exactly what this
 * is worth, and the bug being replaced was in the helper rather than in the
 * rules it was reading.
 */
describe('reading a stylesheet', () => {
  const NESTED = `
.composer-row {
  flex-wrap: wrap;
}

@media (max-width: 700px) {
  .composer-row {
    flex-wrap: nowrap;
  }
}
`;

  it('sees a rule inside a media block, not only the first one in the file', () => {
    const found = everyDeclaration(rulesUsingClass(NESTED, 'composer-row'), 'flex-wrap');
    expect(found.map((d) => d.value)).toEqual(['wrap', 'nowrap']);
    expect(found[1].where).toBe('@media (max-width: 700px)');
  });

  it('does not let one class answer for another that starts the same way', () => {
    const css = '.composer-row-gap { flex: 1; }';
    expect(rulesUsingClass(css, 'composer-row')).toEqual([]);
    expect(rulesUsingClass(css, 'composer-row-gap')).toHaveLength(1);
  });

  it('does not let one property answer for another that starts the same way', () => {
    const css = '.composer-row { flex-wrap: wrap; }';
    expect(everyDeclaration(rulesUsingClass(css, 'composer-row'), 'flex')).toEqual([]);
  });

  it('finds a rule that reaches the class through an ancestor selector', () => {
    const css = '@media (max-width: 700px) { .app-shell.is-narrow .composer-row { flex-wrap: nowrap; } }';
    expect(everyDeclaration(rulesUsingClass(css, 'composer-row'), 'flex-wrap').map((d) => d.value)).toEqual([
      'nowrap',
    ]);
  });

  it('reads past a comment that contains a brace', () => {
    const css = '/* .composer-row { flex-wrap: nowrap } is what this replaces */\n.composer-row { flex-wrap: wrap; }';
    expect(everyDeclaration(rulesUsingClass(css, 'composer-row'), 'flex-wrap').map((d) => d.value)).toEqual(['wrap']);
  });
});
