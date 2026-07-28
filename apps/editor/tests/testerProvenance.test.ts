import { describe, it, expect } from 'vitest';
import { observationReach } from '../server/tester/types';

describe('observationReach', () => {
  it('reads what the observation recorded', () => {
    expect(observationReach({ frame: 1, text: 'x', reached: 'placed' })).toBe('placed');
    expect(observationReach({ frame: 1, text: 'x', reached: 'played' })).toBe('played');
  });

  it('treats an older note with no provenance as played', () => {
    // Sessions written before this existed could not be placed anywhere, so
    // "played" is the fact, not a default.
    expect(observationReach({ frame: 1, text: 'x' })).toBe('played');
  });

  it('never guesses from anything else in the observation', () => {
    expect(observationReach({ frame: 99, text: 'I was teleported to the boss', reached: 'played' })).toBe('played');
  });
});
