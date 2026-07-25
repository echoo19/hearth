/**
 * Declared game state on the project file: `hearth.json` gains a `gameState`
 * record of named number/boolean/string values that scripts read and write
 * through ctx.state. The declaration is the single source of truth for a
 * value's type, its initial value, and whether it persists across sessions.
 */
import { describe, expect, it } from 'vitest';
import { GameStateEntrySchema, ProjectFileSchema } from '@hearth/core';

/** Smallest object ProjectFileSchema accepts: everything else has a default. */
const minimal = { id: 'prj_test', name: 'p' };

describe('project gameState declaration', () => {
  it('defaults to an empty record so existing projects stay valid', () => {
    const parsed = ProjectFileSchema.parse(minimal);
    expect(parsed.gameState).toEqual({});
  });

  it('accepts typed declarations with initial values and persistence', () => {
    const parsed = ProjectFileSchema.parse({
      ...minimal,
      gameState: {
        score: { type: 'number', initial: 0 },
        best: { type: 'number', initial: 0, persist: true },
      },
    });
    expect(parsed.gameState.score.persist).toBe(false);
    expect(parsed.gameState.best.persist).toBe(true);
  });

  it('accepts boolean and string values', () => {
    const parsed = ProjectFileSchema.parse({
      ...minimal,
      gameState: {
        alive: { type: 'boolean', initial: true },
        rank: { type: 'string', initial: 'rookie' },
      },
    });
    expect(parsed.gameState.alive.initial).toBe(true);
    expect(parsed.gameState.rank.initial).toBe('rookie');
  });

  it('rejects an initial value whose type does not match the declaration', () => {
    const bad = ProjectFileSchema.safeParse({
      ...minimal,
      gameState: { score: { type: 'number', initial: 'zero' } },
    });
    expect(bad.success).toBe(false);
  });

  it('reports the mismatch on the initial field', () => {
    const bad = GameStateEntrySchema.safeParse({ type: 'boolean', initial: 3 });
    expect(bad.success).toBe(false);
    if (bad.success) return;
    expect(bad.error.issues[0].path).toEqual(['initial']);
    expect(bad.error.issues[0].message).toMatch(/boolean/);
  });

  it('rejects an unknown declared type', () => {
    const bad = GameStateEntrySchema.safeParse({ type: 'vec2', initial: 0 });
    expect(bad.success).toBe(false);
  });

  it('round-trips through the schema unchanged', () => {
    const declared = {
      ...minimal,
      gameState: { score: { type: 'number' as const, initial: 0, persist: false } },
    };
    const once = ProjectFileSchema.parse(declared);
    const twice = ProjectFileSchema.parse(once);
    expect(twice.gameState).toEqual(once.gameState);
  });
});
