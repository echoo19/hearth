import { describe, expect, it } from 'vitest';
import { humanizeFieldLabel } from '../src/components/Inspector';

describe('humanizeFieldLabel', () => {
  it('splits camelCase schema field names into title-cased words', () => {
    expect(humanizeFieldLabel('backgroundColor')).toBe('Background Color');
    expect(humanizeFieldLabel('isMain')).toBe('Is Main');
    expect(humanizeFieldLabel('ambientLight')).toBe('Ambient Light');
    expect(humanizeFieldLabel('fontSize')).toBe('Font Size');
    expect(humanizeFieldLabel('fontFamily')).toBe('Font Family');
  });

  it('capitalizes single-word fields', () => {
    expect(humanizeFieldLabel('enabled')).toBe('Enabled');
    expect(humanizeFieldLabel('strength')).toBe('Strength');
  });

  it('handles fields that already start uppercase or are empty', () => {
    expect(humanizeFieldLabel('')).toBe('');
  });
});
