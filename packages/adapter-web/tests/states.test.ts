/**
 * The state capability, through a real page.
 *
 * The fixture is a bureau sim whose states are a year, a deficit and an audit
 * week. Nothing in the adapter knows what any of that means, and a test that
 * only ever ran against a list of levels could not tell you that.
 */
import { describe, it, expect } from 'vitest';
import { canLaunchChromium } from '../src/index.js';
import { STATES_DIR, openFixture } from './support.js';

const hasChromium = await canLaunchChromium();

describe('states a game says it can be put into', () => {
  it.skipIf(!hasChromium)(
    'carries the game its own names back, unchanged, and enters one',
    async () => {
      const { game, close } = await openFixture(STATES_DIR);
      try {
        expect(game.capabilities.senses.states).toBe(true);
        const states = await game.listStates!();
        expect(states.map((state) => state.id)).toEqual(['y1-spring', 'y3-deficit', 'audit']);
        expect(states[1].label).toBe('Year three, already in deficit');
        expect(states[1].detail).toBe('two departments unstaffed');

        await game.enterState!('audit');
        expect((await game.step()).sceneId).toBe('audit');
      } finally {
        await close();
      }
    },
    60000,
  );

  it.skipIf(!hasChromium)(
    'says so plainly when a game declares neither hook',
    async () => {
      const { game, close } = await openFixture(STATES_DIR, { variant: 'no-states' });
      try {
        // A shim is present and other senses are on. Only this one is absent,
        // and absent is a first-class answer.
        expect(game.shimDetected).toBe(true);
        expect(game.capabilities.senses.states).toBe(false);
        expect(game.listStates).toBeUndefined();
        expect(game.enterState).toBeUndefined();
      } finally {
        await close();
      }
    },
    60000,
  );

  it.skipIf(!hasChromium)(
    'treats a list it cannot act on as no capability at all',
    async () => {
      const { game, close } = await openFixture(STATES_DIR, { variant: 'list-only' });
      try {
        expect(game.capabilities.senses.states).toBe(false);
        expect(game.listStates).toBeUndefined();
        expect(game.enterState).toBeUndefined();
      } finally {
        await close();
      }
    },
    60000,
  );
});
