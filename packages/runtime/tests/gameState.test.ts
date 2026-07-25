/**
 * GameStateStore unit tests: declared keys start at their initial value,
 * writes are type-checked against the declaration, only `persist` keys touch
 * storage, and every real change notifies exactly once.
 *
 * Plus (further down) the integration side: Text.binding rendering through
 * SceneRuntime, the `stateChanged` event reaching scripts, and `persist`
 * round-tripping across two GameSessions that share one storage.
 */
import { describe, expect, it, vi } from 'vitest';
import { GameSession, MemorySessionStorage, SceneRuntime } from '@hearth/runtime';
import { GameStateStore } from '../src/gameState.js';
import { ent, makeStore } from './helpers.js';

const decls = {
  score: { type: 'number' as const, initial: 0, persist: false },
  best: { type: 'number' as const, initial: 0, persist: true },
  alive: { type: 'boolean' as const, initial: true, persist: false },
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => void map.set(k, v),
    remove: (k: string) => void map.delete(k),
    keys: () => [...map.keys()],
    raw: map,
  };
}

describe('GameStateStore', () => {
  it('starts every declared key at its initial value', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(store.get('score')).toBe(0);
    expect(store.get('alive')).toBe(true);
  });

  it('reports declared keys through has and keys', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(store.has('score')).toBe(true);
    expect(store.has('nope')).toBe(false);
    expect(store.keys().sort()).toEqual(['alive', 'best', 'score']);
  });

  it('adds to numbers and notifies on change', () => {
    const onChange = vi.fn();
    const store = new GameStateStore(decls, memoryStorage(), onChange);
    store.add('score', 5);
    store.add('score', 3);
    expect(store.get('score')).toBe(8);
    expect(onChange).toHaveBeenLastCalledWith('score', 8, 5);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not notify when the value is unchanged', () => {
    const onChange = vi.fn();
    const store = new GameStateStore(decls, memoryStorage(), onChange);
    store.set('score', 0);
    store.add('score', 0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses a value of the wrong type and leaves the old value in place', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(() => store.set('score', 'nope' as never)).toThrow(/number/);
    expect(store.get('score')).toBe(0);
  });

  it('refuses add on a non-number key', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(() => store.add('alive', 1)).toThrow(/number/);
    expect(store.get('alive')).toBe(true);
  });

  it('throws a declaration hint when writing an undeclared key', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(() => store.set('nope', 1)).toThrow(/gameState/);
    expect(() => store.add('nope', 1)).toThrow(/gameState/);
    expect(() => store.reset('nope')).toThrow(/gameState/);
  });

  it('returns null and does not throw for an undeclared key', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(store.get('nope')).toBeNull();
  });

  it('persists only keys marked persist, and reloads them', () => {
    const storage = memoryStorage();
    const first = new GameStateStore(decls, storage);
    first.set('best', 42);
    first.set('score', 7);

    const second = new GameStateStore(decls, storage);
    expect(second.get('best')).toBe(42);
    expect(second.get('score')).toBe(0);
  });

  it('falls back to the initial value when stored data is corrupt or mistyped', () => {
    const storage = memoryStorage();
    storage.raw.set('hearth:state:best', 'not json');
    expect(new GameStateStore(decls, storage).get('best')).toBe(0);

    storage.raw.set('hearth:state:best', '"forty-two"');
    expect(new GameStateStore(decls, storage).get('best')).toBe(0);
  });

  it('reset restores one key, or all keys when called with no argument', () => {
    const store = new GameStateStore(decls, memoryStorage());
    store.set('score', 9);
    store.set('alive', false);
    store.reset('score');
    expect(store.get('score')).toBe(0);
    expect(store.get('alive')).toBe(false);
    store.reset();
    expect(store.get('alive')).toBe(true);
  });

  it('reset writes the initial value back through storage for persisted keys', () => {
    const storage = memoryStorage();
    const store = new GameStateStore(decls, storage);
    store.set('best', 12);
    store.reset('best');
    expect(new GameStateStore(decls, storage).get('best')).toBe(0);
  });

  it('works with no declarations at all', () => {
    const store = new GameStateStore({}, memoryStorage());
    expect(store.keys()).toEqual([]);
    expect(store.get('score')).toBeNull();
    expect(() => store.reset()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: Text.binding, the stateChanged event, and cross-session persist.
// ---------------------------------------------------------------------------

type Decls = Record<
  string,
  { type: 'number' | 'boolean' | 'string'; initial: number | boolean | string; persist?: boolean }
>;

/** One 'Label' whose Text carries `binding`, over a project declaring `gameState`. */
async function makeBindingRuntime(
  binding: Record<string, unknown>,
  gameState: Decls,
  authored = 'AUTHORED',
): Promise<SceneRuntime> {
  const { store } = await makeStore({
    entities: [ent('Label', { Transform: {}, Text: { content: authored, binding } })],
    gameState,
  });
  return SceneRuntime.create(store, 'Test');
}

const labelOf = (rt: SceneRuntime) => rt.find('Label')!.components.Text!.content;

describe('Text.binding', () => {
  it('renders the value through the format string and follows later changes', async () => {
    const rt = await makeBindingRuntime(
      { key: 'score', format: 'Score: {value}' },
      { score: { type: 'number', initial: 0 } },
    );
    // Nothing has changed and no frame has run, so the authored content stands.
    expect(labelOf(rt)).toBe('AUTHORED');
    rt.run(1);
    expect(labelOf(rt)).toBe('Score: 0');

    rt.gameState.add('score', 25);
    rt.run(1);
    expect(labelOf(rt)).toBe('Score: 25');

    rt.gameState.reset('score');
    rt.run(1);
    expect(labelOf(rt)).toBe('Score: 0');
  });

  it('refreshes the label synchronously on a state write, not one frame later', async () => {
    const rt = await makeBindingRuntime(
      { key: 'score', format: 'Score: {value}' },
      { score: { type: 'number', initial: 0 } },
    );
    rt.run(1);
    rt.gameState.set('score', 3);
    // No step() in between: anything reading Text.content straight after a
    // ctx.state write (a UI click handler, a playtest assertion) must not see
    // the previous frame's value.
    expect(labelOf(rt)).toBe('Score: 3');
  });

  it('sees a same-frame ctx.state.add from a script', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Label', { Transform: {}, Text: { content: 'x', binding: { key: 'score', format: '{value}' } } }),
        ent('Scorer', { Transform: {}, Script: { scriptPath: 'scripts/score.lua' } }),
      ],
      scripts: {
        'score.lua': ['return {', '  onUpdate = function(ctx)', "    ctx.state.add('score', 1)", '  end,', '}'].join('\n'),
      },
      gameState: { score: { type: 'number', initial: 0 } },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    // Phase 4d runs after scripts, so frame 0's own increment is already shown.
    expect(labelOf(rt)).toBe('1');
    rt.run(4);
    expect(labelOf(rt)).toBe('5');
    expect(rt.errors).toEqual([]);
  });

  it('formats fractional numbers to `precision` decimals', async () => {
    const rt = await makeBindingRuntime(
      { key: 'timeLeft', format: '{value}s', precision: 2 },
      { timeLeft: { type: 'number', initial: 12.3456 } },
    );
    rt.run(1);
    expect(labelOf(rt)).toBe('12.35s');

    rt.gameState.set('timeLeft', 3);
    rt.run(1);
    // A whole number is still padded to the declared precision.
    expect(labelOf(rt)).toBe('3.00s');
  });

  it('rounds to whole numbers at the default precision of 0', async () => {
    const rt = await makeBindingRuntime(
      { key: 'timeLeft', format: '{value}' },
      { timeLeft: { type: 'number', initial: 12.6 } },
    );
    rt.run(1);
    expect(labelOf(rt)).toBe('13');
  });

  it('renders booleans without applying precision', async () => {
    const rt = await makeBindingRuntime(
      { key: 'alive', format: 'alive={value}', precision: 3 },
      { alive: { type: 'boolean', initial: true } },
    );
    rt.run(1);
    expect(labelOf(rt)).toBe('alive=true');
    rt.gameState.set('alive', false);
    rt.run(1);
    expect(labelOf(rt)).toBe('alive=false');
  });

  it('renders strings without applying precision', async () => {
    const rt = await makeBindingRuntime(
      { key: 'playerName', format: 'Hi {value}!', precision: 2 },
      { playerName: { type: 'string', initial: 'Bo' } },
    );
    rt.run(1);
    expect(labelOf(rt)).toBe('Hi Bo!');
    rt.gameState.set('playerName', 'Ada');
    rt.run(1);
    expect(labelOf(rt)).toBe('Hi Ada!');
  });

  it('leaves content untouched for an undeclared key rather than blanking it', async () => {
    const rt = await makeBindingRuntime(
      { key: 'typo', format: 'Score: {value}' },
      { score: { type: 'number', initial: 7 } },
      'Score: --',
    );
    rt.run(10);
    // A key typo must not silently erase a label; the authored text survives.
    expect(labelOf(rt)).toBe('Score: --');
    expect(rt.errors).toEqual([]);
  });

  it('leaves a Text with no binding entirely script-owned', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Label', { Transform: {}, Text: { content: 'mine', binding: null } }),
      ],
      gameState: { score: { type: 'number', initial: 3 } },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(3);
    expect(labelOf(rt)).toBe('mine');
  });

  it('keeps updating while the game is PAUSED', async () => {
    const rt = await makeBindingRuntime(
      { key: 'score', format: 'Score: {value}' },
      { score: { type: 'number', initial: 0 } },
    );
    rt.run(1);
    expect(labelOf(rt)).toBe('Score: 0');

    rt.paused = true;
    rt.gameState.set('score', 99);
    expect(labelOf(rt)).toBe('Score: 99'); // synchronous change hook

    // Now prove the once-per-frame pass (step phase 4d) also runs while
    // paused, independently of the change hook: stomp the content by hand and
    // let a frozen frame put it back. A pause menu showing the score has to
    // show the right one.
    rt.find('Label')!.components.Text!.content = 'STOMPED';
    rt.run(1);
    expect(labelOf(rt)).toBe('Score: 99');
    expect(rt.paused).toBe(true);
  });

  it('stops updating a disabled label', async () => {
    const rt = await makeBindingRuntime(
      { key: 'score', format: '{value}' },
      { score: { type: 'number', initial: 0 } },
    );
    rt.run(1);
    rt.find('Label')!.enabled = false;
    rt.gameState.set('score', 5);
    rt.run(1);
    expect(labelOf(rt)).toBe('0');
    rt.find('Label')!.enabled = true;
    rt.run(1);
    expect(labelOf(rt)).toBe('5');
  });
});

