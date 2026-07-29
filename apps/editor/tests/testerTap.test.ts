/**
 * Tapping, and not blaming a game for what holding a key does.
 *
 * This exists because of a real session. The tester was given a racing game,
 * held a steering input because holding was the only thing it could do, watched
 * the car spin, and wrote down that the controls were broken and the game was
 * unpleasant to play. Nothing was broken. No person plays a racer by leaning on
 * left, and the tester had no verb for what a person would have done.
 *
 * So there are two halves here and they are tested separately. The tester can
 * now press and let go, which is a capability; and it is told, in words and then
 * again from its own record, that a control it only ever held is a control it
 * has not finished testing, which is a constraint on what it may claim.
 */
import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideFromReply, howYouPlayed, testerPrompts, playPrompt } from '../server/tester/prompt';
import { runTesterSession } from '../server/tester/session';
import type { ChatDriver, ChatEvent } from '../server/chat';
import { EventQueue } from '../server/chat';

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
    this.queue.push({ type: 'message-delta', text: this.replies.shift() ?? 'DONE' });
    this.queue.push({ type: 'turn-complete' });
  }
  stop(): void {
    this.queue.close();
  }
}

/**
 * A game that records the ORDER of everything done to it, which is the only way
 * to tell a tap from a hold: both press the same key, and the difference is
 * entirely in when it comes back up relative to the step.
 */
function recordingGame() {
  const log: string[] = [];
  return {
    game: {
      capabilities: { input: { actions: ['left', 'right', 'jump'], axes: ['steer'], pointer: false } },
      start: async () => {},
      stop: async () => {},
      step: async () => {
        log.push('step');
        return {};
      },
      setActionDown: async (name: string) => {
        log.push(`down:${name}`);
      },
      setActionUp: async (name: string) => {
        log.push(`up:${name}`);
      },
      setAxis: async (name: string, value: number) => {
        log.push(`axis:${name}=${value}`);
      },
      sendPointer: async () => {},
      setKeyDown: async (key: string) => {
        log.push(`keydown:${key}`);
      },
      setKeyUp: async (key: string) => {
        log.push(`keyup:${key}`);
      },
      screenshot: async () => new Uint8Array([1, 2, 3]),
    },
    log: () => log,
  };
}

