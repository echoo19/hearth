/**
 * Home's greeting.
 *
 * It is the first sentence the app says, so the contract is about tone as much
 * as time: it always says something, it says a different thing at 2am than at
 * 2pm, and it never shouts.
 */
import { describe, expect, it } from 'vitest';
import { greetingFor, timeOfDay } from '../src/components/home/Home';

describe('timeOfDay', () => {
  it('splits the day where a person would', () => {
    expect(timeOfDay(5)).toBe('morning');
    expect(timeOfDay(11)).toBe('morning');
    expect(timeOfDay(12)).toBe('afternoon');
    expect(timeOfDay(16)).toBe('afternoon');
    expect(timeOfDay(17)).toBe('evening');
    expect(timeOfDay(21)).toBe('evening');
    expect(timeOfDay(22)).toBe('late');
    expect(timeOfDay(3)).toBe('late');
  });

  it('does not fall off the end of the clock', () => {
    expect(timeOfDay(24)).toBe('late');
    expect(timeOfDay(-1)).toBe('late');
    expect(timeOfDay(13.9)).toBe('afternoon');
  });
});

describe('greetingFor', () => {
  it('always says something, at every hour and every seed', () => {
    for (let hour = 0; hour < 24; hour++) {
      for (let seed = 0; seed < 5; seed++) {
        expect(greetingFor(hour, seed).length).toBeGreaterThan(0);
      }
    }
  });

  it('says a different thing at night than in the morning', () => {
    expect(greetingFor(2, 0)).not.toBe(greetingFor(9, 0));
  });

  it('rotates with the seed, so the same hour is not the same line forever', () => {
    const lines = new Set([0, 1, 2, 3].map((seed) => greetingFor(9, seed)));
    expect(lines.size).toBeGreaterThan(1);
  });

  it('handles a negative seed rather than reading off the end of the list', () => {
    expect(greetingFor(9, -1).length).toBeGreaterThan(0);
  });

  it('never shouts', () => {
    for (let hour = 0; hour < 24; hour++) {
      for (let seed = 0; seed < 4; seed++) {
        expect(greetingFor(hour, seed)).not.toContain('!');
      }
    }
  });
});
