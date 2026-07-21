/**
 * `setAction` playtest step (sticky hold/release, mirrors setAxis) and the
 * shared ObjectiveSchema (reach/survive/event/property) that sweeps and
 * baked playtests build on top of.
 */
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, ObjectiveSchema } from '../src/index.js';

describe('setAction playtest step schema', () => {
  it('accepts a step with action, down, and optional frames', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
    const session = HearthSession.fromStore(store, {});
    const created = await session.execute('createPlaytest', {
      name: 'set-action',
      scene: 'Main',
      steps: [
        { type: 'setAction', action: 'jump', down: true },
        { type: 'setAction', action: 'jump', down: false, frames: 0 },
      ],
    });
    expect(created.success).toBe(true);
  });

  it('rejects a step missing down', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
    const session = HearthSession.fromStore(store, {});
    const created = await session.execute('createPlaytest', {
      name: 'invalid',
      scene: 'Main',
      steps: [{ type: 'setAction', action: 'jump' }],
    });
    expect(created.success).toBe(false);
  });

  it('rejects a negative frames value', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
    const session = HearthSession.fromStore(store, {});
    const created = await session.execute('createPlaytest', {
      name: 'invalid-frames',
      scene: 'Main',
      steps: [{ type: 'setAction', action: 'jump', down: true, frames: -1 }],
    });
    expect(created.success).toBe(false);
  });
});

describe('ObjectiveSchema', () => {
  it('parses a reach objective with tolerance defaulted to 24', () => {
    const parsed = ObjectiveSchema.parse({ type: 'reach', target: 'exit-door' });
    expect(parsed).toEqual({ type: 'reach', target: 'exit-door', tolerance: 24 });
  });

  it('parses a reach objective with a point target and explicit entity', () => {
    const parsed = ObjectiveSchema.parse({
      type: 'reach',
      target: { x: 10, y: 20 },
      entity: 'Player',
      tolerance: 5,
    });
    expect(parsed).toEqual({ type: 'reach', target: { x: 10, y: 20 }, entity: 'Player', tolerance: 5 });
  });

  it('parses a survive objective', () => {
    const parsed = ObjectiveSchema.parse({ type: 'survive', frames: 300 });
    expect(parsed).toEqual({ type: 'survive', frames: 300 });
  });

  it('parses an event objective with count defaulted to 1', () => {
    const parsed = ObjectiveSchema.parse({ type: 'event', event: 'coin-collected' });
    expect(parsed).toEqual({ type: 'event', event: 'coin-collected', count: 1 });
  });

  it('parses a property objective with at least one comparator', () => {
    const parsed = ObjectiveSchema.parse({
      type: 'property',
      entity: 'Player',
      property: 'Health.current',
      greaterThan: 0,
    });
    expect(parsed).toEqual({
      type: 'property',
      entity: 'Player',
      property: 'Health.current',
      greaterThan: 0,
    });
  });

  it('rejects a property objective with no comparator', () => {
    const result = ObjectiveSchema.safeParse({
      type: 'property',
      entity: 'Player',
      property: 'Health.current',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain(
        'requires at least one of equals, greaterThan, or lessThan',
      );
    }
  });

  it('rejects an unknown discriminant', () => {
    expect(() => ObjectiveSchema.parse({ type: 'nope' })).toThrow();
  });
});
