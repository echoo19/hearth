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
 *   moments — the toolbar wordmark, launcher wordmark + section headings,
 *   modal/dialog titles, and panel empty-state headings. It may be defined in
 *   fonts.css/tokens.css but referenced nowhere else.
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
  '.toolbar .wordmark', // toolbar wordmark
  '.launcher-brand h1', // launcher wordmark heading
  '.launcher-card h2', // launcher section headings
  '.launcher-section', // launcher section label headings
  '.modal-title', // modal / dialog titles
  '.empty-state > span:not(.empty-icon):not(.hint)', // panel empty-state headings
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
  // SceneView renders entity content on the zoomed/panned canvas, not editor
  // chrome: `t.fontSize` is the user's per-entity game data, and `11 / view.s`
  // counter-scales a screen-space gizmo label against the camera zoom. Both
  // are canvas math, not UI type-scale literals.
  'SceneView.tsx': new Set(['t.fontSize ?? 16', '11 / view.s']),
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
