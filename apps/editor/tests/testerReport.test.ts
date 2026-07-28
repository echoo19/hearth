/**
 * The report a person reads, and the plan of action they pick from.
 *
 * Both are pure, which is the point: the rules that keep a session honest are
 * checkable here without a model, a browser or a game.
 */
import { describe, it, expect } from 'vitest';
import { parseProposals, testerPrompts } from '../server/tester/prompt';
import { proposalsFrom, renderReport, REACHABILITY_CAVEAT } from '../server/tester/report';
import type { TesterNote } from '../server/tester/types';

function note(over: Partial<TesterNote> = {}): TesterNote {
  return {
    session: 3,
    startedAt: '2026-07-27T10:00:00.000Z',
    finishedAt: '2026-07-27T10:12:00.000Z',
    onTheChange: { seen: 'you rewrote the intake rules', verdict: 'better', why: 'the queue cleared' },
    regression: 'nothing',
    observations: [
      { frame: 2, text: 'the intake screen listed nobody', reached: 'played' },
      { frame: 6, text: 'the audit total came out negative', reached: 'placed' },
    ],
    openQuestions: ['what the second button does'],
    steps: 8,
    stopped: 'done',
    ...over,
  };
}

describe('renderReport', () => {
  it('marks a placed observation where the claim is, not in a footnote', () => {
    const text = renderReport(note());
    const line = text.split('\n').find((row) => row.includes('the audit total came out negative'));
    expect(line).toBeDefined();
    expect(line!.toLowerCase()).toContain('placed');
  });

  it('says plainly that placed findings prove nothing about reaching that content', () => {
    expect(renderReport(note())).toContain(REACHABILITY_CAVEAT);
  });

  it('leaves the caveat out when nothing was placed', () => {
    // Warning about a thing that did not happen teaches a reader to skip the
    // warning when it does.
    const played = note({
      observations: [{ frame: 2, text: 'the intake screen listed nobody', reached: 'played' }],
    });
    expect(renderReport(played)).not.toContain(REACHABILITY_CAVEAT);
  });

  it('always answers whether anything got worse, including when nothing did', () => {
    expect(renderReport(note({ regression: 'nothing' })).toLowerCase()).toContain('nothing got worse');
    expect(renderReport(note({ regression: 'the pause menu stopped closing' }))).toContain(
      'the pause menu stopped closing',
    );
  });

  it('is prose, because the agent reading it is a reader and not a parser', () => {
    const text = renderReport(note());
    expect(text).not.toMatch(/[{}[\]]/);
    expect(text).not.toMatch(/"\w+":/);
  });

  it('reads as a session even when the tester wrote nothing down', () => {
    const text = renderReport(note({ observations: [], openQuestions: [] }));
    expect(text).toContain('Session 3');
    expect(text.toLowerCase()).toContain('did not write down anything');
    expect(text.length).toBeGreaterThan(80);
  });
});

describe('proposalsFrom', () => {
  it('comes back empty when the tester found nothing worth changing', () => {
    // A tester that fills this list every session is inventing work, because a
    // list of changes always looks like value.
    expect(proposalsFrom(note({ proposals: [] }))).toEqual([]);
    expect(proposalsFrom(note())).toEqual([]);
  });

  it('keeps a witnessed bug and an opinion apart', () => {
    const plan = proposalsFrom(
      note({
        proposals: [
          { kind: 'bug', text: 'the audit total goes negative', evidence: [6] },
          { kind: 'suggestion', text: 'the intake week could be longer', evidence: [2] },
        ],
      }),
    );
    expect(plan.map((item) => item.kind)).toEqual(['bug', 'suggestion']);
    expect(plan[0].text).toBe('the audit total goes negative');
  });

  it('carries the placed caveat into any proposal that rests on it', () => {
    const plan = proposalsFrom(
      note({ proposals: [{ kind: 'bug', text: 'the audit total goes negative', evidence: [6] }] }),
    );
    expect(plan[0].reached).toBe('placed');
    expect(plan[0].evidence).toEqual([6]);
  });

  it('calls a proposal played only when everything behind it was played', () => {
    const plan = proposalsFrom(
      note({ proposals: [{ kind: 'bug', text: 'both screens misread the total', evidence: [2, 6] }] }),
    );
    expect(plan[0].reached).toBe('placed');
  });

  it('drops anything that does not point at something the tester saw', () => {
    // The catalogue test. A proposal that could have been written without
    // playing this game has nothing to anchor it, and it does not survive.
    const plan = proposalsFrom(
      note({
        proposals: [
          { kind: 'suggestion', text: 'consider adding checkpoints', evidence: [] },
          { kind: 'bug', text: 'something on picture forty', evidence: [40] },
          { kind: 'bug', text: 'the audit total goes negative', evidence: [6] },
        ],
      }),
    );
    expect(plan.map((item) => item.text)).toEqual(['the audit total goes negative']);
  });

  it('gives every proposal an id that stays the same between two reads', () => {
    const source = note({
      proposals: [
        { kind: 'bug', text: 'a', evidence: [2] },
        { kind: 'suggestion', text: 'b', evidence: [2] },
      ],
    });
    const first = proposalsFrom(source).map((item) => item.id);
    expect(new Set(first).size).toBe(2);
    expect(proposalsFrom(source).map((item) => item.id)).toEqual(first);
  });
});

describe('parseProposals', () => {
  it('reads a witnessed bug and a preference as the different things they are', () => {
    expect(parseProposals('BUG 6: the audit total goes negative\nIDEA 2, 3: give the intake longer')).toEqual([
      { kind: 'bug', text: 'the audit total goes negative', evidence: [6] },
      { kind: 'suggestion', text: 'give the intake longer', evidence: [2, 3] },
    ]);
  });

  it('reads a session with nothing to change as having nothing to change', () => {
    expect(parseProposals('NOTHING')).toEqual([]);
    expect(parseProposals('I would not change anything I saw.')).toEqual([]);
  });
});

describe('the prompt that asks for a plan of action', () => {
  it('tells the tester that nothing is an answer', () => {
    const plan = testerPrompts({ memory: '', changes: '', lastVerdict: null })[3];
    expect(plan).toMatch(/NOTHING/);
    expect(plan.toLowerCase()).toMatch(/inventing work/);
  });

  it('comes after the tester has already committed to what it saw', () => {
    const prompts = testerPrompts({ memory: '', changes: '', lastVerdict: null });
    const observe = prompts.findIndex((prompt) => /what did you see/i.test(prompt));
    const plan = prompts.findIndex((prompt) => /worth changing\?/i.test(prompt));
    expect(plan).toBeGreaterThan(observe);
  });
});
