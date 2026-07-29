/**
 * The three ways the tester was made to lie, and the four ways it was made to
 * lose what it said.
 *
 * Every case here was found in shipped code, and every one of them is a claim
 * about somebody's game that the session never supported. They are pinned as
 * tests because each one arrived as a fix for a real fault and each one made
 * things worse than the fault it replaced.
 */
import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProposals, parseVerdict, playPrompt, UNCLEAR_VERDICT } from '../server/tester/prompt';
import { anythingPlaced, planFrom, verdictSentence } from '../server/tester/report';
import { listSessions, sessionDir } from '../server/tester/memory';
import type { TesterNote } from '../server/tester/types';

function note(over: Partial<TesterNote> = {}): TesterNote {
  return {
    session: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    onTheChange: { seen: 'you raised the jump', verdict: 'better', why: 'I cleared the gap' },
    regression: 'nothing',
    observations: [],
    openQuestions: [],
    proposals: [],
    steps: 6,
    frames: 6,
    stopped: 'done',
    ...over,
  };
}

describe('parseProposals and invented evidence', () => {
  // Every one of these lines was turned into a finding anchored to a picture
  // the tester never cited, and the picture file was then handed to an agent
  // as "the picture behind that". Dropping a proposal was the old fault.
  // Minting an anchor is the worse one, and it is the one thing this feature
  // must never do.
  const invented: [string, string][] = [
    ['BUG in level 2: the floor is missing', 'the floor is missing'],
    ['BUG (x=140, y=60): the button is unclickable', 'the button is unclickable'],
    ['BUG 10/10 times: it crashes', 'it crashes'],
    ['IDEA for the 2nd half: more checkpoints', 'more checkpoints'],
  ];

  it.each(invented)('reads %s as a proposal that cites nothing', (line, text) => {
    const proposals = parseProposals(line);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].text).toBe(text);
    expect(proposals[0].evidence).toEqual([]);
  });

  it('still reads a real citation, however it was written', () => {
    const lines = [
      'BUG 7: the audit total goes negative',
      '- BUG 7: the audit total goes negative',
      '**BUG 7:** the audit total goes negative',
      '1. BUG 7: the audit total goes negative',
      'BUG (pictures 7, 21): the audit total goes negative',
      '> - BUG 7: the audit total goes negative',
      '- [ ] BUG 7: the audit total goes negative',
      '**- BUG 7:** the audit total goes negative',
      'BUG7: the audit total goes negative',
      // A dash where the prompt asked for a colon, which models write often
      // enough that missing it dropped real proposals. Escaped rather than
      // typed, because the house rule is no dashes of this kind in source.
      'BUG 7 \u2014 the audit total goes negative',
    ];
    for (const line of lines) {
      const proposals = parseProposals(line);
      expect(proposals, line).toHaveLength(1);
      expect(proposals[0].evidence, line).toContain(7);
    }
  });

  it('reads a long preamble rather than dropping the line in silence', () => {
    // A line the parser misses produces nothing at all, and the report then
    // says "It found nothing here worth changing", which is a sentence about
    // the game. A line it reads and cannot anchor is counted and said out loud.
    const long = `BUG ${'x'.repeat(80)}: the save file is wiped`;
    const proposals = parseProposals(long);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].evidence).toEqual([]);
  });

  it('lets an unanchored proposal reach the dropped list rather than vanishing', () => {
    const { plan, dropped } = planFrom(
      note({ proposals: parseProposals('BUG in level 2: the floor is missing') }),
    );
    expect(plan).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].why).toBe('no-picture');
  });
});

describe('parseVerdict', () => {
  it('never records a negated verdict as that verdict', () => {
    // This was an inversion in the one sentence the whole feature delivers:
    // "not better" came out as "That helped."
    const { onTheChange } = parseVerdict(
      'CHANGE: the jump\nVERDICT: not better, if anything worse\nWHY: I still fell\nWORSE: the jump',
    );
    expect(onTheChange.verdict).toBe('worse');
  });

  it('records an answer that is none of the three as unclear', () => {
    for (const answer of ['mixed', 'I cannot tell', 'hard to say', 'not sure']) {
      const { onTheChange } = parseVerdict(`CHANGE: the jump\nVERDICT: ${answer}\nWHY: I could not tell`);
      expect(onTheChange.verdict, answer).toBe('unclear');
      expect(onTheChange.why, answer).toBe(UNCLEAR_VERDICT);
    }
  });

  it('still reads the three real answers, and "no difference" past its own "no"', () => {
    expect(parseVerdict('VERDICT: better').onTheChange.verdict).toBe('better');
    expect(parseVerdict('VERDICT: worse').onTheChange.verdict).toBe('worse');
    expect(parseVerdict('VERDICT: no-difference').onTheChange.verdict).toBe('no-difference');
    expect(parseVerdict('VERDICT: no real difference').onTheChange.verdict).toBe('no-difference');
  });

  it('says the verdict is missing rather than dressing it as one of the three', () => {
    const sentence = verdictSentence(note({ onTheChange: parseVerdict('VERDICT: mixed').onTheChange }));
    expect(sentence).toContain(UNCLEAR_VERDICT);
    expect(sentence).not.toMatch(/made no real difference|helped/);
  });
});