describe('stateChanged event', () => {
  it('fires with {key, value, previous} and reaches a script onEvent', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Watcher', { Transform: {}, Script: { scriptPath: 'scripts/watch.js' } }),
        ent('Scorer', { Transform: {}, Script: { scriptPath: 'scripts/score.js' } }),
      ],
      scripts: {
        'watch.js': `export default {
          onEvent(ctx, name, data) {
            if (name === 'stateChanged') {
              ctx.log(name + ' ' + data.key + ' ' + data.previous + '->' + data.value);
            }
          },
        };`,
        'score.js': `export default {
          onUpdate(ctx) { if (ctx.time.frame === 1) ctx.state.add('score', 10); },
        };`,
      },
      gameState: { score: { type: 'number', initial: 0 } },
    });
    const session = await GameSession.create(store);
    for (let i = 0; i < 3; i++) await session.stepAsync();

    expect(session.logs.map((l) => l.message)).toEqual(['stateChanged score 0->10']);
    expect(session.events.filter((e) => e.name === 'stateChanged').map((e) => e.data)).toEqual([
      { key: 'score', value: 10, previous: 0 },
    ]);
    expect(session.errors).toEqual([]);
    session.destroy();
  });

  it('does not fire for a no-op write', async () => {
    const { store } = await makeStore({
      entities: [ent('Scorer', { Transform: {}, Script: { scriptPath: 'scripts/score.js' } })],
      scripts: {
        'score.js': `export default {
          onUpdate(ctx) { if (ctx.time.frame === 1) { ctx.state.set('score', 0); ctx.state.add('score', 0); } },
        };`,
      },
      gameState: { score: { type: 'number', initial: 0 } },
    });
    const session = await GameSession.create(store);
    for (let i = 0; i < 3; i++) await session.stepAsync();
    expect(session.eventCounts.get('stateChanged')).toBeUndefined();
    session.destroy();
  });

  it('is emitted by a standalone SceneRuntime too, not only under a GameSession', async () => {
    const rt = await makeBindingRuntime(
      { key: 'score', format: '{value}' },
      { score: { type: 'number', initial: 0 } },
    );
    rt.run(1);
    rt.gameState.set('score', 4);
    // A standalone runtime (editor scene preview) builds its own store and
    // wires the same change hook, so scripts see stateChanged either way.
    expect(rt.eventCounts.get('stateChanged')).toBe(1);
    expect(rt.events.filter((e) => e.name === 'stateChanged').map((e) => e.data)).toEqual([
      { key: 'score', value: 4, previous: 0 },
    ]);
  });
});

