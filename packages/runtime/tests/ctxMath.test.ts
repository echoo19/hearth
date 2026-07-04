import { describe, it, expect, vi } from 'vitest';
import { createCtxMath } from '../src/ctxMath.js';

describe('ctx.math', () => {
  const m = createCtxMath(() => {});
  it('vec2 defaults missing args to 0', () => {
    expect(m.vec2()).toEqual({ x: 0, y: 0 });
    expect(m.vec2(3)).toEqual({ x: 3, y: 0 });
  });
  it('add/sub/scale return fresh objects without mutating inputs', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 3, y: 4 };
    expect(m.add(a, b)).toEqual({ x: 4, y: 6 });
    expect(m.sub(b, a)).toEqual({ x: 2, y: 2 });
    expect(m.scale(a, 2)).toEqual({ x: 2, y: 4 });
    expect(a).toEqual({ x: 1, y: 2 });
  });
  it('dot/length/distance', () => {
    expect(m.dot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(11);
    expect(m.length({ x: 3, y: 4 })).toBe(5);
    expect(m.distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
  it('normalize handles the zero vector', () => {
    expect(m.normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(m.normalize({ x: 10, y: 0 })).toEqual({ x: 1, y: 0 });
  });
  it('angle/fromAngle use degrees, 0=+x, 90=down(+y)', () => {
    expect(m.angle({ x: 1, y: 0 })).toBe(0);
    expect(m.angle({ x: 0, y: 1 })).toBe(90);
    expect(m.angle({ x: 0, y: 0 })).toBe(0);
    const v = m.fromAngle(90);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(1);
    expect(m.fromAngle(0, 5)).toEqual({ x: 5, y: 0 });
  });
  it('lerp/lerpVec do not clamp t; clamp clamps', () => {
    expect(m.lerp(0, 10, 0.5)).toBe(5);
    expect(m.lerp(0, 10, 1.5)).toBe(15);
    expect(m.lerpVec({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
    expect(m.clamp(5, 0, 3)).toBe(3);
    expect(m.clamp(-1, 0, 3)).toBe(0);
  });
  it('hexToRgb parses #rgb, #rrggbb, #rrggbbaa (alpha ignored)', () => {
    expect(m.hexToRgb('#ff8800')).toEqual({ r: 255, g: 136, b: 0 });
    expect(m.hexToRgb('#f80')).toEqual({ r: 255, g: 136, b: 0 });
    expect(m.hexToRgb('#ff880080')).toEqual({ r: 255, g: 136, b: 0 });
  });
  it('invalid hex returns white and warns once per instance', () => {
    const warn = vi.fn();
    const mm = createCtxMath(warn);
    expect(mm.hexToRgb('nope')).toEqual({ r: 255, g: 255, b: 255 });
    expect(mm.hexToRgb('also-nope')).toEqual({ r: 255, g: 255, b: 255 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('rgbToHex clamps and rounds', () => {
    expect(m.rgbToHex(255, 136, 0)).toBe('#ff8800');
    expect(m.rgbToHex(300, -5, 127.6)).toBe('#ff0080');
  });
  it('colorLerp clamps t and lerps in RGB', () => {
    expect(m.colorLerp('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(m.colorLerp('#000000', '#ffffff', 2)).toBe('#ffffff');
  });
});
