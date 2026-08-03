import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Style gates for the split CSS system under `apps/editor/src/styles/`, and
 * for inline `fontSize` usage across the editor's TS/TSX source.
 *
 * The editor's ~3,900-line `styles.css` was split into per-concern files
 * (tokens / fonts / base / primitives / workspace / panels/*) and every
 * ad-hoc `font-size` literal replaced with a `--text-*` scale token. These
 * gates keep that discipline enforceable so later panel work can't reintroduce
 * a stray literal or leak the brand display face outside its allowed moments.
 *
 * Gate A — token scale: every real `font-size:` declaration under styles/
 *   (outside tokens.css, where the scale itself is defined), plus the
 *   `styles.css` manifest itself, must be a `var(--text-*)` reference, never
 *   a raw px/rem/em literal. Case-insensitive, since CSS property names and
 *   the `var()` function are case-insensitive. Custom-property *definitions*
 *   (e.g. dockview's `--dv-tab-font-size:`) are not `font-size:` declarations
 *   and are ignored by the matcher.
 *
 * Gate B — brand moments only: the Bricolage display face (`--font-display` /
 *   the literal family name) is reserved for a fixed allowlist of brand
 *   moments — modal/dialog titles and panel empty-state headings. It may be
 *   defined in fonts.css/tokens.css but referenced nowhere else.
 *
 * Gate E — no em or en dashes in anything a person or an agent will READ.
 *   The house voice writes with commas, colons and full stops; a dash slipped
 *   into shipped copy is the single most reliable tell that a string was
 *   generated rather than written, and it has had to be corrected by hand
 *   several times now. Comments are exempt and deliberately so: the prose in
 *   this codebase's comments is written for people reading the source, and
 *   holding it to the product's copy rules would be the wrong trade.
 *
 * Gate C — same token discipline, but for inline `fontSize` in TS/TSX under
 *   `apps/editor/src/**`: every `fontSize:` (object literal) or JSX
 *   `fontSize={...}` assignment must resolve to a `var(--text-*)` string,
 *   unless the file+value pair is on PINNED_LITERAL_ALLOWLIST — reserved for
 *   the two known, deliberate exceptions: CodeMirror/xterm APIs that take a
 *   plain number, and SceneView's canvas content (which renders user-authored
 *   game entities, not editor chrome, and scales with camera zoom rather than
 *   the UI type scale).
 */

const STYLES_DIR = path.resolve(__dirname, '../src/styles');
const MANIFEST_CSS = path.resolve(__dirname, '../src/styles.css');
const SRC_DIR = path.resolve(__dirname, '../src');
const COMPONENTS_DIR = path.resolve(__dirname, '../src/components');
const SERVER_DIR = path.resolve(__dirname, '../server');
const ELECTRON_DIR = path.resolve(__dirname, '../electron');

/**
 * The two dashes the house voice does not use. Not the hyphen, which is a real
 * word-joiner, and not the minus sign.
 */
const DASHES = /[\u2014\u2013]/;

/**
 * Gate D's element-aware scope: raw interactive HTML elements, plus the
 * capitalized components in TITLE_FORWARDING_COMPONENTS below (which spread
 * `title` onto one of these same tags under the hood). A native `title=` on
 * one of these is a hover-only, keyboard-invisible, un-styled hint — exactly
 * what the Tooltip / IconButton primitives replace. Non-interactive elements
 * (spans/divs/labels/options carrying truncated-text or a field description)
 * are deliberately OUT of scope: a native `title` is the right tool for "show
 * the full value when this text is clipped", and those elements have no
 * focus/hover primitive to migrate to. That carve-out IS the allowlist
 * policy — there is no per-line pin list because no interactive element is
 * permitted to keep a native title.
 */
const INTERACTIVE_TAGS = new Set(['button', 'a', 'select', 'input', 'textarea']);

/**
 * Gate D's other blind spot: `Button`/`IconButton` (ui/Button.tsx) both spread
 * `{...rest}` onto a raw `<button>` — a `title` prop passed to either one
 * forwards straight onto the native element exactly like a literal `title=`
 * on `<button>` would, but the tag-name scan above skips capitalized JSX
 * elements (`if (tagName[0] !== tagName[0].toLowerCase()) continue`) since
 * most components manage `title` as their own semantic prop (e.g. `Modal`'s
 * dialog heading, `ConfirmDialog`'s). Pinned by exact name rather than
 * inferred structurally — no static check here can tell "spreads onto a raw
 * element" apart from "consumes title as its own prop", so a new spreading
 * component must be added to this set deliberately. Currently, nothing in
 * the tree passes `title` to either component; this only guards
 * against a future regression.
 */
const TITLE_FORWARDING_COMPONENTS = new Set(['Button', 'IconButton']);

/**
 * Escape hatch for a genuinely-justified native title on an interactive element
 * (none today — every interactive title was migrated to Tooltip/IconButton).
 * Keyed by file basename → set of substrings; if a flagged
 * opening tag contains a listed substring it is exempt. Adding an entry is a
 * deliberate, reviewed edit.
 */
const PINNED_TITLE_ALLOWLIST: Record<string, Set<string>> = {};

/**
 * Walk from the `<` at `start` to the `>` that ends the opening tag, tracking
 * brace depth and skipping string literals so a `title={`…${x}…`}` value's
 * inner braces/quotes don't end the scan early. Returns the opening-tag text.
 */
function openingTag(content: string, start: number): string {
  let depth = 0;
  let i = start;
  let quote = '';
  for (; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === quote && content[i - 1] !== '\\') quote = '';
      continue;
    }
    // `//` line comments live inside handler bodies (`onDrop={() => { // … }}`)
    // and their prose can contain lone quotes ("isn't") that would otherwise
    // open a false string and swallow the rest of the tag. Skip to EOL.
    if (c === '/' && content[i + 1] === '/') {
      i = content.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) break;
  }
  return content.slice(start, i + 1);
}

