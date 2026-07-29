/**
 * The faintest ink still has to be readable on every surface it lands on.
 *
 * PRODUCT.md commits to "contrast >= 4.5:1 for body text against panel
 * backgrounds". `--ink-faint` was the one rank that did not keep it. Measured
 * from the rendered colours in a browser, at its old L 0.58 it cleared 4.5:1
 * only on the darkest surfaces:
 *
 *   --bg-0 4.76   --bg-05 4.67   --bg-1 4.59
 *   --bg-2 4.33   --bg-3 (hover) 3.79   --accent-soft row 4.16
 *
 * So a timestamp in the rail passed at rest and failed the moment you pointed
 * at it, and the SELECTED conversation — the row a person looks at most, and
 * the one tinted with `--accent-soft` — was the least readable row in the
 * list. None of that is visible to the rest of this suite: jsdom resolves no
 * custom properties and computes no colour, so the numbers have to be worked
 * out from the tokens themselves.
 *
 * This computes rather than pins. Asserting `--ink-faint: oklch(0.635 ...)`
 * would freeze today's answer and say nothing about why; asserting the ratio
 * means the guarantee survives someone retuning a surface, and fails on the
 * change that actually hurts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TOKENS_CSS = path.resolve(__dirname, '../src/styles/tokens.css');

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** OKLCH -> linear sRGB -> gamma-encoded sRGB, clamped to gamut as a display is. */
function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const bb = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;

  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, c)) * 255;
  });

  return { r: lin[0], g: lin[1], b: lin[2] };
}

/** WCAG 2.1 relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const f = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Source-over composite of a translucent colour on an opaque one. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

const css = fs.readFileSync(TOKENS_CSS, 'utf8');

/**
 * Read one token's `oklch(L C H)` or `oklch(L C H / A)` value out of the
 * stylesheet. Deliberately strict: a token that stops being plain oklch should
 * fail loudly here rather than be silently skipped.
 */
function token(name: string): { rgb: Rgb; alpha: number } {
  const re = new RegExp(`${name}:\\s*oklch\\(([^)]+)\\)`);
  const match = re.exec(css);
  if (!match) throw new Error(`token ${name} not found as a plain oklch() value`);
  const [coords, alphaText] = match[1].split('/');
  const [L, C, H] = coords.trim().split(/\s+/).map(Number);
  const alpha = alphaText === undefined ? 1 : Number(alphaText.trim());
  return { rgb: oklchToRgb(L, C, H), alpha };
}

/** Every opaque surface a piece of text can sit on. */
const SURFACES = ['--bg-0', '--bg-05', '--bg-1', '--bg-2', '--bg-3'] as const;

describe('the oklch maths', () => {
  it('agrees with what a browser renders, so the ratios below mean something', () => {
    // Chrome resolved these two exactly, read back off the live editor.
    const ink = token('--ink').rgb;
    expect([ink.r, ink.g, ink.b].map(Math.round)).toEqual([240, 238, 234]);
    const bg0 = token('--bg-0').rgb;
    expect([bg0.r, bg0.g, bg0.b].map(Math.round)).toEqual([5, 5, 7]);
  });
});

describe('every ink rank against every surface', () => {
  for (const ink of ['--ink', '--ink-mute', '--ink-faint'] as const) {
    for (const surface of SURFACES) {
      it(`${ink} on ${surface} clears 4.5:1`, () => {
        const ratio = contrast(token(ink).rgb, token(surface).rgb);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('the selected conversation row', () => {
  /**
   * The rail tints the current row with `--accent-soft` over `--bg-0`, which
   * lifts the background out from under the faintest ink. This is the case
   * that was actually failing in the shipped app, at 4.16:1.
   */
  const selected = (): Rgb => {
    const accent = token('--accent-soft');
    return over(accent.rgb, accent.alpha, token('--bg-0').rgb);
  };

  it('is the tint the rail actually paints, not an opaque colour', () => {
    expect(token('--accent-soft').alpha).toBeLessThan(1);
  });

  for (const ink of ['--ink', '--ink-mute', '--ink-faint'] as const) {
    it(`${ink} on it clears 4.5:1`, () => {
      expect(contrast(token(ink).rgb, selected())).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('the ink ramp', () => {
  it('keeps three distinct ranks, so fixing contrast did not flatten the hierarchy', () => {
    // Raising --ink-faint is only correct while it stays visibly the faintest;
    // if it ever climbs past --ink-mute the tokens have stopped meaning
    // anything, and every "quiet" label in the app becomes body text.
    const l = (n: string): number => luminance(token(n).rgb);
    expect(l('--ink')).toBeGreaterThan(l('--ink-mute'));
    expect(l('--ink-mute')).toBeGreaterThan(l('--ink-faint'));
  });
});

describe('the focus ring', () => {
  it('meets the 3:1 non-text minimum on every surface it can be drawn over', () => {
    // base.css draws one ring for the whole app: `2px solid var(--accent)`
    // with a 1px offset, so the colour it lands on is always a surface.
    const accent = token('--accent').rgb;
    for (const surface of SURFACES) {
      expect(contrast(accent, token(surface).rgb)).toBeGreaterThanOrEqual(3);
    }
  });
});
