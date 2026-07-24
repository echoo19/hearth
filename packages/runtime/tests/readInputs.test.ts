/**
 * GameSession.readInputs — passive dead-control tracking. Records every
 * action/axis name a script reads via ctx.input.isDown/justPressed/axis, so
 * a later consumer can diff this set against inputMappings to find declared
 * actions/axes no script ever queries. Pointer reads are deliberately not
 * tracked (pointer has no "declared name" to go dead).
 */
import { describe, it, expect } from 'vitest';
import { GameSession } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

describe('GameSession.readInputs', () => {
  it('records an action read via ctx.input.isDown, and omits an unread declared action', async () => {
    const { store } = await makeStore({
      entities: [ent('Player', { Transform: {}, Script: { scriptPath: 'scripts/player.js' } })],
      scripts: {
        'player.js': `export default {
          onUpdate(ctx) { ctx.input.isDown('jump'); },
        };`,
      },
      actions: { jump: ['Space'], unused: ['KeyU'] },
    });
    const session = await GameSession.create(store);
    await session.stepAsync();

    expect(session.readInputs.has('jump')).toBe(true);
    expect(session.readInputs.has('unused')).toBe(false);
    session.destroy();
  });

  it('records an action read via ctx.input.justPressed', async () => {
    const { store } = await makeStore({
      entities: [ent('Player', { Transform: {}, Script: { scriptPath: 'scripts/player.js' } })],
      scripts: {
        'player.js': `export default {
          onUpdate(ctx) { ctx.input.justPressed('fire'); },
        };`,
      },
      actions: { fire: ['KeyF'] },
    });
    const session = await GameSession.create(store);
    await session.stepAsync();

    expect(session.readInputs.has('fire')).toBe(true);
    session.destroy();
  });

  it('records an axis name read via ctx.input.axis', async () => {
    const { store } = await makeStore({
      entities: [ent('Player', { Transform: {}, Script: { scriptPath: 'scripts/player.js' } })],
      scripts: {
        'player.js': `export default {
          onUpdate(ctx) { ctx.input.axis('move'); },
        };`,
      },
    });
    const session = await GameSession.create(store);
    await session.stepAsync();

    expect(session.readInputs.has('move')).toBe(true);
    session.destroy();
  });

  it('does not track pointer reads', async () => {
    const { store } = await makeStore({
      entities: [ent('Player', { Transform: {}, Script: { scriptPath: 'scripts/player.js' } })],
      scripts: {
        'player.js': `export default {
          onUpdate(ctx) {
            ctx.input.pointer();
            ctx.input.pointerScreen();
            ctx.input.pointerDown();
            ctx.input.pointerPressed();
          },
        };`,
      },
    });
    const session = await GameSession.create(store);
    await session.stepAsync();

    expect(session.readInputs.size).toBe(0);
    session.destroy();
  });

  it('aggregates reads from both scenes across a ctx.scenes.load switch', async () => {
    const { store } = await makeStore({
      entities: [ent('Menu', { Transform: {}, Script: { scriptPath: 'scripts/menu.js' } })],
      scripts: {
        'menu.js': `export default {
          onUpdate(ctx) {
            ctx.input.isDown('a');
            if (ctx.time.frame === 2) ctx.scenes.load('Level');
          },
        };`,
        'hero.js': `export default {
          onUpdate(ctx) { ctx.input.isDown('b'); },
        };`,
      },
      extraScenes: [
        {
          id: 'scn_level',
          name: 'Level',
          entities: [ent('Hero', { Transform: {}, Script: { scriptPath: 'scripts/hero.js' } })],
        },
      ],
    });
    const session = await GameSession.create(store);
    for (let i = 0; i < 5; i++) await session.stepAsync();

    expect(session.currentSceneId).toBe('scn_level');
    expect(session.readInputs.has('a')).toBe(true);
    expect(session.readInputs.has('b')).toBe(true);
    session.destroy();
  });
});