/** Files that may legitimately contain the raw scale / display-face definition. */
const TOKEN_FILES = new Set(['tokens.css']);
const FONT_DEF_FILES = new Set(['tokens.css', 'fonts.css']);

/**
 * The ONLY selectors permitted to reference `--font-display` / Bricolage.
 * Pinned exactly (whitespace-normalized) so adding a new brand moment is a
 * deliberate edit to this list, reviewed against the "brand moments only"
 * rule from the design spec.
 */
const BRAND_MOMENT_SELECTORS = new Set<string>([
  // The named role for the brand voice (styles/primitives.css). The display
  // face is no longer a separate FAMILY — it is the UI family at --fw-display
  // with --track-tight — so what this gate now protects is the treatment
  // rather than the webfont. That is still worth protecting: the whole point
  // of a brand moment is that there are four of them, and a heaviest-tightest
  // treatment applied to a fifth thing makes all five ordinary.
  '.t-display',
  '.modal-title', // modal / dialog titles
  '.empty-state > span:not(.empty-icon):not(.hint)', // panel empty-state headings
  '.chat-empty-lead', // conversation empty state — the app's first sentence
  '.game-empty-lead', // game pane empty state heading
  '.tester-empty-lead', // tester pane empty state heading, the same moment as above
]);

/**
 * Gate C's pinned allowlist: (file basename, exact trimmed value) pairs that
 * are allowed to carry a non-token `fontSize`. Anything not on this list must
 * be a `var(--text-*)` string.
 */
const PINNED_LITERAL_ALLOWLIST: Record<string, Set<string>> = {
  // xterm's constructor option is typed as `number` — it cannot take a CSS
  // var string. See the inline comment at Terminal.tsx's `fontSize: 12`.
  'Terminal.tsx': new Set(['12']),
};

function collectFiles(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, extensions));
    else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** Strip `/* ... *\/` comments, replacing with spaces to keep indices stable. */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Strip BOTH comment forms, for Gate E, which cares what a line says rather
 * than where it sits. Separate from `stripComments` on purpose: the other
 * gates report positions and need indices to stay stable, and this one throws
 * the offset away.
 *
 * The `[^:]` guard is what keeps `https://` from being read as the start of a
 * comment and eating the rest of a URL string.
 */
function stripAllComments(content: string): string {
  return stripComments(content).replace(/(^|[^:])\/\/[^\n]*/gm, (_match, before: string) => before);
}

function rel(absPath: string, base: string): string {
  return path.relative(base, absPath).split(path.sep).join('/');
}

/**
 * True for a `var(--text-*)` reference, with or without surrounding quotes
 * (Gate A reads raw CSS values; Gate C reads JS string literals like
 * `'var(--text-sm)'`). Case-insensitive throughout, since CSS property names
 * and the `var()` function are case-insensitive.
 */