describe('planFrom and where the tester was', () => {
  it('reports a proposal about a placed picture as placed, with no SAW line to go on', () => {
    // The session recorded the placement at picture 4 and wrote its SAW lines
    // about earlier pictures. Deriving the line from the observations alone
    // recovered nothing, so picture 5 was reported as reached by playing and
    // went to an agent as evidence a player can get there.
    const subject = note({
      placedFrom: 4,
      observations: [{ frame: 2, text: 'I fell in the pit', reached: 'played' }],
      proposals: [{ kind: 'bug', text: 'the boss never spawns', evidence: [5] }],
    });
    expect(planFrom(subject).plan[0].reached).toBe('placed');
    expect(anythingPlaced(subject)).toBe(true);
  });

  it('leaves a picture taken before the placement alone', () => {
    const subject = note({
      placedFrom: 4,
      proposals: [{ kind: 'bug', text: 'the floor is missing', evidence: [2] }],
    });
    expect(planFrom(subject).plan[0].reached).toBe('played');
  });
});

describe('planFrom and the picture bound', () => {
  it('drops every citation when the session is known to have taken none', () => {
    // `frames: 0` is an answer, not an absence. Treating it as absent fell
    // through to the turn count and rendered "Picture 3:" against a file that
    // was never written.
    const { plan, dropped } = planFrom(
      note({ frames: 0, steps: 3, proposals: [{ kind: 'bug', text: 'it crashes', evidence: [3] }] }),
    );
    expect(plan).toHaveLength(0);
    expect(dropped[0].why).toBe('unknown-picture');
  });

  it('still trusts the turn count on a note written before the picture count existed', () => {
    const older = note({ steps: 3, proposals: [{ kind: 'bug', text: 'it crashes', evidence: [3] }] });
    delete older.frames;
    expect(planFrom(older).plan).toHaveLength(1);
  });
});

describe('listSessions and a hand-edited note', () => {
  async function withNote(raw: unknown): Promise<TesterNote[]> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'notes-'));
    try {
      const dir = sessionDir(root, 1);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'note.json'), JSON.stringify(raw), 'utf8');
      return await listSessions(root);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }

  // The guard checked Array.isArray and stopped there, which does not hold for
  // the shape a hand-edit actually produces. Both of these threw out of render,
  // and a throw during render blanks the window rather than the row.
  const malformed: [string, unknown][] = [
    ['an observation with no text', { observations: [{ frame: 3 }] }],
    ['an observation numbered by a string', { observations: [{ frame: '3', text: 'x' }] }],
    ['a question that is not a sentence', { openQuestions: [42] }],
    ['a proposal with no text', { proposals: [{ kind: 'bug' }] }],
    ['evidence that is not picture numbers', { proposals: [{ kind: 'bug', text: 'x', evidence: ['3'] }] }],
  ];

  it.each(malformed)('shows the session as unreadable when it carries %s', async (_label, over) => {
    const sessions = await withNote({ ...note(), ...(over as object) });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session).toBe(1);
    expect(sessions[0].onTheChange.verdict).toBe('unreadable');
    expect(sessions[0].stopped).toBe('unreadable');
  });

  it('still reads a whole note', async () => {
    const sessions = await withNote(note({ observations: [{ frame: 1, text: 'I fell' }] }));
    expect(sessions[0].onTheChange.verdict).toBe('better');
  });
});

describe('playPrompt numbering', () => {
  const controls = { actions: ['left'], axes: [], pointer: false };

  it('numbers by the picture, not by the turn', () => {
    // A failed screenshot costs a turn its picture, so on turn five the tester
    // may be looking at picture four. It used to be told five, and its
    // citation of five was then thrown away as a picture nobody took.
    expect(playPrompt(5, 6, controls, [], [], 4)).toContain('Picture 4.');
  });

  it('says there is no picture rather than numbering one that was never taken', () => {
    const text = playPrompt(5, 6, controls, [], [], null);
    expect(text).toMatch(/no picture this turn/i);
    expect(text).not.toMatch(/Picture \d/);
  });
});
