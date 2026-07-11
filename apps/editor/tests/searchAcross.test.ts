/**
 * Pure logic for the cross-script search/replace UI (SearchAcross.tsx):
 * grouping flat searchScripts matches by file (preserving line order),
 * the plain-language summary/hint copy, client-side regex pre-validation
 * (mirrors the engine's buildQueryRegex so a bad pattern never round-trips
 * to the server just to bounce back as a Console error), the match-preview
 * highlight span, and the replace flow's pure state machine
 * (idle -> previewing -> applying -> done, with cancel resetting cleanly).
 * No DOM, no store — mirrors the style of externalChange.test.ts /
 * codePanelSave.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  cappedHintText,
  groupMatchesByPath,
  highlightMatch,
  initialReplaceFlowState,
  matchSummaryText,
  replaceFlowReducer,
  validateQueryRegex,
  type SearchMatch,
} from '../src/components/code/SearchAcross';

function match(path: string, line: number, column = 1, preview = 'line text'): SearchMatch {
  return { path, line, column, preview };
}

describe('groupMatchesByPath', () => {
  it('groups a flat match list by path, preserving line order within each group', () => {
    const matches = [
      match('scripts/a.lua', 1),
      match('scripts/a.lua', 5),
      match('scripts/b.lua', 2),
      match('scripts/a.lua', 9),
    ];
    // Not path-clustered in the input — grouping must still bucket every
    // scripts/a.lua match together, in the order they appeared.
    const grouped = groupMatchesByPath(matches);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].path).toBe('scripts/a.lua');
    expect(grouped[0].matches.map((m) => m.line)).toEqual([1, 5, 9]);
    expect(grouped[1].path).toBe('scripts/b.lua');
    expect(grouped[1].matches.map((m) => m.line)).toEqual([2]);
  });

  it('preserves first-seen path order', () => {
    const matches = [match('scripts/z.lua', 1), match('scripts/a.lua', 1)];
    const grouped = groupMatchesByPath(matches);
    expect(grouped.map((g) => g.path)).toEqual(['scripts/z.lua', 'scripts/a.lua']);
  });

  it('returns an empty array for no matches', () => {
    expect(groupMatchesByPath([])).toEqual([]);
  });
});

describe('matchSummaryText', () => {
  it('reads "No matches" for zero results', () => {
    expect(matchSummaryText(0, 0)).toBe('No matches');
  });

  it('pluralizes matches and scripts independently', () => {
    expect(matchSummaryText(1, 1)).toBe('1 match in 1 script');
    expect(matchSummaryText(14, 3)).toBe('14 matches in 3 scripts');
    expect(matchSummaryText(2, 1)).toBe('2 matches in 1 script');
  });
});

describe('cappedHintText', () => {
  it('is null when results are not capped', () => {
    expect(cappedHintText(false)).toBeNull();
  });

  it('renders a narrow-the-search hint when capped', () => {
    const hint = cappedHintText(true);
    expect(hint).not.toBeNull();
    expect(hint).toMatch(/narrow/i);
  });
});

describe('validateQueryRegex', () => {
  it('passes plain-text queries through untouched (never treated as regex)', () => {
    expect(validateQueryRegex('a(b', false, false)).toBeNull();
  });

  it('accepts a valid regex query', () => {
    expect(validateQueryRegex('onUpdate\\(ctx, \\w+\\)', true, false)).toBeNull();
  });

  it('rejects an invalid regex query with a message, in regex mode', () => {
    const err = validateQueryRegex('[', true, false);
    expect(typeof err).toBe('string');
    expect(err!.length).toBeGreaterThan(0);
  });

  it('ignores regex mode entirely for an empty query (no crash)', () => {
    expect(validateQueryRegex('', true, false)).toBeNull();
  });
});

describe('highlightMatch', () => {
  it('splits a preview around the first match, plain-text query', () => {
    const span = highlightMatch('ctx.log("update tick")', 'update tick', false, false);
    expect(span).toEqual({ before: 'ctx.log("', match: 'update tick', after: '")' });
  });

  it('is case-insensitive by default', () => {
    const span = highlightMatch('Hello world', 'hello', false, false);
    expect(span).toEqual({ before: '', match: 'Hello', after: ' world' });
  });

  it('honors caseSensitive:true', () => {
    expect(highlightMatch('Hello world', 'hello', false, true)).toBeNull();
    expect(highlightMatch('Hello world', 'Hello', false, true)).toEqual({ before: '', match: 'Hello', after: ' world' });
  });

  it('supports a regex query', () => {
    const span = highlightMatch('ctx.timers.after(1, fn)', 'after\\((\\d+)', true, false);
    expect(span).toEqual({ before: 'ctx.timers.', match: 'after(1', after: ', fn)' });
  });

  it('returns null when the query is not found in the preview text', () => {
    expect(highlightMatch('nothing here', 'zzz', false, false)).toBeNull();
  });

  it('returns null for an empty query', () => {
    expect(highlightMatch('some text', '', false, false)).toBeNull();
  });
});

describe('replaceFlowReducer (idle -> previewing -> applying -> done, cancel resets)', () => {
  it('starts idle', () => {
    expect(initialReplaceFlowState.status).toBe('idle');
  });

  it('PREVIEW_START enters previewing in a loading state, clearing any stale results', () => {
    const s = replaceFlowReducer(initialReplaceFlowState, { type: 'PREVIEW_START' });
    expect(s.status).toBe('previewing');
    expect(s.loading).toBe(true);
    expect(s.changes).toEqual([]);
  });

  it('PREVIEW_SUCCESS fills in per-file counts and clears loading', () => {
    const loading = replaceFlowReducer(initialReplaceFlowState, { type: 'PREVIEW_START' });
    const s = replaceFlowReducer(loading, {
      type: 'PREVIEW_SUCCESS',
      changes: [{ path: 'scripts/a.lua', count: 3 }, { path: 'scripts/b.lua', count: 1 }],
      total: 4,
    });
    expect(s.status).toBe('previewing');
    expect(s.loading).toBe(false);
    expect(s.changes).toHaveLength(2);
    expect(s.total).toBe(4);
  });

  it('PREVIEW_ERROR (e.g. a regex bounce from the server) drops back to idle carrying the message', () => {
    const loading = replaceFlowReducer(initialReplaceFlowState, { type: 'PREVIEW_START' });
    const s = replaceFlowReducer(loading, { type: 'PREVIEW_ERROR', message: 'Unterminated character class' });
    expect(s.status).toBe('idle');
    expect(s.error).toBe('Unterminated character class');
  });

  it('APPLY_START only proceeds from a loaded previewing state', () => {
    // Ignored while idle.
    const stillIdle = replaceFlowReducer(initialReplaceFlowState, { type: 'APPLY_START' });
    expect(stillIdle).toBe(initialReplaceFlowState);

    const previewed = replaceFlowReducer(
      replaceFlowReducer(initialReplaceFlowState, { type: 'PREVIEW_START' }),
      { type: 'PREVIEW_SUCCESS', changes: [{ path: 'scripts/a.lua', count: 1 }], total: 1 },
    );
    const applying = replaceFlowReducer(previewed, { type: 'APPLY_START' });
    expect(applying.status).toBe('applying');
    expect(applying.loading).toBe(true);
    // Carries the previewed counts forward for the "Replacing 1 match…" copy.
    expect(applying.changes).toEqual(previewed.changes);
  });

  it('APPLY_SUCCESS reaches done with the applied totals', () => {
    const applying = replaceFlowReducer(
      replaceFlowReducer(
        replaceFlowReducer(initialReplaceFlowState, { type: 'PREVIEW_START' }),
        { type: 'PREVIEW_SUCCESS', changes: [{ path: 'scripts/a.lua', count: 1 }], total: 1 },
      ),
      { type: 'APPLY_START' },
    );
    const done = replaceFlowReducer(applying, { type: 'APPLY_SUCCESS', filesChanged: 1, totalReplaced: 1 });
    expect(done.status).toBe('done');
    expect(done.loading).toBe(false);
    expect(done.filesChanged).toBe(1);
    expect(done.totalReplaced).toBe(1);
  });

  it('APPLY_ERROR falls back to previewing (not idle) so the results/retry stay on screen', () => {
    const applying = replaceFlowReducer(
      replaceFlowReducer(
        replaceFlowReducer(initialReplaceFlowState, { type: 'PREVIEW_START' }),
        { type: 'PREVIEW_SUCCESS', changes: [{ path: 'scripts/a.lua', count: 1 }], total: 1 },
      ),
      { type: 'APPLY_START' },
    );
    const s = replaceFlowReducer(applying, { type: 'APPLY_ERROR', message: 'Disk write failed' });
    expect(s.status).toBe('previewing');
    expect(s.loading).toBe(false);
    expect(s.error).toBe('Disk write failed');
    expect(s.changes).toEqual(applying.changes); // retry keeps the counts
  });

  it('CANCEL resets cleanly to idle from previewing', () => {
    const previewed = replaceFlowReducer(
      replaceFlowReducer(initialReplaceFlowState, { type: 'PREVIEW_START' }),
      { type: 'PREVIEW_SUCCESS', changes: [{ path: 'scripts/a.lua', count: 1 }], total: 1 },
    );
    const s = replaceFlowReducer(previewed, { type: 'CANCEL' });
    expect(s).toEqual(initialReplaceFlowState);
  });

  it('CANCEL resets cleanly to idle from done', () => {
    const done = replaceFlowReducer(
      replaceFlowReducer(
        replaceFlowReducer(
          replaceFlowReducer(initialReplaceFlowState, { type: 'PREVIEW_START' }),
          { type: 'PREVIEW_SUCCESS', changes: [{ path: 'scripts/a.lua', count: 1 }], total: 1 },
        ),
        { type: 'APPLY_START' },
      ),
      { type: 'APPLY_SUCCESS', filesChanged: 1, totalReplaced: 1 },
    );
    const s = replaceFlowReducer(done, { type: 'CANCEL' });
    expect(s).toEqual(initialReplaceFlowState);
  });
});
