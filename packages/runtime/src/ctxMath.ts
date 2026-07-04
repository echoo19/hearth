/**
 * ctx.math — pure vec2/scalar/color helpers, identical across JS and Lua.
 * All vec2 values are plain {x, y}; every function returns a fresh value and
 * never mutates inputs. Angles are degrees (0 = +x, 90 = +y/down).
 */
import type { Vec2 } from '@hearth/core';

export interface CtxMath {
  vec2(x?: number, y?: number): Vec2;
  add(a: Vec2, b: Vec2): Vec2;
  sub(a: Vec2, b: Vec2): Vec2;
  scale(v: Vec2, s: number): Vec2;
  dot(a: Vec2, b: Vec2): number;
  length(v: Vec2): number;
  distance(a: Vec2, b: Vec2): number;
  normalize(v: Vec2): Vec2;
  angle(v: Vec2): number;
  fromAngle(degrees: number, length?: number): Vec2;
  lerp(a: number, b: number, t: number): number;
  lerpVec(a: Vec2, b: Vec2, t: number): Vec2;
  clamp(x: number, min: number, max: number): number;
  hexToRgb(hex: string): { r: number; g: number; b: number };
  rgbToHex(r: number, g: number, b: number): string;
  colorLerp(hexA: string, hexB: string, t: number): string;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const DEG = 180 / Math.PI;

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return null;
  let h = hex.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const channel = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

const toHex = (r: number, g: number, b: number) => `#${channel(r)}${channel(g)}${channel(b)}`;

/** Build the ctx.math object. `warn` fires once per instance on invalid hex input. */
export function createCtxMath(warn: (msg: string) => void): CtxMath {
  let warned = false;
  const badHex = (fn: string, value: string) => {
    if (!warned) {
      warned = true;
      warn(`ctx.math.${fn}: invalid hex color "${value}" (expected #rgb/#rrggbb); using white`);
    }
    return { r: 255, g: 255, b: 255 };
  };
  return {
    vec2: (x = 0, y = 0) => ({ x, y }),
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (v, s) => ({ x: v.x * s, y: v.y * s }),
    dot: (a, b) => a.x * b.x + a.y * b.y,
    length: (v) => Math.hypot(v.x, v.y),
    distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
    normalize: (v) => {
      const len = Math.hypot(v.x, v.y);
      return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
    },
    angle: (v) => Math.atan2(v.y, v.x) * DEG,
    fromAngle: (degrees, length = 1) => {
      const rad = degrees / DEG;
      return { x: Math.cos(rad) * length, y: Math.sin(rad) * length };
    },
    lerp: (a, b, t) => a + (b - a) * t,
    lerpVec: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
    clamp: (x, min, max) => Math.min(max, Math.max(min, x)),
    hexToRgb: (hex) => parseHex(hex) ?? badHex('hexToRgb', hex),
    rgbToHex: (r, g, b) => toHex(r, g, b),
    colorLerp: (hexA, hexB, t) => {
      const a = parseHex(hexA) ?? badHex('colorLerp', hexA);
      const b = parseHex(hexB) ?? badHex('colorLerp', hexB);
      const tt = Math.min(1, Math.max(0, t));
      return toHex(a.r + (b.r - a.r) * tt, a.g + (b.g - a.g) * tt, a.b + (b.b - a.b) * tt);
    },
  };
}
