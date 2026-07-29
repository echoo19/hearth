/**
 * The tester pressing a key the game never declared, and being told when it
 * could not.
 *
 * The failure these pin down happened for real. A game printed "R to restart"
 * on its own screen, the tester read it and asked for R, the loop found no
 * declared action called R and dropped the press without a word. The tester
 * then reported the game as stuck, which was a claim about somebody's game
 * that nothing in the session supported.
 *
 * So two rules are tested here and neither is cosmetic:
 *
 *  1. A name that is already a key reaches the real keyboard. Hearth does not
 *     decide which inputs a game is allowed to have.
 *  2. Anything that does NOT reach the game is said out loud on the tester's
 *     next turn. "I pressed it and nothing happened" and "my press was thrown
 *     away" must never look the same from inside the loop.
 */
import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keyForInputName, runTesterSession } from '../server/tester/session';
import { playPrompt } from '../server/tester/prompt';
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
    const reply = this.replies.shift() ?? 'DONE';
    this.queue.push({ type: 'message-delta', text: reply });
    this.queue.push({ type: 'turn-complete' });
  }
  stop(): void {
    this.queue.close();
  }
}

/** A game with a keyboard, or without one, and a record of what it received. */
function fakeGame(opts: { keyboard: boolean; pointer?: boolean } = { keyboard: true }) {
  const keysDown: string[] = [];
  const keysUp: string[] = [];
  const held: string[] = [];
  const game: Record<string, unknown> = {
    capabilities: {
      input: { actions: ['left', 'right', 'jump'], axes: [], pointer: opts.pointer ?? true },
    },
    start: async () => {},
    stop: async () => {},
    step: async () => ({}),
    setActionDown: async (name: string) => {
      held.push(name);
    },
    setActionUp: async () => {},
    setAxis: async () => {},
    sendPointer: async () => {},
    screenshot: async () => new Uint8Array([1, 2, 3]),
  };
  if (opts.keyboard) {
    game.setKeyDown = async (key: string) => {
      keysDown.push(key);
    };
    game.setKeyUp = async (key: string) => {
      keysUp.push(key);
    };
  }
  return { game, seen: () => ({ keysDown, keysUp, held }) };
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'keys-'));
  try {
    return await fn(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const REFLECTION = [
  'SAW 1: the game said R restarts it',
  'CHANGE: nothing\nVERDICT: no-difference\nWHY: I could not tell\nWORSE: nothing',
  '# What I know\n\nR restarts.',
];

describe('keyForInputName', () => {
  it('reads a single character as that character key, case folded', () => {
    // `r` and `R` are one physical key, and only one of the two is its name.
    expect(keyForInputName('R')).toBe('R');
    expect(keyForInputName('r')).toBe('R');
    expect(keyForInputName('5')).toBe('5');
    expect(keyForInputName('/')).toBe('/');
  });

  it('reads a key that has a written name, however it was spelled', () => {
    expect(keyForInputName('Space')).toBe('Space');
    expect(keyForInputName('spacebar')).toBe('Space');
    expect(keyForInputName('esc')).toBe('Escape');
    expect(keyForInputName('arrow left')).toBe('ArrowLeft');
    expect(keyForInputName('left-arrow')).toBe('ArrowLeft');
    expect(keyForInputName('Page_Up')).toBe('PageUp');
    expect(keyForInputName('f5')).toBe('F5');
  });

  it('refuses a word for an idea, because there is no key for an idea', () => {
    // This is the whole rule. Sending `jump` would mean picking a key for it,
    // and jump is Space in one game, Z in another and nothing at all in a game
    // with no jumping. A table like that would be Hearth deciding what kind of
    // game the person is allowed to have written.
    expect(keyForInputName('jump')).toBeNull();
    expect(keyForInputName('restart')).toBeNull();
    expect(keyForInputName('fire')).toBeNull();
    expect(keyForInputName('pause')).toBeNull();
    expect(keyForInputName('')).toBeNull();
  });
});

describe('playPrompt', () => {
  const controls = { actions: ['left'], axes: [], pointer: false };

  it('tells the tester to read the game’s own screen when a key can be sent', () => {
    const text = playPrompt(1, 6, { ...controls, keys: true });
    expect(text).toMatch(/tell you their own controls on screen/i);
  });

  it('promises nothing of the sort when no key can be sent', () => {
    // An offer the loop cannot honour is worse than no offer: the tester
    // spends turns on presses that go nowhere.
    expect(playPrompt(1, 6, { ...controls, keys: false })).not.toMatch(/own controls on screen/i);
  });

  it('says what did not arrive, and that it was not the game ignoring it', () => {
    const text = playPrompt(2, 6, { ...controls, keys: true }, [], ['"jump" never reached the game.']);
    expect(text).toContain('"jump" never reached the game.');
    expect(text).toMatch(/not the game failing to respond/i);
  });
});

describe('what the tester is still holding down', () => {
  it('lets an axis go, the way it lets an action and a key go', async () => {
    // The bug: there is no setAxisUp, so an axis driven to 1 stayed at 1
    // forever. The tester asked to go right once and the game went on going
    // right through every turn after it, including the turns where the tester
    // asked for nothing at all. Every observation from there on was of a game
    // being driven by a request the tester had already stopped making, and it
    // had no way to know that.
    await withRoot(async (root) => {
      const axis: { name: string; value: number }[] = [];
      const { game } = fakeGame({ keyboard: true });
      (game as Record<string, unknown>).capabilities = {
        input: { actions: ['jump'], axes: ['right'], pointer: true },
      };
      (game as Record<string, unknown>).setAxis = async (name: string, value: number) => {
        axis.push({ name, value });
      };

      const driver = new FakeDriver(['ACTION: right', 'ACTION: jump', 'DONE', ...REFLECTION]);
      await runTesterSession({
        root,
        dir: root,
        driver,
        maxSteps: 4,
        openGame: async () => game as never,
      });

      // Driven on the turn it was asked for, and zeroed on the next one, when
      // the tester asked for something else entirely.
      expect(axis[0]).toEqual({ name: 'right', value: 1 });
      expect(axis.some((call) => call.name === 'right' && call.value === 0)).toBe(true);
      // And nothing is left driven when the session ends.
      expect(axis[axis.length - 1]).toEqual({ name: 'right', value: 0 });
    });
  });
});

describe('runTesterSession and the picture count', () => {
  it('numbers the prompt by the picture, and does not count a turn that took none', async () => {
    // A screenshot that fails costs the turn its picture. The prompt used to
    // keep counting turns, so from there on the tester was told a number one
    // ahead of the file attached to it, and its citations were then checked
    // against the real count and thrown away.
    await withRoot(async (root) => {
      let turn = 0;
      const { game } = fakeGame({ keyboard: true });
      (game as Record<string, unknown>).screenshot = async () => {
        turn += 1;
        if (turn === 2) throw new Error('the page went away');
        return new Uint8Array([1, 2, 3]);
      };
      const driver = new FakeDriver(['ACTION: left', 'ACTION: left', 'ACTION: left', 'DONE', ...REFLECTION]);
      const written = await runTesterSession({
        root,
        dir: root,
        driver,
        maxSteps: 6,
        openGame: async () => game as never,
      });
      expect(driver.asked[0]).toContain('Picture 1.');
      expect(driver.asked[1]).toMatch(/no picture this turn/i);
      expect(driver.asked[2]).toContain('Picture 2.');
      // Three turns took a picture, four turns were played.
      expect(written.frames).toBe(3);
    });
  });

  it('never counts a picture that failed to reach the folder', async () => {
    await withRoot(async (root) => {
      const { game } = fakeGame({ keyboard: true });
      const frames = path.join(root, '.hearth', 'tester', 'sessions', '0001', 'frames');
      const driver = new FakeDriver(['DONE', ...REFLECTION]);
      // The counter used to move before the write resolved, so a failed write
      // left `frames` counting a file that is not on disk, and every reader
      // treats that count as the number of pictures that exist.
      //
      // The write is made to fail by putting a FILE where the frames directory
      // goes, so writing inside it is not a directory on any platform. This
      // used to chmod the directory read-only, which does nothing on Windows:
      // Node's chmod there toggles a read-only attribute that does not stop a
      // write into a directory, so the write succeeded, the count was 1, and
      // the test passed on two platforms out of three.
      const written = await runTesterSession({
        root,
        dir: root,
        driver,
        maxSteps: 2,
        openGame: async () => {
          await fsp.mkdir(path.dirname(frames), { recursive: true });
          await fsp.writeFile(frames, 'not a directory');
          return game as never;
        },
      });
      expect(written.frames).toBe(0);
    });
  });
});

describe('runTesterSession and undeclared inputs', () => {
  it('presses a key the game never declared, and releases it next turn', async () => {
    await withRoot(async (root) => {
      const { game, seen } = fakeGame({ keyboard: true });
      const driver = new FakeDriver(['The screen says R restarts.\nACTION: R', 'ACTION: left', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 6, openGame: async () => game as never });
      expect(seen().keysDown).toEqual(['R']);
      // Held for one moment of play and let go, the same as a declared action.
      expect(seen().keysUp).toEqual(['R']);
      expect(seen().held).toEqual(['left']);
    });
  });

  it('tells the tester when a name was not a key and never arrived', async () => {
    await withRoot(async (root) => {
      const { game } = fakeGame({ keyboard: true });
      const driver = new FakeDriver(['ACTION: restart', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 6, openGame: async () => game as never });
      const second = driver.asked[1];
      expect(second).toMatch(/"restart" never reached the game/);
      expect(second).toMatch(/not the game failing to respond/i);
    });
  });

  it('tells the tester when the game has no keyboard at all', async () => {
    await withRoot(async (root) => {
      const { game, seen } = fakeGame({ keyboard: false });
      const driver = new FakeDriver(['ACTION: R', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 6, openGame: async () => game as never });
      expect(seen().keysDown).toEqual([]);
      expect(driver.asked[1]).toMatch(/never reached the game/);
    });
  });

  it('says a click went nowhere rather than letting it look ignored', async () => {
    await withRoot(async (root) => {
      const { game } = fakeGame({ keyboard: true, pointer: false });
      const driver = new FakeDriver(['CLICK: 10, 20', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 6, openGame: async () => game as never });
      expect(driver.asked[1]).toMatch(/never reached the game/);
    });
  });

  it('says nothing at all when everything the tester asked for arrived', async () => {
    // The notice must be rare enough to mean something. A turn that landed
    // gets a clean prompt.
    await withRoot(async (root) => {
      const { game } = fakeGame({ keyboard: true });
      const driver = new FakeDriver(['ACTION: left', 'DONE', ...REFLECTION]);
      await runTesterSession({ root, dir: root, driver, maxSteps: 6, openGame: async () => game as never });
      expect(driver.asked[1]).not.toMatch(/never reached the game/);
    });
  });
});
