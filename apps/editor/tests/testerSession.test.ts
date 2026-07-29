/**
 * The play loop, and the wording that keeps it honest.
 *
 * The wording is not decoration here. Two of the three sycophancy defences are
 * structural properties of the prompt order and the required fields, so they are
 * pinned as tests rather than left to whoever edits the strings next.
 *
 * The loop itself runs against a fake game and a fake driver: no browser, no
 * model, no quota.
 */
import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideFromReply,
  testerPrompts,
  parseObservations,
  parseVerdict,
  MISSING_REGRESSION,
} from '../server/tester/prompt';
import { runTesterSession } from '../server/tester/session';
import { regressionSentence } from '../server/tester/report';
import { listSessions, writeNote } from '../server/tester/memory';
import type { TesterNote } from '../server/tester/types';
import type { ChatDriver, ChatEvent } from '../server/chat';
import { EventQueue } from '../server/chat';

describe('decideFromReply', () => {
  it('reads a held action out of a plain reply', () => {
    expect(decideFromReply('I will hold right and jump.\nACTION: right, jump')).toEqual({
      kind: 'actions', actions: ['right', 'jump'],
    });
  });

  it('reads a pointer click, so mouse-driven games are playable', () => {
    expect(decideFromReply('CLICK: 120, 340')).toEqual({ kind: 'pointer', x: 120, y: 340, click: true });
  });

  it('stops when the tester says it is done', () => {
    expect(decideFromReply('I have seen enough.\nDONE')).toEqual({ kind: 'done' });
  });

  it('waits rather than guessing when the reply names nothing it can do', () => {
    // A reply the parser cannot read must not become a random input: the
    // session note has to reflect what the tester actually chose.
    expect(decideFromReply('Hmm, interesting.')).toEqual({ kind: 'wait' });
  });
});

describe('testerPrompts', () => {
  it('asks for this session before showing the previous verdict', () => {
    const prompts = testerPrompts({ memory: 'Space jumps.', changes: 'raised the jump', lastVerdict: 'better' });
    const observe = prompts.findIndex((p) => /what did you see/i.test(p));
    const compare = prompts.findIndex((p) => p.includes('better'));
    expect(observe).toBeGreaterThanOrEqual(0);
    expect(compare).toBeGreaterThan(observe);
  });

  it('makes the regression answer mandatory', () => {
    const prompts = testerPrompts({ memory: '', changes: '', lastVerdict: null });
    expect(prompts.join('\n')).toMatch(/anything.*worse/i);
  });
});

describe('parseObservations', () => {
  it('anchors each claim to the frame it was made about', () => {
    expect(parseObservations('SAW 3: I fell in the pit\nSAW 7: the coin did nothing', 10)).toEqual([
      { frame: 3, text: 'I fell in the pit', reached: 'played' },
      { frame: 7, text: 'the coin did nothing', reached: 'played' },
    ]);
  });

  it('drops a claim about a frame that does not exist', () => {
    // A claim with no frame behind it is a claim, not evidence.
    expect(parseObservations('SAW 40: I beat the game', 10)).toEqual([]);
  });
});

