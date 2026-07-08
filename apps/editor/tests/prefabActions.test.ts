import { describe, it, expect } from 'vitest';
import { countPrefabInstances, syncConfirmBody } from '../src/prefabActions';
import type { CommandResult } from '../src/types';

describe('syncConfirmBody', () => {
  it('renders the exact spec copy with the count substituted', () => {
    expect(syncConfirmBody(3)).toBe('Rebuilds 3 instances from this prefab. Names and positions are kept.');
  });

  it('still says "instances" (not "instance") for a count of 1', () => {
    // The spec's exact copy is fixed regardless of count — no singular/plural branching.
    expect(syncConfirmBody(1)).toBe('Rebuilds 1 instances from this prefab. Names and positions are kept.');
  });

  it('handles zero', () => {
    expect(syncConfirmBody(0)).toBe('Rebuilds 0 instances from this prefab. Names and positions are kept.');
  });
});

describe('countPrefabInstances', () => {
  function ok<T>(data: T): CommandResult<T> {
    return { success: true, command: 'inspectScene', data, errors: [], warnings: [], changed: [], files: [], suggestions: [] };
  }
  function fail(): CommandResult<never> {
    return {
      success: false,
      command: 'inspectScene',
      data: null,
      errors: [{ code: 'NOT_FOUND', message: 'nope' }],
      warnings: [],
      changed: [],
      files: [],
      suggestions: [],
    };
  }

  it('sums matching instance roots across every scene', async () => {
    const exec = async <T>(_name: string, params?: unknown): Promise<CommandResult<T>> => {
      const scene = (params as { scene: string }).scene;
      if (scene === 'sceneA') {
        return ok({
          entities: [{ prefab: { asset: 'ast_1' } }, { prefab: { asset: 'ast_2' } }, {}],
        }) as CommandResult<T>;
      }
      return ok({ entities: [{ prefab: { asset: 'ast_1' } }] }) as CommandResult<T>;
    };
    const total = await countPrefabInstances(exec, ['sceneA', 'sceneB'], 'ast_1');
    expect(total).toBe(2);
  });

  it('treats a failed scene lookup as zero instances rather than throwing', async () => {
    const exec = async <T>(): Promise<CommandResult<T>> => fail() as unknown as CommandResult<T>;
    const total = await countPrefabInstances(exec, ['sceneA'], 'ast_1');
    expect(total).toBe(0);
  });

  it('returns 0 for an empty scene list', async () => {
    const exec = async <T>(): Promise<CommandResult<T>> => ok({ entities: [] }) as unknown as CommandResult<T>;
    const total = await countPrefabInstances(exec, [], 'ast_1');
    expect(total).toBe(0);
  });
});
