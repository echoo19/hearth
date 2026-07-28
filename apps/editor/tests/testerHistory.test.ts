/**
 * What the history is allowed to say about your game.
 *
 * Every rule lives in `testerRows` rather than in the component, because these
 * are claims about someone's work and a claim should be checkable without a
 * DOM. Two of them are the third sycophancy defence: a reversal has to be
 * legible even when the tester does not flag it, and the regression answer is
 * rendered every time, including when the answer is "nothing" and including
 * when the tester never gave one.
 */
import { describe, it, expect } from 'vitest';
import { testerRows, TESTER_NEVER_PLAYED } from '../src/components/tester/testerRows';
import { MISSING_REGRESSION } from '../server/tester/prompt';
import type { TesterNote } from '../server/tester/types';

function note(over: Partial<TesterNote> & { session: number }): TesterNote {
  return {
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    onTheChange: { seen: 'you raised the jump', verdict: 'better', why: 'I cleared the gap' },
    regression: 'nothing',
    observations: [{ frame: 2, text: 'fell in the pit' }],
    openQuestions: [],
    steps: 12,
    stopped: 'done',
    ...over,
  };
}

describe('testerRows', () => {
  it('leads with the newest verdict', () => {
    const rows = testerRows([note({ session: 1 }), note({ session: 2 }), note({ session: 3 })]);
    expect(rows.map((r) => r.session)).toEqual([3, 2, 1]);
  });

  it('says what the verdict means instead of printing the word it stored', () => {
    const [row] = testerRows([note({ session: 1, onTheChange: { seen: 'x', verdict: 'no-difference', why: 'y' } })]);
    expect(row.headline).toMatch(/no real difference/i);
    expect(row.headline).not.toContain('no-difference');
  });

  it('marks a session that reverses the one before it', () => {
    const rows = testerRows([
      note({ session: 1, onTheChange: { seen: 'a', verdict: 'better', why: 'b' } }),
      note({ session: 2, onTheChange: { seen: 'c', verdict: 'worse', why: 'd' } }),
    ]);
    expect(rows[0].reversal).toBeTruthy();
    expect(rows[1].reversal).toBeNull();
  });

  it('keeps the previous verdict beside the current one, reversal or not', () => {
    // The reader has to be able to see a tester changing its mind even when
    // the tester itself never mentions it.
    const rows = testerRows([
      note({ session: 1, onTheChange: { seen: 'a', verdict: 'better', why: 'b' } }),
      note({ session: 2, onTheChange: { seen: 'c', verdict: 'better', why: 'd' } }),
    ]);
    expect(rows[0].previously).toMatch(/helped/i);
  });

  it('always renders the regression answer, including when nothing got worse', () => {
    const [clean] = testerRows([note({ session: 1, regression: 'nothing' })]);
    expect(clean.regression).toMatch(/nothing got worse/i);

    const [named] = testerRows([note({ session: 1, regression: 'the second gap is unfair now' })]);
    expect(named.regression).toContain('the second gap is unfair now');
  });

  it('says an unanswered regression is unanswered, never that nothing got worse', () => {
    const [row] = testerRows([note({ session: 1, regression: MISSING_REGRESSION })]);
    expect(row.regression).toMatch(/did not say/i);
    expect(row.regressionAnswered).toBe(false);
  });

  it('drops a claim that is not anchored to a frame', () => {
    // A claim with no frame behind it is a claim, not evidence.
    const [row] = testerRows([
      note({
        session: 1,
        observations: [
          { frame: 2, text: 'fell in the pit' },
          { frame: 0, text: 'the whole game is unbalanced' },
        ],
      }),
    ]);
    expect(row.observations.map((o) => o.text)).toEqual(['fell in the pit']);
  });

  it('reads an empty history as never having played, not as having found nothing', () => {
    expect(testerRows([])).toEqual([]);
    expect(TESTER_NEVER_PLAYED).toMatch(/has not played/i);
    expect(TESTER_NEVER_PLAYED).not.toMatch(/no (issues|problems|findings)/i);
  });

  it('never claims a verdict on a change for the first session', () => {
    const [row] = testerRows([note({ session: 1, onTheChange: { seen: 'x', verdict: 'first-session', why: 'y' } })]);
    expect(row.headline).toMatch(/first/i);
    expect(row.tone).toBe('first');
  });

  it('says how the session ended in words rather than a status token', () => {
    const [stopped] = testerRows([note({ session: 1, stopped: 'user', steps: 3 })]);
    expect(stopped.ending).toMatch(/you stopped it/i);
    expect(stopped.ending).not.toContain('user');

    const [crashed] = testerRows([note({ session: 1, stopped: 'error' })]);
    expect(crashed.ending).toMatch(/trouble/i);
  });
});
