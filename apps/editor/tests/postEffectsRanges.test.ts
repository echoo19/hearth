/**
 * INSPSPEC-1 — every bounded numeric field of every post-effect must carry a
 * client-side min/max so an out-of-range value is rejected in the field
 * (revert + cue) instead of committed and silently refused by the server.
 *
 * The coverage check builds a default instance of each effect variant and
 * asserts every numeric field has an entry in EFFECT_FIELD_RANGES — so adding
 * a new numeric field to PostEffectSchema without a range fails here rather
 * than regressing the silent-rejection bug.
 */
import { describe, expect, it } from 'vitest';
import { POST_EFFECT_TYPES } from '@hearth/core';
import { defaultPostEffect } from '../src/postEffectsList';
import { EFFECT_FIELD_RANGES } from '../src/components/PostEffectsField';

describe('EFFECT_FIELD_RANGES', () => {
  it('covers every numeric field of every post-effect variant', () => {
    const missing: string[] = [];
    for (const type of POST_EFFECT_TYPES) {
      const effect = defaultPostEffect(type) as Record<string, unknown>;
      for (const [field, value] of Object.entries(effect)) {
        if (field === 'type') continue;
        if (typeof value === 'number' && !EFFECT_FIELD_RANGES[`${type}.${field}`]) {
          missing.push(`${type}.${field}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('has min <= max for every declared range', () => {
    for (const [key, { min, max }] of Object.entries(EFFECT_FIELD_RANGES)) {
      expect(min, key).toBeLessThanOrEqual(max);
    }
  });

  it('pins the schema bounds that the audit called out', () => {
    expect(EFFECT_FIELD_RANGES['bloom.strength']).toEqual({ min: 0, max: 3 });
    expect(EFFECT_FIELD_RANGES['pixelate.size']).toEqual({ min: 1, max: 64 });
  });
});
