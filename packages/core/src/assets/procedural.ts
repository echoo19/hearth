/**
 * Procedural placeholder asset generation.
 *
 * Deterministic, dependency-free SVG sprites so agents can build a playable
 * game end-to-end before real art exists. SVG is human-readable, diffs well,
 * and loads as a texture in the Pixi renderer.
 */

export type SpriteShape =
  | 'rectangle'
  | 'circle'
  | 'triangle'
  | 'diamond'
  | 'star'
  | 'capsule'
  | 'polygon'
  | 'character'
  | 'enemy'
  | 'coin'
  | 'heart';

export interface SpriteSpec {
  shape: SpriteShape;
  color: string;
  width?: number;
  height?: number;
  /** Secondary color for detailed shapes (character eyes, coin rim...). */
  accentColor?: string;
  /** For shape="polygon": number of sides (3-12). */
  sides?: number;
  /** Optional outline. */
  strokeColor?: string;
  strokeWidth?: number;
  /** Corner radius for rectangles. */
  cornerRadius?: number;
}

function darken(hex: string, factor = 0.6): string {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m.slice(0, 6);
  const n = parseInt(full, 16);
  const r = Math.round(((n >> 16) & 0xff) * factor);
  const g = Math.round(((n >> 8) & 0xff) * factor);
  const b = Math.round((n & 0xff) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function polygonPoints(cx: number, cy: number, radius: number, sides: number, rotation = -90): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = ((rotation + (360 / sides) * i) * Math.PI) / 180;
    pts.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function starPoints(cx: number, cy: number, outer: number, inner: number, points = 5): string {
  const pts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = ((-90 + (180 / points) * i) * Math.PI) / 180;
    pts.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** Generate SVG markup for a sprite spec. Deterministic: same spec -> same SVG. */
export function generateSpriteSvg(spec: SpriteSpec): string {
  const w = spec.width ?? 32;
  const h = spec.height ?? 32;
  const color = spec.color;
  const accent = spec.accentColor ?? darken(color);
  const stroke = spec.strokeColor
    ? ` stroke="${spec.strokeColor}" stroke-width="${spec.strokeWidth ?? 2}"`
    : '';
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - (spec.strokeWidth ?? 0);

  let body: string;
  switch (spec.shape) {
    case 'rectangle':
      body = `<rect x="0" y="0" width="${w}" height="${h}" rx="${spec.cornerRadius ?? 0}" fill="${color}"${stroke}/>`;
      break;
    case 'circle':
      body = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"${stroke}/>`;
      break;
    case 'triangle':
      body = `<polygon points="${polygonPoints(cx, cy, r, 3)}" fill="${color}"${stroke}/>`;
      break;
    case 'diamond':
      body = `<polygon points="${polygonPoints(cx, cy, r, 4)}" fill="${color}"${stroke}/>`;
      break;
    case 'star':
      body = `<polygon points="${starPoints(cx, cy, r, r * 0.45)}" fill="${color}"${stroke}/>`;
      break;
    case 'capsule': {
      const radius = Math.min(w, h) / 2;
      body = `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="${color}"${stroke}/>`;
      break;
    }
    case 'polygon': {
      const sides = Math.min(12, Math.max(3, spec.sides ?? 6));
      body = `<polygon points="${polygonPoints(cx, cy, r, sides)}" fill="${color}"${stroke}/>`;
      break;
    }
    case 'character': {
      // Simple friendly capsule character with eyes and feet.
      const eyeR = Math.max(1.5, w * 0.07);
      const eyeY = h * 0.32;
      body = [
        `<rect x="${w * 0.1}" y="0" width="${w * 0.8}" height="${h * 0.9}" rx="${w * 0.25}" fill="${color}"${stroke}/>`,
        `<circle cx="${w * 0.35}" cy="${eyeY}" r="${eyeR * 1.8}" fill="#ffffff"/>`,
        `<circle cx="${w * 0.65}" cy="${eyeY}" r="${eyeR * 1.8}" fill="#ffffff"/>`,
        `<circle cx="${w * 0.38}" cy="${eyeY}" r="${eyeR}" fill="#222222"/>`,
        `<circle cx="${w * 0.68}" cy="${eyeY}" r="${eyeR}" fill="#222222"/>`,
        `<rect x="${w * 0.18}" y="${h * 0.88}" width="${w * 0.22}" height="${h * 0.12}" rx="${w * 0.05}" fill="${accent}"/>`,
        `<rect x="${w * 0.6}" y="${h * 0.88}" width="${w * 0.22}" height="${h * 0.12}" rx="${w * 0.05}" fill="${accent}"/>`,
      ].join('');
      break;
    }
    case 'enemy': {
      const eyeR = Math.max(1.5, w * 0.07);
      const eyeY = h * 0.4;
      body = [
        `<polygon points="${polygonPoints(cx, cy, r, 6)}" fill="${color}"${stroke}/>`,
        `<polygon points="${w * 0.28},${eyeY - eyeR} ${w * 0.42},${eyeY - eyeR * 2.2} ${w * 0.42},${eyeY}" fill="#ffffff"/>`,
        `<polygon points="${w * 0.72},${eyeY - eyeR} ${w * 0.58},${eyeY - eyeR * 2.2} ${w * 0.58},${eyeY}" fill="#ffffff"/>`,
        `<circle cx="${w * 0.38}" cy="${eyeY}" r="${eyeR}" fill="#ffffff"/>`,
        `<circle cx="${w * 0.62}" cy="${eyeY}" r="${eyeR}" fill="#ffffff"/>`,
        `<rect x="${w * 0.3}" y="${h * 0.65}" width="${w * 0.4}" height="${Math.max(2, h * 0.06)}" fill="${accent}"/>`,
      ].join('');
      break;
    }
    case 'coin': {
      body = [
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"${stroke}/>`,
        `<circle cx="${cx}" cy="${cy}" r="${r * 0.7}" fill="none" stroke="${accent}" stroke-width="${Math.max(1, r * 0.12)}"/>`,
        `<rect x="${cx - r * 0.12}" y="${cy - r * 0.4}" width="${r * 0.24}" height="${r * 0.8}" rx="${r * 0.1}" fill="${accent}"/>`,
      ].join('');
      break;
    }
    case 'heart': {
      const d = `M ${cx} ${h * 0.85} C ${w * 0.05} ${h * 0.5}, ${w * 0.1} ${h * 0.12}, ${cx} ${h * 0.3} C ${w * 0.9} ${h * 0.12}, ${w * 0.95} ${h * 0.5}, ${cx} ${h * 0.85} Z`;
      body = `<path d="${d}" fill="${color}"${stroke}/>`;
      break;
    }
    default:
      body = `<rect x="0" y="0" width="${w}" height="${h}" fill="${color}"/>`;
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `  <!-- Generated by Hearth procedural asset system. shape=${spec.shape} color=${spec.color} -->`,
    `  ${body}`,
    `</svg>`,
    '',
  ].join('\n');
}

/** Generate a simple tile SVG with a subtle top edge highlight. */
export function generateTileSvg(color: string, size = 32): string {
  const accent = darken(color, 0.75);
  const highlight = darken(color, 1.25 > 1 ? 0.9 : 0.9);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `  <!-- Generated by Hearth procedural asset system. tile color=${color} -->`,
    `  <rect x="0" y="0" width="${size}" height="${size}" fill="${color}"/>`,
    `  <rect x="0" y="0" width="${size}" height="${Math.max(2, size * 0.12)}" fill="${highlight}" opacity="0.5"/>`,
    `  <rect x="0" y="${size - Math.max(2, size * 0.08)}" width="${size}" height="${Math.max(2, size * 0.08)}" fill="${accent}"/>`,
    `</svg>`,
    '',
  ].join('\n');
}

export const SPRITE_SHAPES: SpriteShape[] = [
  'rectangle',
  'circle',
  'triangle',
  'diamond',
  'star',
  'capsule',
  'polygon',
  'character',
  'enemy',
  'coin',
  'heart',
];

/** Named colors accepted anywhere a color is expected (converted to hex). */
export const NAMED_COLORS: Record<string, string> = {
  red: '#e74c3c',
  orange: '#e67e22',
  yellow: '#f1c40f',
  green: '#2ecc71',
  teal: '#1abc9c',
  blue: '#3498db',
  navy: '#2c3e50',
  purple: '#9b59b6',
  pink: '#fd79a8',
  brown: '#8d6e63',
  gray: '#95a5a6',
  grey: '#95a5a6',
  white: '#ecf0f1',
  black: '#222222',
};

export function resolveColor(input: string): string {
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(input)) return input.toLowerCase();
  const named = NAMED_COLORS[input.toLowerCase()];
  if (named) return named;
  throw new Error(
    `Unknown color "${input}". Use a hex color like #ff8800 or one of: ${Object.keys(NAMED_COLORS).join(', ')}`,
  );
}