const REFLECTION = [
  'SAW 1: the car turned',
  'CHANGE: you changed the steering\nVERDICT: better\nWHY: it turned\nWORSE: nothing',
  'NOTHING',
  '# What I know\n\nIt is a racing game.',
];

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tap-'));
  try {
    return await fn(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

describe('reading a tap out of a reply', () => {
  it('reads TAP as its own decision, not as a hold', () => {
    expect(decideFromReply('I will nudge it right.\nTAP: right')).toEqual({
      kind: 'tap',
      actions: ['right'],
    });
  });

  it('still reads the old ACTION line, so nothing that worked stops working', () => {
    expect(decideFromReply('ACTION: right, jump')).toEqual({
      kind: 'actions',
      actions: ['right', 'jump'],
    });
  });

  it('reads HOLD as the same thing ACTION always meant', () => {
    // The briefing now teaches HOLD, because next to TAP the word ACTION says
    // nothing about duration. ACTION stays readable so a model that learned the
    // older word is not silently ignored.
    expect(decideFromReply('HOLD: left')).toEqual({ kind: 'actions', actions: ['left'] });
  });

  it('prefers the tap when a reply somehow carries both', () => {
    expect(decideFromReply('TAP: right\nHOLD: left')).toEqual({ kind: 'tap', actions: ['right'] });
  });

  it('is still a wait when the reply names nothing, rather than a stray press', () => {
    expect(decideFromReply('That looks like a car.')).toEqual({ kind: 'wait' });
  });
});

describe('what a tap actually does to the game', () => {
  it('lets go after the step, so the next picture is of a game that was tapped', async () => {
    // The whole difference between the two verbs. A tap is down across its own
    // step and up before the next screenshot, so the tester sees what a press
    // DID; a hold is still down while the next picture is taken, so the tester
    // sees the game being driven.
    await withRoot(async (root) => {
      const { game, log } = recordingGame();
      const driver = new FakeDriver(['TAP: right', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 4, openGame: async () => game as never });
      expect(log().slice(0, 3)).toEqual(['down:right', 'step', 'up:right']);
    });
  });

  it('keeps a held input down through the next picture', async () => {
    await withRoot(async (root) => {
      const { game, log } = recordingGame();
      const driver = new FakeDriver(['HOLD: right', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 4, openGame: async () => game as never });
      const upAt = log().indexOf('up:right');
      const stepAt = log().indexOf('step');
      // Released when the tester next decides, which is after the step, never
      // as part of it.
      expect(log().slice(0, 2)).toEqual(['down:right', 'step']);
      expect(upAt).toBeGreaterThan(stepAt);
    });
  });

  it('taps an axis back to rest rather than leaving it driven', async () => {
    await withRoot(async (root) => {
      const { game, log } = recordingGame();
      const driver = new FakeDriver(['TAP: steer', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 4, openGame: async () => game as never });
      expect(log().slice(0, 3)).toEqual(['axis:steer=1', 'step', 'axis:steer=0']);
    });
  });

  it('taps a raw key the game never declared, and releases that too', async () => {
    await withRoot(async (root) => {
      const { game, log } = recordingGame();
      const driver = new FakeDriver(['TAP: R', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 4, openGame: async () => game as never });
      expect(log().slice(0, 3)).toEqual(['keydown:R', 'step', 'keyup:R']);
    });
  });
});

describe('what the tester is told before it plays', () => {
  it('offers tapping first, because that is what a person does most', () => {
    const [briefing] = testerPrompts({ memory: '', changes: '', lastVerdict: null });
    expect(briefing).toMatch(/TAP: <input names/);
    expect(briefing).toMatch(/HOLD: <input names/);
    expect(briefing.indexOf('TAP: <input names')).toBeLessThan(briefing.indexOf('HOLD: <input names'));
  });

  it('says that holding a direction is a choice with consequences', () => {
    // The racing game in one sentence. Without this the tester reads a spin as
    // the game misbehaving rather than as what leaning on a steering key does.
    const [briefing] = testerPrompts({ memory: '', changes: '', lastVerdict: null });
    expect(briefing).toMatch(/spins, drifts, overshoots or circles/);
    expect(briefing).toMatch(/tap it instead/);
  });

  it('makes trying both ways a condition of calling a control wrong', () => {
    const [briefing] = testerPrompts({ memory: '', changes: '', lastVerdict: null });
    expect(briefing).toMatch(/tried it both ways/);
  });

  it('tells it its own play is the likelier explanation when something goes wrong', () => {
    const [briefing] = testerPrompts({ memory: '', changes: '', lastVerdict: null });
    expect(briefing).toMatch(/you played it wrong/);
  });

  it('names both verbs on every turn, not only in the briefing', () => {
    const prompt = playPrompt(3, 10, { actions: ['left'], axes: [], pointer: false });
    expect(prompt).toMatch(/tap or hold/i);
    expect(prompt).toMatch(/one TAP, HOLD/);
  });
});

describe('what it is asked to look for', () => {
  it('points the plan at gameplay systems rather than at how a key feels', () => {
    const [, , , plan] = testerPrompts({ memory: '', changes: '', lastVerdict: null });
    expect(plan).toMatch(/was there something to do/);
    expect(plan).toMatch(/did anything you did visibly change the game/);
    expect(plan).toMatch(/was there anything after the first thing/);
  });

  it('says plainly that control feel is the thing it is worst placed to judge', () => {
    const [, , , plan] = testerPrompts({ memory: '', changes: '', lastVerdict: null });
    expect(plan).toMatch(/worst\s+placed to judge/);
  });

  it('still refuses to let it claim it knows whether the game is fun', () => {
    // The older honesty rule, which this change must not have loosened while
    // pointing the tester at engagement.
    const [, , , plan] = testerPrompts({ memory: '', changes: '', lastVerdict: null });
    expect(plan).toMatch(/cannot tell whether a game is fun/);
  });
});

describe('reading its own play back to it', () => {
  it('names an input it only ever leaned on', () => {
    const record = howYouPlayed({ tapped: ['jump'], held: ['left', 'jump'] });
    expect(record).toMatch(/You held left down and never once tapped it/);
    expect(record).toMatch(/does\s+not go in a BUG line/);
  });

  it('lists several of them in one sentence', () => {
    const record = howYouPlayed({ tapped: [], held: ['left', 'right'] });
    expect(record).toMatch(/never once tapped them: left, right/);
  });

  it('says nothing at all when it tapped everything it touched', () => {
    // A paragraph that appears every session stops being read, so silence is
    // the common case rather than a reassuring line.
    expect(howYouPlayed({ tapped: ['left', 'right'], held: ['left'] })).toBe('');
    expect(howYouPlayed({ tapped: [], held: [] })).toBe('');
  });

  it('reaches the tester with the question it could get wrong by forgetting', async () => {
    await withRoot(async (root) => {
      const { game } = recordingGame();
      const driver = new FakeDriver(['HOLD: right', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 4, openGame: async () => game as never });
      // The plan question is the fourth thing asked of it after the briefing.
      const plan = driver.asked.find((text) => /worth changing/i.test(text));
      expect(plan).toMatch(/You held right down and never once tapped it/);
    });
  });

  it('leaves the question alone when there is nothing to say about how it played', async () => {
    await withRoot(async (root) => {
      const { game } = recordingGame();
      const driver = new FakeDriver(['TAP: right', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 4, openGame: async () => game as never });
      const plan = driver.asked.find((text) => /worth changing/i.test(text));
      expect(plan).not.toMatch(/never once tapped/);
    });
  });
});
