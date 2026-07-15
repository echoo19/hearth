/**
 * L-047 (ASSETS-6): roving-tabindex arrow-key navigation over the asset grid.
 * Pure index math only — the DOM focus plumbing (refs + computed column count)
 * is exercised live.
 */
import { describe, expect, it } from 'vitest';
import { gridNavIndex } from '../src/components/AssetsPanel';

// A 3-column grid of 8 cards:
//   0 1 2
//   3 4 5
//   6 7
const count = 8;
const cols = 3;

describe('gridNavIndex', () => {
  it('ArrowRight moves +1 and clamps at the last card', () => {
    expect(gridNavIndex(count, cols, 0, 'ArrowRight')).toBe(1);
    expect(gridNavIndex(count, cols, 7, 'ArrowRight')).toBe(7);
  });

  it('ArrowLeft moves -1 and clamps at the first card', () => {
    expect(gridNavIndex(count, cols, 4, 'ArrowLeft')).toBe(3);
    expect(gridNavIndex(count, cols, 0, 'ArrowLeft')).toBe(0);
  });

  it('ArrowDown moves one row down', () => {
    expect(gridNavIndex(count, cols, 1, 'ArrowDown')).toBe(4);
    expect(gridNavIndex(count, cols, 3, 'ArrowDown')).toBe(6);
  });

  it('ArrowDown from a full row onto a shorter last row lands on the last card', () => {
    expect(gridNavIndex(count, cols, 5, 'ArrowDown')).toBe(7);
  });

  it('ArrowDown on the last row stays put', () => {
    expect(gridNavIndex(count, cols, 6, 'ArrowDown')).toBe(6);
    expect(gridNavIndex(count, cols, 7, 'ArrowDown')).toBe(7);
  });

  it('ArrowUp moves one row up and stays on the first row', () => {
    expect(gridNavIndex(count, cols, 4, 'ArrowUp')).toBe(1);
    expect(gridNavIndex(count, cols, 2, 'ArrowUp')).toBe(2);
  });

  it('Home/End jump to the ends', () => {
    expect(gridNavIndex(count, cols, 4, 'Home')).toBe(0);
    expect(gridNavIndex(count, cols, 4, 'End')).toBe(7);
  });

  it('degenerate inputs never escape the valid range', () => {
    expect(gridNavIndex(1, 1, 0, 'ArrowDown')).toBe(0);
    expect(gridNavIndex(1, 1, 0, 'ArrowRight')).toBe(0);
    expect(gridNavIndex(0, 3, 0, 'ArrowDown')).toBe(0);
    // A column count of 0 (unmeasured grid) behaves like a single column.
    expect(gridNavIndex(4, 0, 1, 'ArrowDown')).toBe(2);
  });
});
