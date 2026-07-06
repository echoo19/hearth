import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, InputMappingsSchema } from '@hearth/core';

async function makeSession(granted?: any) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return {
    fs,
    session: HearthSession.fromStore(store, granted ? { granted } : {}),
    store,
  };
}

describe('input schema', () => {
  it('old-shape hearth.json (actions only) parses with defaults for new fields', () => {
    const oldShape = {
      actions: { move_left: ['ArrowLeft', 'KeyA'] },
    };

    const result = InputMappingsSchema.safeParse(oldShape);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions).toEqual({ move_left: ['ArrowLeft', 'KeyA'] });
      expect(result.data.gamepadButtons).toEqual({});
      expect(result.data.gamepadAxes).toEqual({});
      expect(result.data.axes).toEqual({});
      expect(result.data.deadzone).toBe(0.15);
    }
  });

  it('gamepadButtons rejects non-array values', () => {
    const invalid = {
      gamepadButtons: { jump: 'not-an-array' },
    };

    const result = InputMappingsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('schema accepts unknown button names like ["zz"] (runtime validates later)', () => {
    const mappings = {
      gamepadButtons: { jump: ['zz', 'a'] },
    };

    const result = InputMappingsSchema.safeParse(mappings);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gamepadButtons.jump).toEqual(['zz', 'a']);
    }
  });

  it('updateSettings writes a gamepadButtons binding and it is visible on store.project.inputMappings', async () => {
    const { session, store } = await makeSession(['safe-edit']);

    const result = await session.execute<any>('updateSettings', {
      inputMappings: {
        gamepadButtons: { jump: ['a', 'b'] },
      },
    });

    expect(result.success).toBe(true);
    expect(store.project.inputMappings.gamepadButtons.jump).toEqual(['a', 'b']);
  });

  it('updateSettings replaces top-level keys wholesale (e.g. gamepadButtons)', async () => {
    const { session, store } = await makeSession(['safe-edit']);

    // Set initial mappings
    store.project.inputMappings.gamepadButtons = { jump: ['a'], action: ['b'] };
    store.project.inputMappings.actions = { move: ['ArrowLeft'] };

    // Replace only gamepadButtons
    const result = await session.execute<any>('updateSettings', {
      inputMappings: {
        gamepadButtons: { jump: ['x', 'y'] },
      },
    });

    expect(result.success).toBe(true);
    expect(store.project.inputMappings.gamepadButtons).toEqual({ jump: ['x', 'y'] });
    // actions should remain unchanged
    expect(store.project.inputMappings.actions).toEqual({ move: ['ArrowLeft'] });
  });
});
