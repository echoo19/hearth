import { describe, expect, it } from 'vitest';
import type { PostEffect } from '@hearth/core';
import {
  POST_EFFECTS_MAX,
  addEffect,
  defaultPostEffect,
  moveEffect,
  removeEffect,
  updateEffect,
} from '../src/postEffectsList';

describe('defaultPostEffect', () => {
  it('returns schema defaults for every variant', () => {
    expect(defaultPostEffect('bloom')).toEqual({ type: 'bloom', strength: 1, threshold: 0.5 });
    expect(defaultPostEffect('crt')).toEqual({
      type: 'crt',
      curvature: 0.15,
      scanlineIntensity: 0.25,
      noise: 0,
    });
    expect(defaultPostEffect('vignette')).toEqual({ type: 'vignette', intensity: 0.4, color: '#000000' });
    expect(defaultPostEffect('chromaticAberration')).toEqual({ type: 'chromaticAberration', offset: 2 });
    expect(defaultPostEffect('pixelate')).toEqual({ type: 'pixelate', size: 4 });
    expect(defaultPostEffect('colorGrade')).toEqual({
      type: 'colorGrade',
      brightness: 1,
      contrast: 1,
      saturation: 1,
      tint: '#ffffff',
    });
  });
});

describe('addEffect', () => {
  it('appends a default-valued effect to an empty stack', () => {
    const next = addEffect([], 'bloom');
    expect(next).toEqual([{ type: 'bloom', strength: 1, threshold: 0.5 }]);
  });

  it('appends after existing effects, preserving their order', () => {
    const stack: PostEffect[] = [{ type: 'vignette', intensity: 0.4, color: '#000000' }];
    const next = addEffect(stack, 'pixelate');
    expect(next).toEqual([
      { type: 'vignette', intensity: 0.4, color: '#000000' },
      { type: 'pixelate', size: 4 },
    ]);
  });

  it('does not mutate the input stack', () => {
    const stack: PostEffect[] = [{ type: 'bloom', strength: 1, threshold: 0.5 }];
    const before = JSON.stringify(stack);
    addEffect(stack, 'crt');
    expect(JSON.stringify(stack)).toBe(before);
  });

  it('returns null at the cap (8) instead of growing past it', () => {
    const stack: PostEffect[] = Array.from({ length: POST_EFFECTS_MAX }, () => ({
      type: 'bloom',
      strength: 1,
      threshold: 0.5,
    }));
    expect(addEffect(stack, 'crt')).toBeNull();
  });

  it('allows the 8th effect (cap is inclusive of the add that reaches it)', () => {
    const stack: PostEffect[] = Array.from({ length: POST_EFFECTS_MAX - 1 }, () => ({
      type: 'bloom',
      strength: 1,
      threshold: 0.5,
    }));
    const next = addEffect(stack, 'crt');
    expect(next).not.toBeNull();
    expect(next).toHaveLength(POST_EFFECTS_MAX);
  });
});

describe('removeEffect', () => {
  const stack: PostEffect[] = [
    { type: 'bloom', strength: 1, threshold: 0.5 },
    { type: 'vignette', intensity: 0.4, color: '#000000' },
    { type: 'pixelate', size: 4 },
  ];

  it('removes the effect at the given index', () => {
    expect(removeEffect(stack, 1)).toEqual([
      { type: 'bloom', strength: 1, threshold: 0.5 },
      { type: 'pixelate', size: 4 },
    ]);
  });

  it('removes the first effect', () => {
    expect(removeEffect(stack, 0)).toEqual([
      { type: 'vignette', intensity: 0.4, color: '#000000' },
      { type: 'pixelate', size: 4 },
    ]);
  });

  it('removes the last effect', () => {
    expect(removeEffect(stack, 2)).toEqual([
      { type: 'bloom', strength: 1, threshold: 0.5 },
      { type: 'vignette', intensity: 0.4, color: '#000000' },
    ]);
  });

  it('can empty the stack down to zero effects', () => {
    expect(removeEffect([{ type: 'bloom', strength: 1, threshold: 0.5 }], 0)).toEqual([]);
  });

  it('does not mutate the input stack', () => {
    const before = JSON.stringify(stack);
    removeEffect(stack, 0);
    expect(JSON.stringify(stack)).toBe(before);
  });
});

describe('moveEffect', () => {
  const stack: PostEffect[] = [
    { type: 'bloom', strength: 1, threshold: 0.5 },
    { type: 'vignette', intensity: 0.4, color: '#000000' },
    { type: 'pixelate', size: 4 },
  ];

  it('moves an effect up (earlier)', () => {
    expect(moveEffect(stack, 1, -1)).toEqual([
      { type: 'vignette', intensity: 0.4, color: '#000000' },
      { type: 'bloom', strength: 1, threshold: 0.5 },
      { type: 'pixelate', size: 4 },
    ]);
  });

  it('moves an effect down (later)', () => {
    expect(moveEffect(stack, 1, 1)).toEqual([
      { type: 'bloom', strength: 1, threshold: 0.5 },
      { type: 'pixelate', size: 4 },
      { type: 'vignette', intensity: 0.4, color: '#000000' },
    ]);
  });

  it('returns null moving the first effect up', () => {
    expect(moveEffect(stack, 0, -1)).toBeNull();
  });

  it('returns null moving the last effect down', () => {
    expect(moveEffect(stack, 2, 1)).toBeNull();
  });

  it('returns null for an out-of-range index', () => {
    expect(moveEffect(stack, 5, -1)).toBeNull();
    expect(moveEffect(stack, -1, 1)).toBeNull();
  });

  it('does not mutate the input stack', () => {
    const before = JSON.stringify(stack);
    moveEffect(stack, 1, -1);
    expect(JSON.stringify(stack)).toBe(before);
  });
});

describe('updateEffect', () => {
  const stack: PostEffect[] = [
    { type: 'bloom', strength: 1, threshold: 0.5 },
    { type: 'vignette', intensity: 0.4, color: '#000000' },
  ];

  it('sets a single field on the effect at the given index', () => {
    expect(updateEffect(stack, 0, 'strength', 2)).toEqual([
      { type: 'bloom', strength: 2, threshold: 0.5 },
      { type: 'vignette', intensity: 0.4, color: '#000000' },
    ]);
  });

  it('leaves other effects untouched', () => {
    const next = updateEffect(stack, 1, 'color', '#ff0000');
    expect(next[0]).toBe(stack[0]);
  });

  it('does not mutate the input stack', () => {
    const before = JSON.stringify(stack);
    updateEffect(stack, 0, 'strength', 3);
    expect(JSON.stringify(stack)).toBe(before);
  });

  it('never touches the type field via a normal field update', () => {
    const next = updateEffect(stack, 0, 'threshold', 0.9);
    expect(next[0].type).toBe('bloom');
  });
});
