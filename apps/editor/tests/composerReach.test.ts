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
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CHAT_CSS = path.resolve(__dirname, '../src/styles/app/chat.css');

/** The body of one rule, by selector. Null when the rule is not there at all. */
function ruleBody(css: string, selector: string): string | null {
  // Anchored on a line start so `.composer-row` does not match
  // `.composer-row-gap`, and the selector must be the whole line.
  const match = new RegExp(`^\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match ? match[1] : null;
}

describe('the composer control row', () => {
  const css = fs.readFileSync(CHAT_CSS, 'utf8');

  it('wraps, so the send button cannot be pushed off the window', () => {
    const body = ruleBody(css, '.composer-row');
    expect(body).not.toBeNull();
    expect(body).toMatch(/flex-wrap:\s*wrap/);
  });

  it('lets its controls shrink before the row is forced to wrap', () => {
    // `min-width: 0` is the only thing that lets a flex item go narrower than
    // its content, so without it the row wraps far earlier than it needs to
    // and the common case stops being one line.
    expect(ruleBody(css, '.composer-row > \\*')).toMatch(/min-width:\s*0/);
  });

  it('keeps send last, so a wrap gives it a line rather than stranding a pill', () => {
    // The gap element is what pushes send to the right; if it ever stopped
    // growing, the wrap would put send in the middle of the second line.
    expect(ruleBody(css, '.composer-row-gap')).toMatch(/flex:\s*1/);
  });
});
