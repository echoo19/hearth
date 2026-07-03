/**
 * Hex color/number lerp used by particle rendering (start/end color and
 * start/end size over a particle's lifetime). Pure logic, kept in its own
 * module so this test doesn't have to pull in the whole Pixi view.
 */
import { describe, it, expect } from 'vitest';
import { lerp, lerpColor } from '../src/pixi/color.js';

describe('lerpColor', () => {
  it('returns the start color at t=0', () => {
    expect(lerpColor('#112233', '#ffffff', 0)).toBe('#112233');
  });

  it('returns the end color at t=1', () => {
    expect(lerpColor('#112233', '#ffffff', 1)).toBe('#ffffff');
  });

  it('interpolates the midpoint', () => {
    expect(lerpColor('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('expands 3-digit hex shorthand', () => {
    expect(lerpColor('#f00', '#00f', 0)).toBe('#ff0000');
    expect(lerpColor('#f00', '#00f', 1)).toBe('#0000ff');
  });

  it('ignores an alpha channel on 8-digit hex', () => {
    expect(lerpColor('#ff0000aa', '#ff0000aa', 0.5)).toBe('#ff0000');
  });

  it('clamps t outside [0,1]', () => {
    expect(lerpColor('#000000', '#ffffff', -1)).toBe('#000000');
    expect(lerpColor('#000000', '#ffffff', 2)).toBe('#ffffff');
  });
});

describe('lerp', () => {
  it('interpolates between two numbers', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it('clamps t outside [0,1]', () => {
    expect(lerp(0, 10, -1)).toBe(0);
    expect(lerp(0, 10, 2)).toBe(10);
  });
});
