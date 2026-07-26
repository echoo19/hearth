/**
 * Browser-free tests for the adapter's pure parts: input-map interpretation,
 * error-location formatting, entity/nav normalization, and the shim copy the
 * runner fixture ships.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  actionNamesFrom,
  axisNamesFrom,
  formatLocation,
  isBrowserNoise,
  isDuplicateError,
  normalizeEntities,
  normalizeErrorMessage,
  normalizeNavGrid,
  resolveEntity,
  whereFromStack,
  DEFAULT_ACTION_KEYS,
  PROBE_SHIM_PATH,
} from '../src/index.js';
import { RUNNER_DIR } from './support.js';

describe('input map interpretation', () => {
  it('reads plain actions from the default map and finds no axes', () => {
    expect(actionNamesFrom({ ...DEFAULT_ACTION_KEYS })).toEqual([
      'action',
      'down',
      'jump',
      'left',
      'right',
      'up',
    ]);
    expect(axisNamesFrom({ ...DEFAULT_ACTION_KEYS })).toEqual([]);
  });

  it('recognizes an axis only when both halves are mapped', () => {
    expect(axisNamesFrom({ 'moveX+': 'KeyD', 'moveX-': 'KeyA' })).toEqual(['moveX']);
    expect(axisNamesFrom({ 'moveX+': 'KeyD' })).toEqual([]);
    expect(actionNamesFrom({ 'moveX+': 'KeyD', 'moveX-': 'KeyA', jump: 'Space' })).toEqual(['jump']);
  });
});

describe('error location', () => {
  it('reduces a URL and line to file:line', () => {
    expect(formatLocation('http://127.0.0.1:5051/js/player.js', 31)).toBe('player.js:31');
    expect(formatLocation('http://127.0.0.1:5051/game.js?v=2', 7)).toBe('game.js:7');
    expect(formatLocation('http://127.0.0.1:5051/game.js')).toBe('game.js');
    expect(formatLocation(undefined, 3)).toBeUndefined();
  });

  it('pulls the first real frame out of a stack', () => {
    const stack = [
      'TypeError: Cannot read properties of null',
      '    at update (http://127.0.0.1:5051/game.js:31:9)',
      '    at frame (http://127.0.0.1:5051/game.js:88:5)',
    ].join('\n');
    expect(whereFromStack(stack)).toBe('game.js:31');
    expect(whereFromStack(undefined)).toBeUndefined();
    expect(whereFromStack('TypeError: nope')).toBeUndefined();
  });

  it('collapses the pageerror/console pair Chromium reports for one throw', () => {
    const pageError = 'Cannot set properties of null (setting \'solid\')';
    const consoleError = 'Uncaught TypeError: Cannot set properties of null (setting \'solid\')';
    expect(normalizeErrorMessage(consoleError)).toBe(
      'TypeError: Cannot set properties of null (setting \'solid\')',
    );
    expect(isDuplicateError(pageError, consoleError)).toBe(true);
    expect(isDuplicateError(pageError, 'ReferenceError: goal is not defined')).toBe(false);
  });

  it('ignores the favicon 404 the browser invents for every page', () => {
    expect(isBrowserNoise('http://127.0.0.1:5051/favicon.ico')).toBe(true);
    expect(isBrowserNoise('http://127.0.0.1:5051/favicon.ico?v=2')).toBe(true);
    // A missing game asset is a real finding and must still be reported.
    expect(isBrowserNoise('http://127.0.0.1:5051/sprites/player.png')).toBe(false);
    expect(isBrowserNoise(undefined)).toBe(false);
  });
});

describe('entity normalization and lookup', () => {
  it('drops junk, defaults liveness, and keeps names and tags', () => {
    const entities = normalizeEntities([
      { id: 'player', name: 'player', tags: ['player', 7], x: 10, y: 20 },
      { id: 'ghost', x: 'nope', y: 3 },
      null,
      { name: 'goal', x: 700, y: 370, alive: false },
    ]);
    expect(entities).toEqual([
      { id: 'player', name: 'player', tags: ['player'], x: 10, y: 20, alive: true },
      { id: 'goal', name: 'goal', x: 700, y: 370, alive: false },
    ]);
    expect(normalizeEntities('not an array')).toEqual([]);
  });

  it('resolves a ref by id, then exact name, then tag', () => {
    const entities = normalizeEntities([
      { id: 'e1', name: 'goal', tags: ['objective'], x: 1, y: 1 },
      { id: 'goal', name: 'flag', tags: ['objective'], x: 2, y: 2 },
      { id: 'e3', name: 'enemy', tags: ['hazard'], x: 3, y: 3 },
    ]);
    expect(resolveEntity(entities, 'goal')?.id).toBe('goal');
    expect(resolveEntity(entities, 'flag')?.id).toBe('goal');
    expect(resolveEntity(entities, 'hazard')?.id).toBe('e3');
    expect(resolveEntity(entities, 'missing')).toBeNull();
  });
});

describe('nav grid normalization', () => {
  it('accepts a well-formed grid and rejects a mismatched one', () => {
    const grid = normalizeNavGrid({
      originX: 0,
      originY: 0,
      cellSize: 32,
      cols: 2,
      rows: 2,
      solid: [true, 0, 1, false],
    });
    expect(grid).toEqual({
      originX: 0,
      originY: 0,
      cellSize: 32,
      cols: 2,
      rows: 2,
      solid: [true, false, true, false],
    });
    expect(normalizeNavGrid({ cols: 2, rows: 2, cellSize: 32, solid: [true] })).toBeNull();
    expect(normalizeNavGrid({ cols: 0, rows: 2, cellSize: 32, solid: [] })).toBeNull();
    expect(normalizeNavGrid(null)).toBeNull();
  });
});

describe('reference shim', () => {
  it('is what the runner fixture ships, byte for byte', async () => {
    const reference = await readFile(PROBE_SHIM_PATH);
    const fixtureCopy = await readFile(path.join(RUNNER_DIR, 'probe-shim.js'));
    expect(fixtureCopy.equals(reference)).toBe(true);
  });

  it('installs a v1 probe whose senses appear only once configured', async () => {
    const source = await readFile(PROBE_SHIM_PATH, 'utf8');
    const global: Record<string, unknown> = {};
    new Function('window', 'globalThis', `${source}`).call(global, global, global);

    const probe = global.__hearthProbe as {
      version: number;
      emit(name: string): void;
      drainEvents(): string[];
      configure(spec: Record<string, unknown>): unknown;
      scene?: () => string | null;
      entities?: () => unknown[];
      reset?: () => void;
      navGrid?: () => unknown;
      actions?: string[];
    };

    expect(probe.version).toBe(1);
    expect(typeof probe.drainEvents).toBe('function');
    expect(probe.scene).toBeUndefined();
    expect(probe.entities).toBeUndefined();
    expect(probe.navGrid).toBeUndefined();
    expect(probe.reset).toBeUndefined();

    probe.emit('jump');
    probe.emit('jump');
    probe.emit(42 as unknown as string);
    expect(probe.drainEvents()).toEqual(['jump', 'jump']);
    expect(probe.drainEvents()).toEqual([]);

    probe.configure({
      actions: ['left', 'right', 3],
      scene: () => 'level1',
      entities: () => [{ id: 'player', x: 1, y: 2 }, 'junk'],
    });
    expect(probe.actions).toEqual(['left', 'right']);
    expect(probe.scene?.()).toBe('level1');
    expect(probe.entities?.()).toEqual([{ id: 'player', x: 1, y: 2, alive: true }]);
    expect(probe.navGrid).toBeUndefined();

    // A hook that throws degrades one sense instead of breaking the probe.
    probe.configure({
      scene: () => {
        throw new Error('boom');
      },
      entities: () => {
        throw new Error('boom');
      },
    });
    expect(probe.scene?.()).toBeNull();
    expect(probe.entities?.()).toEqual([]);
  });
});
