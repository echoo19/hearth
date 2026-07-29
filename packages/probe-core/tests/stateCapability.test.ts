import { describe, it, expect } from 'vitest';
import { normalizeStates } from '../src/contract.js';

describe('normalizeStates', () => {
  it('keeps whatever the game named, without interpreting it', () => {
    // The point of the whole feature: these are a MOBA's states, and nothing
    // here knows what a lane is.
    const raw = [{ id: 'mid-6min', label: 'Mid lane, six minutes in' }];
    expect(normalizeStates(raw)).toEqual([{ id: 'mid-6min', label: 'Mid lane, six minutes in' }]);
  });

  it('accepts a state with only an id, and labels it with the id', () => {
    expect(normalizeStates([{ id: 'ch3' }])).toEqual([{ id: 'ch3', label: 'ch3' }]);
  });

  it('drops entries with no usable id rather than inventing one', () => {
    expect(normalizeStates([{ label: 'nameless' }, { id: '' }, { id: 'ok' }])).toEqual([
      { id: 'ok', label: 'ok' },
    ]);
  });

  it('returns nothing for a game that declares nothing', () => {
    // Declaring nothing is a first-class outcome, not an error.
    expect(normalizeStates(undefined)).toEqual([]);
    expect(normalizeStates(null)).toEqual([]);
    expect(normalizeStates('nonsense')).toEqual([]);
  });

  it('carries an optional detail through untouched', () => {
    expect(normalizeStates([{ id: 'y3', label: 'Year three', detail: 'budget already in deficit' }])[0].detail)
      .toBe('budget already in deficit');
  });
});
