import { describe, expect, it } from 'vitest';
import { isActivationKey } from '../src/components/AssetsPanel';

describe('isActivationKey (AssetsPanel asset-card keyboard activation)', () => {
  it('treats Enter as an activation key', () => {
    expect(isActivationKey('Enter')).toBe(true);
  });

  it('treats Space as an activation key', () => {
    expect(isActivationKey(' ')).toBe(true);
  });

  it('does not treat other keys as activation keys', () => {
    expect(isActivationKey('Tab')).toBe(false);
    expect(isActivationKey('Escape')).toBe(false);
    expect(isActivationKey('a')).toBe(false);
  });
});
