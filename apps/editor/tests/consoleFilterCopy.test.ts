/**
 * The Console's level-filter chips and copy affordance. Pure pieces only —
 * the chip render and the clipboard call are exercised through the DOM tests.
 */
import { describe, expect, it } from 'vitest';
import { filterConsoleEntries, consoleEntriesText, type ConsoleFilter } from '../src/components/ConsolePanel';
import type { ConsoleEntry } from '../src/types';

function entry(id: number, level: ConsoleEntry['level'], message = `m${id}`): ConsoleEntry {
  return { id, time: '12:00:0' + id, level, source: 'app', message };
}

const entries: ConsoleEntry[] = [
  entry(1, 'info'),
  entry(2, 'warn'),
  entry(3, 'error'),
  entry(4, 'info'),
  entry(5, 'error'),
];

describe('filterConsoleEntries (level filter chips)', () => {
  it("'all' passes everything through unchanged", () => {
    expect(filterConsoleEntries(entries, 'all')).toEqual(entries);
  });

  it('a level keeps only that level, preserving order', () => {
    expect(filterConsoleEntries(entries, 'error').map((e) => e.id)).toEqual([3, 5]);
    expect(filterConsoleEntries(entries, 'warn').map((e) => e.id)).toEqual([2]);
    expect(filterConsoleEntries(entries, 'info').map((e) => e.id)).toEqual([1, 4]);
  });

  it('empty input stays empty for every filter', () => {
    const filters: ConsoleFilter[] = ['all', 'info', 'warn', 'error'];
    for (const f of filters) expect(filterConsoleEntries([], f)).toEqual([]);
  });
});

describe('consoleEntriesText (copy affordance)', () => {
  it('formats one line per entry: time, level, source, message', () => {
    expect(consoleEntriesText([entry(1, 'warn', 'careful')])).toBe('12:00:01 [warn] app: careful');
  });

  it('joins multiple entries with newlines in list order', () => {
    const text = consoleEntriesText([entry(1, 'info', 'a'), entry(2, 'error', 'b')]);
    expect(text.split('\n')).toEqual(['12:00:01 [info] app: a', '12:00:02 [error] app: b']);
  });

  it('appends the script link location when the entry carries one', () => {
    const withLink: ConsoleEntry = { ...entry(1, 'error', 'boom'), link: { path: 'scripts/x.lua', line: 14 } };
    expect(consoleEntriesText([withLink])).toBe('12:00:01 [error] app: boom (scripts/x.lua:14)');
    const noLine: ConsoleEntry = { ...entry(2, 'error', 'boom'), link: { path: 'scripts/x.lua', line: null } };
    expect(consoleEntriesText([noLine])).toBe('12:00:02 [error] app: boom (scripts/x.lua)');
  });
});
