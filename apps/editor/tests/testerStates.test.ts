/**
 * The tester asking to be put somewhere.
 *
 * The states here are a quarter and an audit week, never a level list. If
 * anything in the loop starts working better for games shaped like platformers,
 * these tests are where it should show up.
 */
import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideFromReply, parseObservations, playPrompt } from '../server/tester/prompt';
import { runTesterSession } from '../server/tester/session';
import type { ChatDriver, ChatEvent } from '../server/chat';
import { EventQueue } from '../server/chat';

const CONTROLS = { actions: ['left', 'right'], axes: [], pointer: false };

const STATES = [
  { id: 'y1-spring', label: 'Year one, the spring intake' },
  { id: 'audit', label: 'The week of the audit', detail: 'two departments unstaffed' },
];

class FakeDriver implements ChatDriver {
  readonly kind = 'stub' as const;
  readonly queue = new EventQueue<ChatEvent>();
  readonly asked: string[] = [];
  constructor(private readonly replies: string[]) {}
  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }
  async start(): Promise<void> {}
  send(text: string): void {
    this.asked.push(text);
    const reply = this.replies.shift() ?? 'DONE';
    this.queue.push({ type: 'message-delta', text: reply });
    this.queue.push({ type: 'turn-complete' });
  }
  stop(): void {
    this.queue.close();
  }
}

/** A game with no levels and no avatar, which either cooperates or does not. */
function fakeGame(opts: { states?: typeof STATES; enterThrows?: boolean } = {}) {
  const entered: string[] = [];
  const game: Record<string, unknown> = {
    capabilities: { input: { actions: ['left', 'right'], axes: [], pointer: false } },
    start: async () => {},
    stop: async () => {},
    step: async () => ({}),
    setActionDown: async () => {},
    setActionUp: async () => {},
    setAxis: async () => {},
    sendPointer: async () => {},
    screenshot: async () => new Uint8Array([1, 2, 3]),
  };
  if (opts.states) {
    game.listStates = async () => opts.states;
    game.enterState = async (id: string) => {
      entered.push(id);
      if (opts.enterThrows) throw new Error('the save file is corrupt');
    };
  }
  return { game, entered };
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'states-'));
  try {
    return await fn(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const REFLECTION = [
  'SAW 1: the intake screen listed nobody\nSAW 3: the audit total came out negative',
  'CHANGE: you rewrote the budget\nVERDICT: better\nWHY: it balanced\nWORSE: nothing',
  '# What I know\n\nIt is a bureau sim.',
];

describe('decideFromReply', () => {
  it('reads a request to be put somewhere', () => {
    expect(decideFromReply('I would like to see the audit.\nENTER: audit')).toEqual({
      kind: 'enter',
      id: 'audit',
    });
  });
});

describe('playPrompt', () => {
  it('says nothing about being put anywhere when the game declared nothing', () => {
    const prompt = playPrompt(1, 8, CONTROLS, []);
    expect(prompt).not.toMatch(/ENTER/);
    expect(prompt.toLowerCase()).not.toMatch(/put you|put yourself/);
  });

  it('offers the states by the names the game gave them', () => {
    const prompt = playPrompt(1, 8, CONTROLS, STATES);
    expect(prompt).toContain('Year one, the spring intake');
    expect(prompt).toContain('The week of the audit');
    expect(prompt).toContain('two departments unstaffed');
    expect(prompt).toContain('ENTER: audit');
  });

  it('offers rather than instructs, so the opening still gets played', () => {
    const prompt = playPrompt(1, 8, CONTROLS, STATES);
    expect(prompt).toMatch(/do not have to|if you want/i);
  });
});

describe('parseObservations', () => {
  it('marks what was seen after a placement, and leaves the rest alone', () => {
    const text = 'SAW 1: the intake screen was empty\nSAW 4: the audit total was negative';
    expect(parseObservations(text, 6, 3)).toEqual([
      { frame: 1, text: 'the intake screen was empty', reached: 'played' },
      { frame: 4, text: 'the audit total was negative', reached: 'placed' },
    ]);
  });
});

describe('runTesterSession with states', () => {
  it('puts the game where the tester asked, and marks what it saw after', async () => {
    await withRoot(async (root) => {
      const { game, entered } = fakeGame({ states: STATES });
      const driver = new FakeDriver(['ACTION: right', 'ENTER: audit', 'DONE', ...REFLECTION]);
      const note = await runTesterSession({
        root,
        dir: root,
        driver,
        maxSteps: 6,
        openGame: async () => game as never,
      });
      expect(entered).toEqual(['audit']);
      expect(note.observations).toEqual([
        { frame: 1, text: 'the intake screen listed nobody', reached: 'played' },
        { frame: 3, text: 'the audit total came out negative', reached: 'placed' },
      ]);
    });
  });

  it('ignores a state the game never declared rather than guessing at one', async () => {
    await withRoot(async (root) => {
      const { game, entered } = fakeGame({ states: STATES });
      const driver = new FakeDriver(['ENTER: level17', 'DONE', ...REFLECTION]);
      const note = await runTesterSession({
        root,
        dir: root,
        driver,
        maxSteps: 6,
        openGame: async () => game as never,
      });
      expect(entered).toEqual([]);
      expect(note.observations.every((o) => o.reached === 'played')).toBe(true);
    });
  });

  it('keeps playing when the game fails to put itself anywhere', async () => {
    await withRoot(async (root) => {
      const { game, entered } = fakeGame({ states: STATES, enterThrows: true });
      const driver = new FakeDriver(['ENTER: audit', 'DONE', ...REFLECTION]);
      const note = await runTesterSession({
        root,
        dir: root,
        driver,
        maxSteps: 6,
        openGame: async () => game as never,
      });
      expect(entered).toEqual(['audit']);
      expect(note.stopped).toBe('done');
      // It asked and the game refused, so nothing it saw afterwards was placed.
      expect(note.observations.every((o) => o.reached === 'played')).toBe(true);
      const transcript = await fsp.readFile(
        path.join(root, '.hearth', 'tester', 'sessions', '0001', 'transcript.md'),
        'utf8',
      );
      expect(transcript).toMatch(/save file is corrupt/);
    });
  });

  it('never mentions placement to a game that declared nothing', async () => {
    await withRoot(async (root) => {
      const { game } = fakeGame();
      const driver = new FakeDriver(['ACTION: right', 'DONE', ...REFLECTION]);
      const note = await runTesterSession({
        root,
        dir: root,
        driver,
        maxSteps: 6,
        openGame: async () => game as never,
      });
      expect(driver.asked.join('\n')).not.toMatch(/ENTER/);
      expect(note.observations.every((o) => o.reached === 'played')).toBe(true);
    });
  });
});