function isTextToken(value: string): boolean {
  const unquoted = value.replace(/^['"]|['"]$/g, '');
  return /^var\(--text-[\w-]+\)$/i.test(unquoted);
}

describe('style gates', () => {
  it('has the split styles/ directory', () => {
    expect(fs.existsSync(STYLES_DIR)).toBe(true);
  });

  /**
   * The failure this guards is a real one: at a narrow width the dev-team board
   * used to push its controls past the right edge, so Pause and Stop became
   * unreachable on exactly the runs a person most wants to stop. A second
   * measured failure at 520px was a fixed track squeezing the only line still
   * showing words down to a single character.
   *
   * Written against the INTENT rather than the markup, because this pane has
   * been restructured twice and each time a shape-locked version of this test
   * failed on a layout that had in fact fixed the overflow rather than
   * reintroducing it. What has to stay true: the board becomes one column, the
   * lead's identity stops sharing a row with its status, the crew loses its
   * indent, the controls keep their natural width, and the plan wraps rather
   * than scrolling sideways.
   */
  it('keeps the narrow dev-team controls reachable without horizontal overflow', () => {
    const css = fs.readFileSync(path.join(STYLES_DIR, 'app/devteam.css'), 'utf8');
    const start = css.indexOf('@media (max-width: 680px)');
    const end = css.indexOf('@media (prefers-reduced-motion: reduce)', start);
    expect(start).toBeGreaterThan(-1);
    const narrow = css.slice(start, end);

    // Narrow mode also arrives without the viewport being narrow: the project
    // rail can leave the conversation in a sliver of a wide window, and that is
    // the case the media query alone never sees. Both paths do the same work.
    const measured = css.slice(0, start);
    for (const block of [narrow, measured]) {
      // The run's column stops being a fixed track beside the work, and goes
      // ABOVE it rather than under it: it follows the stage in the DOM, so
      // without the order it was placed in the row the composer covers, and
      // Pause and Stop could not be reached at all.
      expect(block).toMatch(/\.devteam-team\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
      expect(block).toMatch(/\.devteam-rail\s*\{[^}]*order:\s*-1/);
      // Laid out as a row, the steps wrap rather than pushing the rest off the
      // edge, and a name track that can shrink to zero does: measured at 520px
      // the live step squeezed down to a single character.
      expect(block).toMatch(/\.devteam-steps\s*\{[^}]*flex-wrap:\s*wrap/);
      expect(block).toMatch(/\.devteam-steps li\s*\{[^}]*grid-template-columns:\s*22px auto/);
      // The cards stack rather than forcing a sideways scroll past the 10rem
      // minimum the grid asks for, and stop being squares: at this width a
      // square card is taller than the region showing it.
      expect(block).toMatch(/\.devteam-lanes\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
      expect(block).toMatch(/\.devteam-card\s*\{[^}]*aspect-ratio:\s*auto/);
      // The controls lay out along the row and keep their natural width rather
      // than staying a column of full-width buttons in a horizontal strip.
      expect(block).toMatch(/\.devteam-controls\s*\{[^}]*flex-direction:\s*row/);
      expect(block).toMatch(/\.devteam-controls \.btn\s*\{[^}]*width:\s*auto/);
    }
  });

  /**
   * A card is a summary and its lines have to stop at its edge. They did not:
   * the last line an engineer said was printed in mono with `nowrap`, and at
   * 15rem it left the card and ran clear across the board and out the other
   * side, over the two cards beside it. Every line on a card clips now, and the
   * card clips whatever a future line forgets to.
   */
  it('keeps every line of a member card inside the card', () => {
    const css = fs.readFileSync(path.join(STYLES_DIR, 'app/devteam.css'), 'utf8');
    const rule = (selector: string): string => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };

    expect(rule('.devteam-card')).toMatch(/overflow:\s*hidden/);
    expect(rule('.devteam-card')).toMatch(/min-width:\s*0/);
    // The three text lines: two clip to one line, the assignment to two.
    for (const line of ['.devteam-card-name', '.devteam-card-role']) {
      expect(rule(line), line).toMatch(/text-overflow:\s*ellipsis/);
      expect(rule(line), line).toMatch(/white-space:\s*nowrap/);
    }
    // Any rule for it, not the first: the three lines share a max-width rule
    // whose selector list starts with this class.
    expect(css).toMatch(/\.devteam-card-task \{[^}]*line-clamp:\s*2/);
    expect(css).toMatch(/\.devteam-card-name,\n\.devteam-card-role,\n\.devteam-card-task \{[^}]*max-width:\s*100%/);
  });

  /**
   * The team screen has one vertical axis and everything on it is on that axis.
   *
   * Measured on a real board, three engineers packed into the left 60% under a
   * lead card centred over the whole width, with four hundred pixels of nothing
   * beside them: `auto-fill` keeps the empty tracks and a `1fr` cap let the
   * cards be whatever width was left over, so they were neither centred nor the
   * lead's size. The view's head was the same fault one screen over, sitting at
   * the gutter while the conversation it heads sits at the measure.
   */
  it('keeps the team board and the member head on the axis of what they sit over', () => {
    const css = fs.readFileSync(path.join(STYLES_DIR, 'app/devteam.css'), 'utf8');
    const rule = (selector: string): string => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };

    const lanes = rule('.devteam-lanes');
    // Empty tracks have to collapse and the cards have to be a fixed width,
    // or there is nothing for the centring to act on.
    expect(lanes).toMatch(/grid-template-columns:\s*repeat\(auto-fit,/);
    expect(lanes).toMatch(/justify-content:\s*center/);
    const capped = /minmax\(\s*[\d.]+rem\s*,\s*([\d.]+)rem\s*\)/.exec(lanes);
    expect(capped, 'the crew track needs a fixed cap, not 1fr').not.toBeNull();
    // The same width the lead slot sets: one card, worn by everybody.
    expect(rule('.devteam-lead-slot .devteam-card')).toMatch(new RegExp(`width:\\s*${capped![1]}rem`));

    // The head lines up with the transcript under it, with the gutter as a
    // floor so a pane too narrow for the measure is left alone.
    expect(rule('.devteam-view-head')).toMatch(
      /padding:[^;]*max\(\s*var\(--chat-gutter\)\s*,\s*\(100% - var\(--chat-measure\)\) \/ 2\s*\)/,
    );
  });

  it('Gate A: every font-size under styles/ (and the styles.css manifest) uses a --text-* token', () => {
    const files = [...collectFiles(STYLES_DIR, ['.css']), MANIFEST_CSS];
    const offenders: string[] = [];

    // A real declaration: `font-size:` at the start of a declaration (after
    // `{`, `;`, or line start + whitespace). This deliberately does NOT match
    // custom-property names like `--dv-tab-font-size:` (preceded by `-`).
    // Case-insensitive: CSS property names and `var()` are case-insensitive.
    const DECL_RE = /(?:^|[;{])[ \t]*font-size[ \t]*:[ \t]*([^;}]*)/gi;

    for (const file of files) {
      if (TOKEN_FILES.has(path.basename(file))) continue;
      const content = fs.readFileSync(file, 'utf8');
      for (const m of content.matchAll(DECL_RE)) {
        const value = m[1].trim();
        if (!isTextToken(value)) {
          offenders.push(`${rel(file, STYLES_DIR)}:${lineAt(content, m.index!)} → font-size: ${value}`);
        }
      }
    }

    if (offenders.length > 0) {
      expect.fail(
        `Found ${offenders.length} font-size literal(s) not using a --text-* token:\n` +
          offenders.map((o) => `  ${o}`).join('\n') +
          `\n\nReplace each with the nearest --text-* token (see tokens.css).`,
      );
    }
  });

  it('Gate B: --font-display / Bricolage appears only on brand-moment selectors', () => {
    const files = collectFiles(STYLES_DIR, ['.css']);
    const offenders: string[] = [];

    // Innermost rule blocks: `selector { body-without-braces }`.
    const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;

    for (const file of files) {
      if (FONT_DEF_FILES.has(path.basename(file))) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const content = stripComments(raw);
      for (const m of content.matchAll(RULE_RE)) {
        const body = m[2];
        if (!/--font-display|bricolage/i.test(body)) continue;
        const selector = m[1].replace(/\s+/g, ' ').trim();
        if (!BRAND_MOMENT_SELECTORS.has(selector)) {
          offenders.push(`${rel(file, STYLES_DIR)}:${lineAt(content, m.index!)} → ${selector}`);
        }
      }
    }

    if (offenders.length > 0) {
      expect.fail(
        `Found ${offenders.length} non-brand selector(s) referencing the display face:\n` +
          offenders.map((o) => `  ${o}`).join('\n') +
          `\n\nThe Bricolage display face is for brand moments only. Either revert to the ` +
          `UI font or add the selector to BRAND_MOMENT_SELECTORS with justification.`,
      );
    }
  });

  it('Gate C: every inline fontSize under src/**/*.{ts,tsx} uses a --text-* token or is pinned', () => {
    const files = collectFiles(SRC_DIR, ['.ts', '.tsx']);
    const offenders: string[] = [];

    // Object-literal style: `fontSize: <value>` (CodeMirror themes, xterm
    // options, inline `style={{ }}` objects). Excludes member-access reads
    // like `t.fontSize` by requiring the match not be preceded by `.` or a
    // word character.
    const COLON_RE = /(?<![.\w])fontSize[ \t]*:[ \t]*([^,;\n}]+)/g;
    // JSX attribute style: `fontSize={<value>}`, e.g. SceneView's SVG props.
    const JSX_RE = /(?<![.\w])fontSize[ \t]*=[ \t]*\{([^{}]*)\}/g;

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const base = path.basename(file);
      const allowlist = PINNED_LITERAL_ALLOWLIST[base];

      for (const RE of [COLON_RE, JSX_RE]) {
        for (const m of content.matchAll(RE)) {
          const value = m[1].trim().replace(/,$/, '').trim();
          if (isTextToken(value)) continue;
          if (allowlist?.has(value)) continue;
          offenders.push(`${rel(file, SRC_DIR)}:${lineAt(content, m.index!)} → fontSize: ${value}`);
        }
      }
    }

    if (offenders.length > 0) {
      expect.fail(
        `Found ${offenders.length} fontSize literal(s) not using a --text-* token:\n` +
          offenders.map((o) => `  ${o}`).join('\n') +
          `\n\nReplace each with the nearest --text-* token (see styles/tokens.css), or add a ` +
          `justified entry to PINNED_LITERAL_ALLOWLIST if the API genuinely requires a raw value.`,
      );
    }
  });

  /**
   * Gate D's scan, factored out so it can run both against the real
   * `src/components/**` tree (the actual gate) and against a throwaway
   * fixture directory (the regression test below proving the
   * TITLE_FORWARDING_COMPONENTS blind-spot check actually fires).
   */
  function findTitleOffenders(dir: string): string[] {
    const files = collectFiles(dir, ['.tsx']);
    const offenders: string[] = [];

    // Every JSX opening tag: `<` followed by a tag name.
    const TAG_RE = /<([A-Za-z][\w-]*)/g;

    for (const file of files) {
      const content = stripComments(fs.readFileSync(file, 'utf8'));
      const base = path.basename(file);
      const allow = PINNED_TITLE_ALLOWLIST[base];

      for (const m of content.matchAll(TAG_RE)) {
        const tagName = m[1];
        const isForwarding = TITLE_FORWARDING_COMPONENTS.has(tagName);
        // Lowercase HTML tags always matter; capitalized components only
        // matter when pinned as a known title-forwarder (Button/IconButton
        // spread `{...rest}` onto a raw <button> — see the set's comment).
        // Everything else (`<Modal>`, `<ConfirmDialog>`) treats `title` as
        // its own semantic prop, not a DOM passthrough.
        if (tagName[0] !== tagName[0].toLowerCase() && !isForwarding) continue;

        const tag = openingTag(content, m.index!);
        if (!/\btitle\s*=/.test(tag)) continue;

        const isInteractive =
          isForwarding || INTERACTIVE_TAGS.has(tagName) || /\brole\s*=\s*(['"`{]\s*['"`]?)button\b/.test(tag);
        if (!isInteractive) continue;
        if (allow && [...allow].some((s) => tag.includes(s))) continue;

        offenders.push(`${rel(file, dir)}:${lineAt(content, m.index!)} → <${tagName} … title=…>`);
      }
    }
    return offenders;
  }

  it('Gate D: no native title= on interactive elements under src/components/**', () => {
    const offenders = findTitleOffenders(COMPONENTS_DIR);

    if (offenders.length > 0) {
      expect.fail(
        `Found ${offenders.length} native title= on interactive element(s):\n` +
          offenders.map((o) => `  ${o}`).join('\n') +
          `\n\nInteractive controls must carry their hint via the Tooltip primitive ` +
          `(or IconButton's required label), which shows on hover AND keyboard focus. ` +
          `A native title is hover-only and invisible to keyboard users. Non-interactive ` +
          `truncated-text elements (spans/divs/labels/options) may keep a native title.`,
      );
    }
  });

  it('Gate F keeps source files text, so git and grep can still read them', () => {
    // A literal NUL byte makes git call a file binary. The whole global Tester
    // screen landed as `Bin 8365 -> 9250` with no reviewable diff, and `grep -r`
    // skipped the file silently while reporting nothing found. Both failures
    // are quiet, which is what makes them worth a gate: `\u0000` in a string
    // literal is byte-identical at runtime and keeps the file text.
    const offenders: string[] = [];
    for (const dir of [SRC_DIR, SERVER_DIR, ELECTRON_DIR, path.resolve(__dirname)]) {
      if (!fs.existsSync(dir)) continue;
      for (const file of collectFiles(dir, ['.ts', '.tsx', '.css'])) {
        if (fs.readFileSync(file).includes(0)) offenders.push(rel(file, path.resolve(__dirname, '..')));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps transcript headings ranked, wrapped and grouped with their body', () => {
    const css = fs.readFileSync(path.join(STYLES_DIR, 'app/chat.css'), 'utf8');

    expect(css).toMatch(/\.md-heading\s*{[^}]*text-wrap:\s*balance;[^}]*overflow-wrap:\s*anywhere;/s);
    expect(css).toMatch(/\.md-h1\s*{[^}]*font-size:\s*var\(--text-2xl\);/s);
    expect(css).toMatch(/\.md-h2\s*{[^}]*font-size:\s*var\(--text-xl\);/s);
    expect(css).toMatch(/\.md-h3\s*{[^}]*font-size:\s*var\(--text-lg\);/s);
    expect(css).toMatch(/\.md-h4\s*{[^}]*font-size:\s*var\(--text-md\);/s);
    expect(css).toMatch(/\.md-h5\s*{[^}]*font-size:\s*var\(--text-sm\);/s);
    expect(css).toMatch(/\.md-h6\s*{[^}]*font-size:\s*var\(--text-xs\);/s);
    expect(css).toMatch(/\.md-heading\s*\+\s*\.md-block\s*{[^}]*margin-top:\s*0\.6em;/s);
  });

  it('Gate E keeps em and en dashes out of everything that ships as words', () => {
    const offenders: string[] = [];
    for (const dir of [SRC_DIR, SERVER_DIR, ELECTRON_DIR]) {
      if (!fs.existsSync(dir)) continue;
      for (const file of collectFiles(dir, ['.ts', '.tsx'])) {
        // Comments are exempt: they are written for whoever is reading the
        // source, not for whoever is using the app.
        const code = stripAllComments(fs.readFileSync(file, 'utf8'));
        code.split('\n').forEach((line, index) => {
          if (!DASHES.test(line)) return;
          offenders.push(`${rel(file, path.resolve(__dirname, '..'))}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Gate E ignores comments and catches strings, so it can be lived with', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-gate-fixture-'));
    try {
      const file = path.join(fixtureDir, 'Fixture.tsx');
      fs.writeFileSync(
        file,
        `/** A comment with an em dash \u2014 which is fine and stays fine. */\n` +
          `// So is a line comment \u2014 like this one.\n` +
          `export const COPY = 'Nothing is connected \u2014 open Settings.';\n` +
          `export const FINE = 'Nothing is connected. Open Settings.';\n`,
      );
      const lines = stripAllComments(fs.readFileSync(file, 'utf8')).split('\n');
      const hits = lines.filter((line) => DASHES.test(line));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('COPY');
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('Gate D catches a title= forwarded through Button/IconButton, not just a raw tag', () => {
    // Regression fixture for the blind spot: `title` passed to `<Button>` or
    // `<IconButton>` never shows up as a lowercase tag, but both spread
    // `{...rest}` onto a raw <button> (ui/Button.tsx), so it forwards to the
    // DOM exactly like a literal `title=` on `<button>` would.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-gate-fixture-'));
    try {
      fs.writeFileSync(
        path.join(fixtureDir, 'Fixture.tsx'),
        `export const Fixture = () => (\n` +
          `  <div>\n` +
          `    <Button title="oops">Save</Button>\n` +
          `    <IconButton icon="cross" label="Close" title="oops too" />\n` +
          `    <Modal title="Not a DOM title, fine" open onClose={() => {}}>hi</Modal>\n` +
          `  </div>\n` +
          `);\n`,
      );
      const offenders = findTitleOffenders(fixtureDir);
      expect(offenders).toHaveLength(2);
      expect(offenders.some((o) => o.includes('<Button'))).toBe(true);
      expect(offenders.some((o) => o.includes('<IconButton'))).toBe(true);
      expect(offenders.some((o) => o.includes('<Modal'))).toBe(false);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