describe('game state across GameSessions', () => {
  /** Project with a persisted `best` and a volatile `score`, plus a label bound to `best`. */
  async function makePersistStore() {
    const { store } = await makeStore({
      entities: [
        ent('Label', { Transform: {}, Text: { content: 'x', binding: { key: 'best', format: 'Best: {value}' } } }),
      ],
      gameState: {
        best: { type: 'number', initial: 0, persist: true },
        score: { type: 'number', initial: 0, persist: false },
      },
    });
    return store;
  }

  it('persist: true survives a new session over the same storage; persist: false resets', async () => {
    const store = await makePersistStore();
    const storage = new MemorySessionStorage();

    const first = await GameSession.create(store, { storage });
    first.runtime.gameState.set('best', 42);
    first.runtime.gameState.set('score', 7);
    await first.stepAsync();
    expect(first.runtime.find('Label')!.components.Text!.content).toBe('Best: 42');
    first.destroy();

    const second = await GameSession.create(store, { storage });
    expect(second.runtime.gameState.get('best')).toBe(42);
    expect(second.runtime.gameState.get('score')).toBe(0);
    await second.stepAsync();
    // The reloaded value renders through the binding in the fresh session.
    expect(second.runtime.find('Label')!.components.Text!.content).toBe('Best: 42');
    second.destroy();
  });

  it('a fresh storage starts back at the declared initial value', async () => {
    const store = await makePersistStore();
    const first = await GameSession.create(store, { storage: new MemorySessionStorage() });
    first.runtime.gameState.set('best', 42);
    first.destroy();

    const second = await GameSession.create(store, { storage: new MemorySessionStorage() });
    expect(second.runtime.gameState.get('best')).toBe(0);
    second.destroy();
  });

  it('keeps values across a scene switch inside one session', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Menu', { Transform: {}, Script: { scriptPath: 'scripts/menu.js' } }),
      ],
      scripts: {
        'menu.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 0) ctx.state.set('score', 13);
            if (ctx.time.frame === 2) ctx.scenes.load('Level');
          },
        };`,
      },
      gameState: { score: { type: 'number', initial: 0 } },
      extraScenes: [
        {
          id: 'scn_level',
          name: 'Level',
          entities: [
            ent('Label', { Transform: {}, Text: { content: 'x', binding: { key: 'score', format: '{value}' } } }),
          ],
        },
      ],
    });
    const session = await GameSession.create(store);
    for (let i = 0; i < 6; i++) await session.stepAsync();
    expect(session.currentSceneId).toBe('scn_level');
    // One store per session, so the new scene's label shows the carried value.
    expect(session.runtime.find('Label')!.components.Text!.content).toBe('13');
    session.destroy();
  });
});
