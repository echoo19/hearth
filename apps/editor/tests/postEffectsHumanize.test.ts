import { describe, expect, it } from 'vitest';
import { POST_EFFECT_TYPES } from '@hearth/core';
import { humanize } from '../src/components/PostEffectsField';

describe('humanize', () => {
  it('renders the CRT effect as the acronym, not title-cased', () => {
    expect(humanize('crt')).toBe('CRT');
  });

  it('title-cases the other five effect types word-by-word', () => {
    expect(humanize('bloom')).toBe('Bloom');
    expect(humanize('vignette')).toBe('Vignette');
    expect(humanize('chromaticAberration')).toBe('Chromatic Aberration');
    expect(humanize('pixelate')).toBe('Pixelate');
    expect(humanize('colorGrade')).toBe('Color Grade');
  });

  it('covers every PostEffect variant type with a sensible label', () => {
    for (const type of POST_EFFECT_TYPES) {
      const label = humanize(type);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/^[a-z]/); // never lowercase-leading, unfinished-looking
    }
  });
});
