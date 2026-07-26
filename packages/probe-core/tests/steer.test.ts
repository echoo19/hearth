/**
 * The Steerer: turning "I want to go that way" into held inputs, using only a
 * measured basis. Nothing here knows that "right" means +x — that is the whole
 * point, and it is why the steering policies work on a control scheme nobody
 * declared.
 */
import { describe, expect, it } from 'vitest';
import { InputQueue, pickBasis, Steerer, type MovementBasis } from '@hearth/probe-core';

const BASIS: MovementBasis = {
  entries: [
    { input: { kind: 'action', action: 'east' }, dx: 100, dy: 0 },
    { input: { kind: 'action', action: 'west' }, dx: -100, dy: 0 },
    { input: { kind: 'axis', axis: 'vertical', value: 1 }, dx: 0, dy: 90 },
    { input: { kind: 'axis', axis: 'vertical', value: -1 }, dx: 0, dy: -90 },
  ],
};

describe('pickBasis', () => {
  it('picks the best-aligned entry', () => {
    expect(pickBasis(BASIS, 5, 0)?.input).toEqual({ kind: 'action', action: 'east' });
    expect(pickBasis(BASIS, -5, 0)?.input).toEqual({ kind: 'action', action: 'west' });
    expect(pickBasis(BASIS, 1, 8)?.input).toEqual({ kind: 'axis', axis: 'vertical', value: 1 });
  });

  it('returns null for a degenerate direction', () => {
    expect(pickBasis(BASIS, 0, 0)).toBeNull();
    expect(pickBasis({ entries: [] }, 1, 1)).toBeNull();
  });

  it('never steers backward: only positive alignment counts', () => {
    const oneWay: MovementBasis = { entries: [{ input: { kind: 'action', action: 'east' }, dx: 10, dy: 0 }] };
    expect(pickBasis(oneWay, -10, 0)).toBeNull();
  });

  it('ignores basis entries that measured no movement', () => {
    const dead: MovementBasis = {
      entries: [
        { input: { kind: 'action', action: 'dead' }, dx: 0, dy: 0 },
        { input: { kind: 'action', action: 'east' }, dx: 4, dy: 0 },
      ],
    };
    expect(pickBasis(dead, 1, 0)?.input).toEqual({ kind: 'action', action: 'east' });
  });
});

describe('Steerer', () => {
  it('holds one input and only re-presses when the choice changes', () => {
    const input = new InputQueue();
    const steerer = new Steerer(BASIS);
    steerer.steer(input, 10, 0);
    steerer.steer(input, 12, 1);
    steerer.steer(input, 8, 0);
    expect(input.events).toEqual([{ frame: 0, kind: 'action', action: 'east', down: true }]);
  });

  it('releases the previous input before applying the new one', () => {
    const input = new InputQueue();
    const steerer = new Steerer(BASIS);
    steerer.steer(input, 10, 0);
    steerer.steer(input, -10, 0);
    expect(input.events.map((e) => (e.kind === 'action' ? `${e.action}:${e.down}` : e.kind))).toEqual([
      'east:true',
      'east:false',
      'west:true',
    ]);
  });

  it('zeroes an axis when it steers away from it', () => {
    const input = new InputQueue();
    const steerer = new Steerer(BASIS);
    steerer.steer(input, 0, 10);
    steerer.release(input);
    expect(input.events).toEqual([
      { frame: 0, kind: 'axis', axis: 'vertical', value: 1 },
      { frame: 0, kind: 'axis', axis: 'vertical', value: 0 },
    ]);
  });

  it('exposes the unit intent while steering and nothing when released', () => {
    const input = new InputQueue();
    const steerer = new Steerer(BASIS);
    expect(steerer.intent).toBeNull();
    steerer.steer(input, 30, 40);
    expect(steerer.intent?.dx).toBeCloseTo(0.6, 5);
    expect(steerer.intent?.dy).toBeCloseTo(0.8, 5);
    steerer.release(input);
    expect(steerer.intent).toBeNull();
  });

  it('releasing twice is a no-op', () => {
    const input = new InputQueue();
    const steerer = new Steerer(BASIS);
    steerer.release(input);
    steerer.release(input);
    expect(input.events).toEqual([]);
  });
});

describe('InputQueue', () => {
  it('records a timeline and drains pending mutations once', () => {
    const q = new InputQueue();
    q.setFrame(3);
    q.action('jump', true);
    q.pointer(10, 20, 'down');
    expect(q.drain()).toHaveLength(2);
    expect(q.drain()).toHaveLength(0);
    expect(q.events).toEqual([
      { frame: 3, kind: 'action', action: 'jump', down: true },
      { frame: 3, kind: 'pointer', x: 10, y: 20, pointer: 'down' },
    ]);
  });
});
