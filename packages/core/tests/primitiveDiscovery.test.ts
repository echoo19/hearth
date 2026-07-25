/**
 * Discoverability of the gameplay primitives.
 *
 * The premise of these components is that an agent reaches for them instead of
 * hand-writing a controller, so the reference surface (`CTX_API`, which feeds
 * `hearth inspect api`, the editor's autocomplete, and hover docs) and the
 * addComponent suggestions are load-bearing, not decoration. This file gates
 * both: every new ctx member is documented with a Lua and a JS example, no Lua
 * example uses colon-call syntax, and adding a primitive tells the agent what
 * to do next AND when not to use it.
 */
import { describe, it, expect } from 'vitest';
import { CTX_API, MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

const NEW_MEMBERS = [
  'game.pause',
  'game.resume',
  'game.isPaused',
  'state.get',
  'state.set',
  'state.add',
  'state.reset',
  'health.get',
  'health.damage',
  'health.heal',
  'health.isInvulnerable',
  'respawn',
];

const byPath = new Map(CTX_API.map((entry) => [entry.path, entry]));

describe('CTX_API covers the game primitives', () => {
  for (const path of NEW_MEMBERS) {
    it(`documents ctx.${path} with both languages`, () => {
      const entry = byPath.get(path);
      expect(entry, `ctx.${path} is missing from CTX_API`).toBeTruthy();
      expect(entry!.kind).toBe('method');
      expect(entry!.description.length).toBeGreaterThan(20);
      expect(entry!.example?.lua).toContain(`ctx.${path.split('.')[0]}`);
      expect(entry!.example?.js).toContain(`ctx.${path.split('.')[0]}`);
    });
  }

  it('matches the runtime signatures for the members most likely to drift', () => {
    expect(byPath.get('state.set')!.signature).toBe(
      'set(key: string, value: number | boolean | string): void',
    );
    expect(byPath.get('state.get')!.signature).toBe(
      'get(key: string): number | boolean | string | null',
    );
    expect(byPath.get('respawn')!.signature).toBe('respawn(idOrHandle: string | EntityHandle): void');
    expect(byPath.get('health.damage')!.signature).toBe(
      'damage(idOrHandle: string | EntityHandle, amount: number): void',
    );
    expect(byPath.get('game.isPaused')!.signature).toBe('isPaused(): boolean');
  });

  it('names the events each primitive emits, so juice can hang off them', () => {
    expect(byPath.get('health.damage')!.description).toContain('damaged');
    expect(byPath.get('health.damage')!.description).toContain('died');
    expect(byPath.get('state.set')!.description).toContain('stateChanged');
    expect(byPath.get('respawn')!.description).toContain('respawned');
  });

  it('explains what pause does and does not freeze', () => {
    const pause = byPath.get('game.pause')!.description;
    expect(pause).toContain('runWhilePaused');
    expect(pause).toMatch(/physics/i);
  });

  // Lua calls ctx with a dot: a colon passes ctx as a hidden first argument and
  // breaks the call. An example that gets this wrong teaches the bug.
  it('has no colon-call Lua examples anywhere in the reference', () => {
    const offenders = CTX_API.filter((entry) => /\bctx:[A-Za-z]/.test(entry.example?.lua ?? ''));
    expect(offenders.map((e) => e.path)).toEqual([]);
  });

  it('has no duplicate paths', () => {
    expect(byPath.size).toBe(CTX_API.length);
  });
});

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  const session = HearthSession.fromStore(store, {});
  return { session, store, scene: store.project.initialScene as string };
}

describe('addComponent teaches the primitive it just added', () => {
  const cases: { type: string; mustMention: string[]; skipHint: RegExp }[] = [
    {
      type: 'CharacterController',
      mustMention: ['PhysicsBody', 'onUpdate'],
      skipHint: /skip/i,
    },
    { type: 'Health', mustMention: ['damaged', 'died', 'event-only'], skipHint: /skip/i },
    { type: 'Respawn', mustMention: ['Checkpoint', 'ctx.respawn'], skipHint: /not for/i },
    { type: 'Checkpoint', mustMention: ['isTrigger', 'Respawn'], skipHint: /skip/i },
  ];

  for (const { type, mustMention, skipHint } of cases) {
    it(`${type}: suggests the next step and when not to use it`, async () => {
      const { session, scene } = await makeSession();
      const res = await session.execute('addComponent', { scene, entity: 'Player', type });
      expect(res.success).toBe(true);
      const text = res.suggestions.join('\n');
      for (const needle of mustMention) expect(text).toContain(needle);
      expect(text, `${type} suggestion never says when to skip it`).toMatch(skipHint);
    });
  }

  it('says nothing extra for a component that is not a primitive', async () => {
    const { session, scene } = await makeSession();
    const res = await session.execute('addComponent', { scene, entity: 'Player', type: 'SpriteEffects' });
    expect(res.success).toBe(true);
    expect(res.suggestions).toEqual([]);
  });

  it('Text with a binding: points at gameState and warns off writing content', async () => {
    const { session, scene } = await makeSession();
    const res = await session.execute('addComponent', {
      scene,
      entity: 'Player',
      type: 'Text',
      properties: { binding: { key: 'score' } },
    });
    expect(res.success).toBe(true);
    const text = res.suggestions.join('\n');
    expect(text).toContain('gameState');
    expect(text).toContain('Text.content');
  });

  it('a plain Text gets no binding guidance', async () => {
    const { session, scene } = await makeSession();
    const res = await session.execute('addComponent', {
      scene,
      entity: 'Player',
      type: 'Text',
      properties: { content: 'Hello' },
    });
    expect(res.success).toBe(true);
    expect(res.suggestions).toEqual([]);
  });

  it('binding an existing Text through setComponentProperty gets the same guidance', async () => {
    const { session, scene } = await makeSession();
    await session.execute('addComponent', { scene, entity: 'Player', type: 'Text' });
    const res = await session.execute('setComponentProperty', {
      scene,
      entity: 'Player',
      property: 'Text.binding',
      value: { key: 'score' },
    });
    expect(res.success).toBe(true);
    expect(res.suggestions.join('\n')).toContain('gameState');
  });
});
