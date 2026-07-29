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

const SHELL_CSS = path.resolve(__dirname, '../src/styles/app/shell.css');
const CHAT_CSS = path.resolve(__dirname, '../src/styles/app/chat.css');

/** The body of one rule, by selector. Null when the rule is not there at all. */
function ruleBody(css: string, selector: string): string | null {
  const match = new RegExp(`^\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match ? match[1] : null;
}

/**
 * A single-column grid track that cannot be inflated by its content.
 * `1fr` alone is not enough: an `fr` track still floors at min-content unless
 * the minimum is stated as 0, which is the whole point of the `minmax` form.
 */
const UNCONSTRAINED_COLUMN = /grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/;

describe('the working area', () => {
  const css = fs.readFileSync(SHELL_CSS, 'utf8');

  it('lets its column be as narrow as the window, so the top bar cannot outgrow it', () => {
    const body = ruleBody(css, '.app-main');
    expect(body).not.toBeNull();
    expect(body).toMatch(UNCONSTRAINED_COLUMN);
  });

  it('still states its rows, which is what holds the top bar above the screen', () => {
    // The column rule is an addition, not a replacement; losing the rows would
    // trade a horizontal bug for a vertical one.
    expect(ruleBody(css, '.app-main')).toMatch(/grid-template-rows:\s*auto\s+1fr/);
  });
});

describe('the conversation column', () => {
  const css = fs.readFileSync(CHAT_CSS, 'utf8');

  it('lets its column be as narrow as the region, so the composer cannot hang over the edge', () => {
    const body = ruleBody(css, '.chat-column');
    expect(body).not.toBeNull();
    expect(body).toMatch(UNCONSTRAINED_COLUMN);
  });

  it('keeps the transcript-and-composer rows it already had', () => {
    expect(ruleBody(css, '.chat-column')).toMatch(/grid-template-rows:\s*auto\s+minmax\(\s*0\s*,\s*1fr\s*\)/);
  });
});
