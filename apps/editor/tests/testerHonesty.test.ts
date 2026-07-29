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
import {
  anythingPlaced,
  planFrom,
  regressionSentence,
  renderReport,
  verdictSentence,
} from '../server/tester/report';
import { listSessions, sessionDir } from '../server/tester/memory';
import { CRASHED_REGRESSION, unreadableNote, type TesterNote } from '../server/tester/types';

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
    // The same lie as "10/10 times", surviving purely by spelling: "in" was an
    // allowed word and "/" was not, so this one claimed pictures 1 and 10.
    ['BUG 1 in 10: the save file is wiped', 'the save file is wiped'],
    // A COUNT read as an index. The word "frames" is here, but the number is
    // in front of it, which is how you write how many rather than which one.
    ['BUG in 2 frames: the music cuts out', 'the music cuts out'],
    ['IDEA within 3 pictures: show the timer sooner', 'show the timer sooner'],
    // The marker is in front of the number this time, and the number STILL is
    // not a picture: it belongs to the word after it. "frames 3 seconds apart"
    // is a claim about timing, and reading it as a citation of picture three
    // sends an agent to look at a picture the tester never pointed at.
    ['BUG frames 3 seconds apart: the animation stutters', 'the animation stutters'],
    ['IDEA pictures 2 minutes in: show the timer sooner', 'show the timer sooner'],
    ['BUG picture 4 times out of five: the save is wiped', 'the save is wiped'],
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

  it('does not read a clock as a picture number', () => {
    // The colon inside "12:30" is where the line gets cut, so the span in
    // front of it is "at 12". Nothing about that says picture twelve.
    const [proposal] = parseProposals('BUG at 12:30 the music stops');
    expect(proposal.evidence).toEqual([]);
  });

  it('still reads a citation that names what it is pointing at', () => {
    const named: [string, number[]][] = [
      ['BUG picture 4: the floor is missing', [4]],
      ['BUG (frames 4 and 9): the floor is missing', [4, 9]],
      ['BUG #4: the floor is missing', [4]],
      ['BUG in pictures 4, 9: the floor is missing', [4, 9]],
    ];
    for (const [line, evidence] of named) {
      expect(parseProposals(line)[0].evidence, line).toEqual(evidence);
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

  it('never records a negated sameness as sameness', () => {
    // The same defect class as "not better", in the branch that fix did not
    // reach: sameness was tested before negation and had no idea it had been
    // denied, so a reply saying the change worked was filed as "no difference".
    expect(parseVerdict('VERDICT: not the same, it is better').onTheChange.verdict).toBe('better');
    expect(parseVerdict('VERDICT: not unchanged, the gap is worse now').onTheChange.verdict).toBe('worse');
    // Denied and nothing offered in its place. Reading that as any of the
    // three would be the same invention in a quieter form.
    expect(parseVerdict('VERDICT: not the same').onTheChange.verdict).toBe('unclear');
  });

  it('reads a verdict whose sentence negates something other than the verdict', () => {
    // Negation used to be tested against the whole clause, so any "never",
    // "no longer" or "barely" anywhere in the sentence threw the verdict away.
    // Those are ordinary words in a sentence about a bug that got fixed, so a
    // fixed bug was reported to the person as "It did not give a verdict".
    expect(parseVerdict('VERDICT: much better now that it never crashes').onTheChange.verdict).toBe(
      'better',
    );
    expect(parseVerdict('VERDICT: worse now that it never gets past the menu').onTheChange.verdict).toBe(
      'worse',
    );
    expect(parseVerdict('VERDICT: better now that it barely stutters').onTheChange.verdict).toBe('better');
  });

  it('still refuses the verdict word its own sentence denies', () => {
    // The other half of the same rule, and the fault the clause-wide test was
    // put there to stop. A negator in front of the verdict word still denies it.
    expect(parseVerdict('VERDICT: the crash is not better').onTheChange.verdict).toBe('unclear');
    expect(parseVerdict('VERDICT: it is not any worse').onTheChange.verdict).toBe('unclear');
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

  it('takes the session number from the folder, not from the note', async () => {
    // The folder is documented as hand-editable, and a note claiming a number
    // that is not its own folder's collapsed two sessions onto one row: both
    // rendered whichever verdict was written last, and the report opened from
    // either one showed the same session twice.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'notes-'));
    try {
      for (const [dirId, claimed] of [[1, 1], [2, 1], [3, 9]] as const) {
        const dir = sessionDir(root, dirId);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(
          path.join(dir, 'note.json'),
          JSON.stringify(note({ session: claimed })),
          'utf8',
        );
      }
      const sessions = await listSessions(root);
      expect(sessions.map((s) => s.session)).toEqual([1, 2, 3]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('lists both sessions when a folder with no number of its own claims one', async () => {
    // The folder only lends a number when its name is one. A copy, a backup or
    // a rename has none to lend, so its note keeps the number it claims and two
    // sessions here really can carry the same one. Both are listed, because a
    // session vanishing out of an append-only history is its own kind of lie,
    // and nothing downstream may read that number as an identity.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'notes-'));
    try {
      const sessions = path.join(root, '.hearth', 'tester', 'sessions');
      for (const entry of ['0003', 'copy-of-0003']) {
        await fsp.mkdir(path.join(sessions, entry), { recursive: true });
        await fsp.writeFile(
          path.join(sessions, entry, 'note.json'),
          JSON.stringify(note({ session: 3 })),
          'utf8',
        );
      }
      expect((await listSessions(root)).map((s) => s.session)).toEqual([3, 3]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * A session that never got asked cannot answer, and an empty answer it never
 * gave must never be rendered as the tester having looked and found nothing.
 * Three sections of the report are drawn from `length === 0`, and on a crashed
 * session all three used to read as a clean bill of health for a game the
 * tester barely opened.
 */
describe('a report on a session that ended early', () => {
  const crashed = note({
    stopped: 'error',
    observations: [],
    openQuestions: [],
    proposals: [],
    regression: CRASHED_REGRESSION,
    onTheChange: {
      seen: 'It did not get far enough to say.',
      verdict: 'unclear',
      why: 'The session ended early and it never gave a verdict: no browser on this machine',
    },
  });

  it('claims none of the three absences it was never in a position to check', () => {
    const text = renderReport(crashed);
    expect(text).not.toContain('It found nothing here worth changing');
    expect(text).not.toContain('Nothing it wanted to raise');
    expect(text).not.toContain('It did not write down anything it saw this session');
  });

  it('says the session was cut short in every section that came out empty', () => {
    const text = renderReport(crashed);
    expect(text.match(/nothing was written down here/g)).toHaveLength(3);
  });

  it('claims nothing at all out of a note that could not be read', () => {
    const text = renderReport(unreadableNote(4));
    expect(text).not.toContain('It found nothing here worth changing');
    expect(text).not.toContain('Nothing it wanted to raise');
    expect(text).not.toContain('It did not write down anything it saw this session');
    expect(text).toContain('Session 4');
  });

  it('still lets a finished session say plainly that it found nothing', () => {
    // The other half of the rule. A tester that was asked and answered nothing
    // is a real and frequently correct result, and it must keep its sentence.
    const text = renderReport(note({ observations: [], openQuestions: [], proposals: [] }));
    expect(text).toContain('It found nothing here worth changing');
    expect(text).toContain('Nothing it wanted to raise');
    expect(text).toContain('It did not write down anything it saw this session');
  });
});

describe('regressionSentence and a session that crashed', () => {
  it('does not count the crash as the tester having checked', () => {
    // Neither empty nor either sentinel, so a stack trace answered "yes, it
    // looked", and every surface then rendered the crash as the answer.
    expect(regressionSentence(CRASHED_REGRESSION).answered).toBe(false);
  });

  it('still counts a real answer, including the answer "nothing"', () => {
    expect(regressionSentence('nothing').answered).toBe(true);
    expect(regressionSentence('the pause menu stopped closing').answered).toBe(true);
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
