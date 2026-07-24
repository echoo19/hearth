/**
 * Frustration signals shared by the fade-softlock and wall-bump detectors:
 * telling a supporting (ground) contact from a wall/ceiling contact, and the
 * "mostly bumping a wall during the stall" fraction test.
 */
import { describe, it, expect } from 'vitest';
import { nonSupportingContact, isWallBump } from '@hearth/playtest';

const ground = { other: {} as any, normal: { x: 0, y: -1 }, trigger: false };
const wall = { other: {} as any, normal: { x: -1, y: 0 }, trigger: false };
const triggerZone = { other: {} as any, normal: { x: -1, y: 0 }, trigger: true };

describe('nonSupportingContact', () => {
  it('ignores a ground contact (normal points up)', () => {
    expect(nonSupportingContact({ collisions: [ground] })).toBe(false);
  });

  it('detects a wall contact (horizontal normal)', () => {
    expect(nonSupportingContact({ collisions: [wall] })).toBe(true);
  });

  it('ignores trigger overlaps (pickups, sensors — not a solid bump)', () => {
    expect(nonSupportingContact({ collisions: [triggerZone] })).toBe(false);
  });

  it('is false with no contacts', () => {
    expect(nonSupportingContact({ collisions: [] })).toBe(false);
  });
});

describe('isWallBump', () => {
  it('fires when wall contact dominates the stall window', () => {
    expect(isWallBump(15, 20)).toBe(true); // 75% of the window
  });

  it('does not fire on a brief graze', () => {
    expect(isWallBump(3, 20)).toBe(false); // 15%
  });
});