describe('parseVerdict', () => {
  it('reads the four labelled answers', () => {
    expect(parseVerdict('CHANGE: the jump is higher\nVERDICT: better\nWHY: I cleared the gap\nWORSE: nothing')).toEqual({
      onTheChange: { seen: 'the jump is higher', verdict: 'better', why: 'I cleared the gap' },
      regression: 'nothing',
    });
  });

  it('records an unanswered regression as unanswered, never as "nothing got worse"', () => {
    // Filling this in for the tester is exactly how a tester becomes a
    // flattery machine: silence would be read as approval forever.
    expect(parseVerdict('CHANGE: x\nVERDICT: better\nWHY: y').regression).toBe(MISSING_REGRESSION);
  });
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** A driver that answers every turn from a script and records what it was asked. */
class FakeDriver implements ChatDriver {
  readonly kind = 'stub' as const;
  readonly queue = new EventQueue<ChatEvent>();
  readonly asked: string[] = [];
  readonly images: number[] = [];
  constructor(private readonly replies: string[]) {}
  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }
  async start(): Promise<void> {}
  send(text: string, _agent?: unknown, attachments?: readonly { mimeType: string }[]): void {
    this.asked.push(text);
    this.images.push((attachments ?? []).length);
    const reply = this.replies.shift() ?? 'DONE';
    this.queue.push({ type: 'message-delta', text: reply });
    this.queue.push({ type: 'turn-complete' });
  }
  stop(): void {
    this.queue.close();
  }
}

/** A game that does nothing but count what was done to it. */
function fakeGame() {
  const held: string[] = [];
  const pointers: { x: number; y: number }[] = [];
  let steps = 0;
  let stopped = false;
  return {
    game: {
      capabilities: { input: { actions: ['left', 'right', 'jump'], axes: [], pointer: true } },
      start: async () => {},
      stop: async () => { stopped = true; },
      step: async () => { steps += 1; return {}; },
      setActionDown: async (name: string) => { held.push(name); },
      setActionUp: async () => {},
      setAxis: async () => {},
      sendPointer: async (x: number, y: number) => { pointers.push({ x, y }); },
      screenshot: async () => new Uint8Array([1, 2, 3]),
    },
    seen: () => ({ held, pointers, steps, stopped }),
  };
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-'));
  try {
    return await fn(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/** A session already on disk, so the run under test is not a first session. */
async function withPriorSession(root: string): Promise<void> {
  const prior: TesterNote = {
    session: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    onTheChange: { seen: 'you raised the jump', verdict: 'better', why: 'I cleared the gap' },
    regression: 'nothing',
    observations: [],
    openQuestions: [],
    steps: 4,
    stopped: 'done',
  };
  await writeNote(root, prior);
}

/** A driver that answers from a script and then fails, the way a backend drops. */
class FailingDriver implements ChatDriver {
  readonly kind = 'stub' as const;
  readonly queue = new EventQueue<ChatEvent>();
  private sent = 0;
  constructor(private readonly replies: string[], private readonly failAfter: number) {}
  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }
  async start(): Promise<void> {}
  send(): void {
    this.sent += 1;
    if (this.sent > this.failAfter) {
      this.queue.push({ type: 'error', message: 'ENOENT: the agent went away' });
      this.queue.push({ type: 'turn-complete' });
      return;
    }
    this.queue.push({ type: 'message-delta', text: this.replies.shift() ?? 'DONE' });
    this.queue.push({ type: 'turn-complete' });
  }
  stop(): void {
    this.queue.close();
  }
}

const REFLECTION = [
  'SAW 1: the player fell straight through the floor',
  'CHANGE: you raised the jump\nVERDICT: better\nWHY: I cleared the gap\nWORSE: nothing',
  '# What I know\n\nSpace jumps.',
];

describe('runTesterSession', () => {
  it('plays, then writes a note the history can read', async () => {
    await withRoot(async (root) => {
      const { game, seen } = fakeGame();
      const driver = new FakeDriver(['ACTION: right', 'DONE', ...REFLECTION]);
      const note = await runTesterSession({
        root, dir: root, driver, maxSteps: 6, openGame: async () => game as never,
      });
      expect(note.session).toBe(1);
      expect(note.stopped).toBe('done');
      expect(note.onTheChange.verdict).toBe('first-session');
      expect(note.regression).toBe('nothing');
      expect(seen().held).toContain('right');
      expect((await listSessions(root)).map((n) => n.session)).toEqual([1]);
    });
  });

  it('never claims a verdict on a change for its very first session', async () => {
    // There is nothing to compare against the first time. A tester that
    // answered "better" here would be reporting on a change it never saw.
    await withRoot(async (root) => {
      const { game } = fakeGame();
      const driver = new FakeDriver(['DONE', ...REFLECTION]);
      const note = await runTesterSession({ root, dir: root, driver, maxSteps: 4, openGame: async () => game as never });
      expect(note.onTheChange.verdict).toBe('first-session');
    });
  });

  it('spends its budget and stops, rather than playing forever', async () => {
    await withRoot(async (root) => {
      const { game, seen } = fakeGame();
      const driver = new FakeDriver(Array.from({ length: 20 }, () => 'ACTION: right'));
      const note = await runTesterSession({ root, dir: root, driver, maxSteps: 3, openGame: async () => game as never });
      expect(note.stopped).toBe('budget');
      expect(note.steps).toBe(3);
      expect(seen().steps).toBe(3);
    });
  });

  it('stops when asked and still writes the session down', async () => {
    await withRoot(async (root) => {
      const { game } = fakeGame();
      const controller = new AbortController();
      const driver = new FakeDriver(['ACTION: right', 'ACTION: right', ...REFLECTION]);
      const note = await runTesterSession({
        root, dir: root, driver, maxSteps: 30, signal: controller.signal,
        openGame: async () => game as never,
        onThought: () => { if (!controller.signal.aborted) controller.abort(); },
      });
      expect(note.stopped).toBe('user');
      expect((await listSessions(root)).map((n) => n.session)).toEqual([1]);
    });
  });

  it('records a session that crashed rather than losing it', async () => {
    // A session that crashed is still a session that happened, and losing its
    // record is worse than recording a failure.
    await withRoot(async (root) => {
      const driver = new FakeDriver([]);
      const note = await runTesterSession({
        root, dir: root, driver, maxSteps: 4,
        openGame: async () => { throw new Error('no browser on this machine'); },
      });
      expect(note.stopped).toBe('error');
      expect(note.onTheChange.why).toMatch(/no browser/);
      expect((await listSessions(root)).map((n) => n.session)).toEqual([1]);
    });
  });

  it('gives no verdict at all for a session that never played', async () => {
    // 'no-difference' is a verdict, and it was the default. A session that
    // crashed before it opened the game reached the history saying "It says
    // your last change made no real difference" about a game it never saw.
    await withRoot(async (root) => {
      await withPriorSession(root);
      const driver = new FakeDriver([]);
      const note = await runTesterSession({
        root, dir: root, driver, maxSteps: 4,
        openGame: async () => { throw new Error('no browser on this machine'); },
      });
      expect(note.session).toBe(2);
      expect(note.stopped).toBe('error');
      expect(note.onTheChange.verdict).toBe('unclear');
      expect(note.onTheChange.why).toMatch(/no browser/);
    });
  });

  it('never lets a crash stand in for the tester having checked for regressions', async () => {
    // The crash message is neither empty nor either sentinel, so every reader
    // of the note counted a stack trace as "the tester looked and answered".
    // The one field this feature exists to keep honest cannot be answered by
    // the session falling over.
    await withRoot(async (root) => {
      await withPriorSession(root);
      const driver = new FakeDriver([]);
      const note = await runTesterSession({
        root, dir: root, driver, maxSteps: 4,
        openGame: async () => { throw new Error('no browser on this machine'); },
      });
      expect(regressionSentence(note.regression).answered).toBe(false);
      expect(note.regression).not.toMatch(/no browser/);
    });
  });

  it('keeps the reason the tester gave when only the write-up fell over', async () => {
    // "That helped, because ENOENT" was reachable: the crash handler replaced
    // a real WHY with the error message while leaving the verdict standing.
    await withRoot(async (root) => {
      await withPriorSession(root);
      const { game } = fakeGame();
      // Plays, sees, gives a verdict, and the ask after that one fails.
      const driver = new FailingDriver(['DONE', ...REFLECTION], 3);
      const note = await runTesterSession({
        root, dir: root, driver, maxSteps: 4, openGame: async () => game as never,
      });
      expect(note.stopped).toBe('error');
      expect(note.onTheChange.verdict).toBe('better');
      expect(note.onTheChange.why).toBe('I cleared the gap');
      expect(note.onTheChange.why).not.toMatch(/ENOENT/);
    });
  });

  it('shows the tester the frame it is deciding on', async () => {
    await withRoot(async (root) => {
      const { game } = fakeGame();
      const driver = new FakeDriver(['DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 4, openGame: async () => game as never });
      expect(driver.images.some((count) => count > 0)).toBe(true);
      const frames = await fsp.readdir(path.join(root, '.hearth', 'tester', 'sessions', '0001', 'frames'));
      expect(frames.length).toBeGreaterThan(0);
    });
  });
});
