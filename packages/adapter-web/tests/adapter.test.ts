/**
 * Real-Chromium tests for the adapter. Gated behind canLaunchChromium() the
 * same way @hearth/playtest's screenshot suite is, so the package still
 * passes on a machine with no browser.
 *
 * Timeouts are set per test: the root vitest timeout is 30s and a scripted
 * run of a few hundred steps plus a browser launch can exceed it.
 */
import { describe, it, expect } from 'vitest';
import type { ProbeError } from '@hearth/probe-core';
import { canLaunchChromium, openWebGame } from '../src/index.js';
import {
  BLANK_DIR,
  RUNNER_DIR,
  bytesEqual,
  openFixture,
  playerPos,
  readPngHeader,
} from './support.js';

const hasChromium = await canLaunchChromium();

describe('opening a game', () => {
  it.skipIf(!hasChromium)(
    'serves a directory on loopback and plays it with no other setup',
    async () => {
      const game = await openWebGame({ dir: RUNNER_DIR, stepMs: 16 });
      try {
        expect(game.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        await game.start();
        expect(game.shimDetected).toBe(true);
        expect((await game.step()).sceneId).toBe('level1');
        expect((await game.listEntities!()).length).toBe(2);
      } finally {
        // stop() closes the browser and the server it started.
        await game.stop();
      }
      await expect(fetch(game.url)).rejects.toBeTruthy();
    },
    60000,
  );
});

describe('capability honesty', () => {
  it.skipIf(!hasChromium)(
    'declares only what a page with no cooperation can give (blank fixture)',
    async () => {
      const { game, close } = await openFixture(BLANK_DIR);
      try {
        expect(game.shimDetected).toBe(false);
        expect(game.capabilities.senses).toEqual({
          errors: true,
          screenshot: true,
          reset: true,
          scenes: false,
          events: false,
          entities: false,
          nav: false,
          states: false,
        });
        expect(game.capabilities.viewport).toEqual({ width: 960, height: 540 });
        expect(game.capabilities.input.pointer).toBe(true);
        expect(game.capabilities.input.actions).toEqual([
          'action',
          'down',
          'jump',
          'left',
          'right',
          'up',
        ]);
        expect(game.capabilities.input.axes).toEqual([]);

        // Methods exist exactly when the capability is declared.
        expect(game.listEntities).toBeUndefined();
        expect(game.findEntity).toBeUndefined();
        expect(game.navGrid).toBeUndefined();
        expect(typeof game.screenshot).toBe('function');
        expect(typeof game.reset).toBe('function');

        const obs = await game.step();
        expect(obs.frame).toBe(1);
        expect(obs.sceneId).toBeNull();
        expect(obs.newEvents).toEqual([]);
        expect(obs.newErrors).toEqual([]);
      } finally {
        await close();
      }
    },
    60000,
  );

  it.skipIf(!hasChromium)(
    'upgrades senses when the page ships the shim (runner fixture)',
    async () => {
      const { game, close } = await openFixture(RUNNER_DIR);
      try {
        expect(game.shimDetected).toBe(true);
        expect(game.capabilities.senses).toEqual({
          errors: true,
          screenshot: true,
          reset: true,
          scenes: true,
          events: true,
          entities: true,
          // The runner exposes no nav grid, so nav stays off even with a shim.
          nav: false,
          states: false,
        });
        // The shim narrows the input vocabulary to what the game understands.
        expect(game.capabilities.input.actions).toEqual(['jump', 'left', 'right']);
        expect(typeof game.listEntities).toBe('function');
        expect(typeof game.findEntity).toBe('function');
        expect(game.navGrid).toBeUndefined();

        const entities = await game.listEntities!();
        expect(entities.map((e) => e.id).sort()).toEqual(['goal', 'player']);
        expect(await game.findEntity!('player')).toMatchObject({ id: 'player', alive: true });
        expect(await game.findEntity!('objective')).toMatchObject({ id: 'goal' });
        expect(await game.findEntity!('nothing-here')).toBeNull();

        const obs = await game.step();
        expect(obs.sceneId).toBe('level1');
      } finally {
        await close();
      }
    },
    60000,
  );
});

describe('input injection', () => {
  it.skipIf(!hasChromium)(
    'moves the player while an action is held, and stops when it is released',
    async () => {
      const { game, close } = await openFixture(RUNNER_DIR);
      try {
        const start = await playerPos(game);

        await game.setActionDown('right');
        for (let i = 0; i < 20; i++) await game.step();
        const moved = await playerPos(game);
        expect(moved.x).toBeGreaterThan(start.x + 20);

        await game.setActionUp('right');
        await game.step();
        const settled = await playerPos(game);
        for (let i = 0; i < 5; i++) await game.step();
        const still = await playerPos(game);
        expect(Math.abs(still.x - settled.x)).toBeLessThan(2);
      } finally {
        await close();
      }
    },
    60000,
  );

  it.skipIf(!hasChromium)(
    'reports the jump event only when the jump action is actually pressed',
    async () => {
      const { game, close } = await openFixture(RUNNER_DIR);
      try {
        const quiet = await game.step();
        expect(quiet.newEvents).toEqual([]);

        await game.setActionDown('jump');
        const pressed = await game.step();
        await game.setActionUp('jump');
        const after = await game.step();
        expect([...pressed.newEvents, ...after.newEvents]).toContain('jump');
      } finally {
        await close();
      }
    },
    60000,
  );

  it.skipIf(!hasChromium)(
    'accepts pointer input on a page that ignores it, without throwing',
    async () => {
      const { game, close } = await openFixture(BLANK_DIR);
      try {
        await game.sendPointer(100, 100, 'move');
        await game.sendPointer(100, 100, 'down');
        await game.sendPointer(140, 120, 'move');
        await game.sendPointer(140, 120, 'up');
        await game.sendPointer(200, 200, 'click');
        const obs = await game.step();
        expect(obs.newErrors).toEqual([]);
      } finally {
        await close();
      }
    },
    60000,
  );
});

describe('error capture', () => {
  it.skipIf(!hasChromium)(
    'surfaces an uncaught TypeError through step(), with a source location',
    async () => {
      const { game, close } = await openFixture(RUNNER_DIR, { variant: 'crash' });
      try {
        await game.setActionDown('right');
        const errors: ProbeError[] = [];
        for (let i = 0; i < 150 && errors.length === 0; i++) {
          errors.push(...(await game.step()).newErrors);
        }
        expect(errors.length).toBeGreaterThan(0);
        const first = errors[0]!;
        expect(first.message).toMatch(/null/i);
        expect(first.where).toMatch(/^game\.js:\d+$/);
        expect(first.at.frame).toBeGreaterThan(0);
        // One throw is reported once, not once per Chromium channel.
        expect(errors.length).toBeLessThanOrEqual(2);
      } finally {
        await close();
      }
    },
    120000,
  );

  it.skipIf(!hasChromium)(
    'stays silent on a healthy page',
    async () => {
      const { game, close } = await openFixture(RUNNER_DIR);
      try {
        await game.setActionDown('right');
        for (let i = 0; i < 20; i++) {
          expect((await game.step()).newErrors).toEqual([]);
        }
      } finally {
        await close();
      }
    },
    60000,
  );
});

describe('screenshot', () => {
  it.skipIf(!hasChromium)(
    'returns a decodable PNG that changes as the game state changes',
    async () => {
      const { game, close } = await openFixture(RUNNER_DIR);
      try {
        const before = await game.screenshot!();
        const header = readPngHeader(before);
        expect(header).toEqual({ width: 960, height: 540 });

        await game.setActionDown('right');
        for (let i = 0; i < 25; i++) await game.step();
        await game.setActionUp('right');

        const after = await game.screenshot!();
        expect(readPngHeader(after)).toEqual({ width: 960, height: 540 });
        expect(bytesEqual(before, after)).toBe(false);
      } finally {
        await close();
      }
    },
    60000,
  );
});

describe('reset', () => {
  it.skipIf(!hasChromium)(
    'returns the shimmed game to its initial state in place',
    async () => {
      const { game, close } = await openFixture(RUNNER_DIR);
      try {
        const start = await playerPos(game);
        await game.setActionDown('right');
        for (let i = 0; i < 20; i++) await game.step();
        await game.setActionUp('right');
        expect((await playerPos(game)).x).toBeGreaterThan(start.x + 20);

        await game.reset!();
        const afterReset = await playerPos(game);
        expect(Math.abs(afterReset.x - start.x)).toBeLessThan(2);
        // Held input is released across a reset.
        for (let i = 0; i < 5; i++) await game.step();
        expect(Math.abs((await playerPos(game)).x - start.x)).toBeLessThan(2);
      } finally {
        await close();
      }
    },
    60000,
  );

  it.skipIf(!hasChromium)(
    'falls back to a full page reload when the page offers no reset hook',
    async () => {
      const { game, close } = await openFixture(BLANK_DIR);
      try {
        await game.step();
        await game.reset!();
        const obs = await game.step();
        expect(obs.newErrors).toEqual([]);
        expect(game.capabilities.senses.reset).toBe(true);
        // The frame counter is the probe's monotonic sample counter: a reset
        // starts a new episode but does not rewind it.
        expect(obs.frame).toBe(2);
      } finally {
        await close();
      }
    },
    60000,
  );
});
