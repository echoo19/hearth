import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Style gates for the split CSS system under `apps/editor/src/styles/`.
 *
 * The editor's ~3,900-line `styles.css` was split into per-concern files
 * (tokens / fonts / base / primitives / workspace / panels/*) and every
 * ad-hoc `font-size` literal replaced with a `--text-*` scale token. These
 * gates keep that discipline enforceable so later panel work can't reintroduce
 * a stray literal or leak the brand display face outside its allowed moments.
 *
 * Gate A — token scale: every real `font-size:` declaration under styles/
 *   (outside tokens.css, where the scale itself is defined) must be a
 *   `var(--text-*)` reference, never a raw px/rem/em literal. Custom-property
 *   *definitions* (e.g. dockview's `--dv-tab-font-size:`) are not `font-size:`
 *   declarations and are ignored by the matcher.
 *
 * Gate B — brand moments only: the Bricolage display face (`--font-display` /
 *   the literal family name) is reserved for a fixed allowlist of brand
 *   moments — the toolbar wordmark, launcher wordmark + section headings,
 *   modal/dialog titles, and panel empty-state headings. It may be defined in
 *   fonts.css/tokens.css but referenced nowhere else.
 */

const STYLES_DIR = path.resolve(__dirname, '../src/styles');

/** Files that may legitimately contain the raw scale / display-face definition. */
const TOKEN_FILES = new Set(['tokens.css']);
const FONT_DEF_FILES = new Set(['tokens.css', 'fonts.css']);

/**
 * The ONLY selectors permitted to reference `--font-display` / Bricolage.
 * Pinned exactly (whitespace-normalized) so adding a new brand moment is a
 * deliberate edit to this list, reviewed against the "brand moments only"
 * rule from the Wave L design spec.
 */
const BRAND_MOMENT_SELECTORS = new Set<string>([
  '.toolbar .wordmark', // toolbar wordmark
  '.launcher-brand h1', // launcher wordmark heading
  '.launcher-card h2', // launcher section headings
  '.launcher-section', // launcher section label headings
  '.modal-title', // modal / dialog titles
  '.empty-state > span:not(.empty-icon):not(.hint)', // panel empty-state headings
]);

function collectCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCssFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.css')) out.push(full);
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

function rel(absPath: string): string {
  return path.relative(STYLES_DIR, absPath).split(path.sep).join('/');
}

describe('style gates', () => {
  it('has the split styles/ directory', () => {
    expect(fs.existsSync(STYLES_DIR)).toBe(true);
  });

  it('Gate A: every font-size under styles/ uses a --text-* token', () => {
    const files = collectCssFiles(STYLES_DIR);
    const offenders: string[] = [];

    // A real declaration: `font-size:` at the start of a declaration (after
    // `{`, `;`, or line start + whitespace). This deliberately does NOT match
    // custom-property names like `--dv-tab-font-size:` (preceded by `-`).
    const DECL_RE = /(?:^|[;{])[ \t]*font-size[ \t]*:[ \t]*([^;}]*)/g;

    for (const file of files) {
      if (TOKEN_FILES.has(path.basename(file))) continue;
      const content = fs.readFileSync(file, 'utf8');
      for (const m of content.matchAll(DECL_RE)) {
        const value = m[1].trim();
        if (!/^var\(--text-[\w-]+\)/.test(value)) {
          offenders.push(`${rel(file)}:${lineAt(content, m.index!)} → font-size: ${value}`);
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
    const files = collectCssFiles(STYLES_DIR);
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
          offenders.push(`${rel(file)}:${lineAt(content, m.index!)} → ${selector}`);
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
});
