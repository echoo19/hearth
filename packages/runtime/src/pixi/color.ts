/**
 * Pure hex-color and number lerp helpers for particle rendering (start/end
 * color and start/end size over a particle's lifetime). Kept dependency-free
 * (no Pixi import) so it's cheap to unit test headlessly.
 */

/** Parse #rgb / #rrggbb / #rrggbbaa (alpha channel, if present, is ignored). */
function parseHex(color: string): { r: number; g: number; b: number } {
  const hex = color.trim().replace(/^#/, '');
  if (hex.length === 3) {
    const r = hex[0] + hex[0];
    const g = hex[1] + hex[1];
    const b = hex[2] + hex[2];
    return { r: parseInt(r, 16), g: parseInt(g, 16), b: parseInt(b, 16) };
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function toHex2(n: number): string {
  return Math.round(n).toString(16).padStart(2, '0');
}

/**
 * Parse #rgb / #rrggbb / #rrggbbaa into a normalized [r, g, b] triple in
 * [0, 1] (alpha ignored) — the shape filter shaders want their color uniforms
 * in. Reuses the same lenient hex parsing as {@link lerpColor}.
 */
export function hexToRgb01(color: string): [number, number, number] {
  const { r, g, b } = parseHex(color);
  return [r / 255, g / 255, b / 255];
}

/** Clamp t into [0, 1]. */
function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/** Linear-interpolate between two numbers, clamping t to [0, 1]. */
export function lerp(a: number, b: number, t: number): number {
  const c = clamp01(t);
  return a + (b - a) * c;
}

/**
 * Linear-interpolate between two hex colors (#rgb / #rrggbb / #rrggbbaa) at
 * t in [0, 1] (clamped). Always returns a normalized `#rrggbb` string.
 */
export function lerpColor(from: string, to: string, t: number): string {
  const c = clamp01(t);
  const a = parseHex(from);
  const b = parseHex(to);
  const r = lerp(a.r, b.r, c);
  const g = lerp(a.g, b.g, c);
  const bch = lerp(a.b, b.b, c);
  return `#${toHex2(r)}${toHex2(g)}${toHex2(bch)}`;
}
