/**
 * The report a person reads, and the plan of action they pick from.
 *
 * Both are pure, which is the point: the rules that keep a session honest are
 * checkable here without a model, a browser or a game.
 */
import { describe, it, expect } from 'vitest';
import { parseProposals, testerPrompts } from '../server/tester/prompt';
import {
  droppedSentence,
  placementSentence,
  planFrom,
  proposalsFrom,
  renderReport,
  REACHABILITY_CAVEAT,
} from '../server/tester/report';
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

describe('placementSentence', () => {
  it('says out loud that a game named nowhere, rather than going quiet', () => {
    // A capability Hearth does not have has to be a sentence someone reads.
    // Left unsaid, its absence looks like a gap in the report instead.
    const text = placementSentence(note({ placement: { offered: 0 } }));
    expect(text).toMatch(/named nowhere/i);
    expect(text).toMatch(/played from the start/i);
  });

  it('names what the game offered and what the tester did with it', () => {
    expect(placementSentence(note({ placement: { offered: 2 } }))).toMatch(/two places/);
    expect(placementSentence(note({ placement: { offered: 2 } }))).toMatch(/from the start anyway/i);
    expect(placementSentence(note({ placement: { offered: 2, entered: 'The week of the audit' } }))).toContain(
      'The week of the audit',
    );
  });

  it('counts one place as one place', () => {
    expect(placementSentence(note({ placement: { offered: 1 } }))).toMatch(/one place\b/);
  });

  it('says nothing at all about a session played before any game could be asked', () => {
    // Reading a missing field as "the game named nothing" would put a claim in
    // the game's mouth that nobody ever made.
    expect(placementSentence(note())).toBeNull();
    expect(renderReport(note())).not.toMatch(/Where it played/);
  });

  it('reaches the report when it has something to say', () => {
    expect(renderReport(note({ placement: { offered: 0 } }))).toMatch(/Where it played/);
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

  /**
   * The shapes a model actually writes.
   *
   * This table is the regression test for the reason the plan of action had
   * never once worked against a live model: the old pattern demanded the marker
   * at the very start of the line and digits and commas between it and the
   * colon. Everything a model reaches for in markdown was dropped in silence,
   * and a dropped proposal used to be indistinguishable from a session that had
   * found nothing wrong.
   */
  const SHAPES: [string, string, { kind: string; text: string; evidence: number[] }][] = [
    ['bare, as the prompt draws it', 'BUG 7: the audit total goes negative', { kind: 'bug', text: 'the audit total goes negative', evidence: [7] }],
    ['a bullet in front of it', '- BUG 7: the audit total goes negative', { kind: 'bug', text: 'the audit total goes negative', evidence: [7] }],
    ['bold, the way a model formats a list', '**BUG 7:** the audit total goes negative', { kind: 'bug', text: 'the audit total goes negative', evidence: [7] }],
    ['numbered', '1. BUG 7: the audit total goes negative', { kind: 'bug', text: 'the audit total goes negative', evidence: [7] }],
    ['the picture reference written out in words', 'BUG (pictures 7, 21): the audit total goes negative', { kind: 'bug', text: 'the audit total goes negative', evidence: [7, 21] }],
    ['a bullet AND bold', '- **BUG 7:** the audit total goes negative', { kind: 'bug', text: 'the audit total goes negative', evidence: [7] }],
    ['bold around the reference instead of the marker', '**BUG 7**: the audit total goes negative', { kind: 'bug', text: 'the audit total goes negative', evidence: [7] }],
    ['a star bullet', '* IDEA 3: give the intake longer', { kind: 'suggestion', text: 'give the intake longer', evidence: [3] }],
    ['a heading', '### BUG 4: the queue never clears', { kind: 'bug', text: 'the queue never clears', evidence: [4] }],
    ['"and" between the pictures', 'BUG 7 and 21: the audit total goes negative', { kind: 'bug', text: 'the audit total goes negative', evidence: [7, 21] }],
    ['a hash before the number', 'IDEA #5: the button could be bigger', { kind: 'suggestion', text: 'the button could be bigger', evidence: [5] }],
    ['indented under a bullet', '    - BUG 9: it fell through the floor', { kind: 'bug', text: 'it fell through the floor', evidence: [9] }],
  ];

  for (const [name, line, expected] of SHAPES) {
    it(`reads a proposal written ${name}`, () => {
      expect(parseProposals(line)).toEqual([expected]);
    });
  }

  it('does not read a marker out of the middle of a sentence', () => {
    // Widening what may sit in FRONT of the marker must not turn every mention
    // of the word into a proposal, or the plan fills up with the tester's prose.
    expect(parseProposals('The worst BUG 7: I saw was the total.')).toEqual([]);
    expect(parseProposals('DEBUG: the frame counter is on')).toEqual([]);
    expect(parseProposals('IDEAS: I have a few')).toEqual([]);
  });

  it('reads a line that names no picture, and leaves the anchoring to the report', () => {
    // Parsed rather than discarded here, so `report.ts` can count what it drops
    // and the reader can be told a proposal existed at all.
    expect(parseProposals('BUG: the jump feels floaty')).toEqual([
      { kind: 'bug', text: 'the jump feels floaty', evidence: [] },
    ]);
  });
});

describe('a proposal about a picture the tester wrote no SAW line about', () => {
  it('survives, because that was never the rule the prompt asked for', () => {
    // The bug this pins. `seen` used to be built from the observations, so a
    // proposal about picture 7 of an eight picture session died whenever the
    // tester had written its SAW lines about two other pictures, which is what
    // testers actually do. Nothing in the prompt asked for that, and nothing in
    // the report admitted to it.
    const plan = proposalsFrom(
      note({ proposals: [{ kind: 'bug', text: 'the total is wrong here too', evidence: [7] }] }),
    );
    expect(plan.map((item) => item.text)).toEqual(['the total is wrong here too']);
  });

  it('still carries the placed caveat, worked out from where the placement began', () => {
    // Picture 6 is the earliest placed one in this session, so picture 7 is
    // placed as well. Guessing 'played' here would quietly promote a claim
    // about content the game handed the tester into evidence that a player can
    // reach it.
    const plan = proposalsFrom(
      note({ proposals: [{ kind: 'bug', text: 'the total is wrong here too', evidence: [7] }] }),
    );
    expect(plan[0].reached).toBe('placed');
  });

  it('is played when it sits before the placement began', () => {
    const plan = proposalsFrom(
      note({ proposals: [{ kind: 'bug', text: 'the intake list is empty', evidence: [3] }] }),
    );
    expect(plan[0].reached).toBe('played');
  });

  it('is still bounded by the pictures the session actually took', () => {
    const plan = proposalsFrom(
      note({ frames: 4, proposals: [{ kind: 'bug', text: 'on picture seven', evidence: [7] }] }),
    );
    expect(plan).toEqual([]);
  });

  it('says so in the prompt, in as many words', () => {
    const prompt = testerPrompts({ memory: '', changes: '', lastVerdict: null })[3];
    expect(prompt).toMatch(/name at least one picture number/i);
    expect(prompt).toMatch(/did not write a SAW line about/i);
  });
});

describe('what happens to a proposal that is dropped', () => {
  it('is counted rather than absorbed into "it found nothing"', () => {
    const dropped = note({
      proposals: [
        { kind: 'bug', text: 'the jump feels floaty', evidence: [] },
        { kind: 'suggestion', text: 'consider checkpoints', evidence: [] },
        { kind: 'bug', text: 'something is off', evidence: [] },
      ],
    });
    const { plan, dropped: lost } = planFrom(dropped);
    expect(plan).toEqual([]);
    expect(lost).toHaveLength(3);

    const text = renderReport(dropped);
    expect(text).toMatch(/It proposed three things/);
    expect(text).toMatch(/none of them named a picture from this session/);
    // The sentence that must never be used to report a parse miss.
    expect(text).not.toMatch(/found nothing here worth changing/);
  });

  it('keeps "it found nothing" for the session that really did find nothing', () => {
    expect(renderReport(note({ proposals: [] }))).toMatch(/found nothing here worth changing/);
    expect(droppedSentence([], true)).toBeNull();
  });

  it('tells a picture nobody took apart from no picture at all', () => {
    const text = renderReport(
      note({ frames: 8, proposals: [{ kind: 'bug', text: 'on picture forty', evidence: [40] }] }),
    );
    expect(text).toMatch(/pointed at a picture this session did not take/);
  });

  it('is a footnote rather than a headline when something did survive', () => {
    const text = renderReport(
      note({
        proposals: [
          { kind: 'bug', text: 'the audit total goes negative', evidence: [6] },
          { kind: 'bug', text: 'the jump feels floaty', evidence: [] },
        ],
      }),
    );
    expect(text).toContain('the audit total goes negative');
    expect(text).toMatch(/It proposed one more thing/);
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
