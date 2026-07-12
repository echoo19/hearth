import { describe, it, expect } from 'vitest';
import {
  countPrefabInstances,
  createSyncPreflight,
  instanceOverrideCount,
  revertAllConfirmBody,
  syncConfirmBody,
} from '../src/prefabActions';
import type { CommandResult } from '../src/types';

describe('syncConfirmBody', () => {
  it('renders merge-semantics copy with the count substituted', () => {
    expect(syncConfirmBody(3)).toBe(
      "Syncs 3 instances with this prefab. Overrides you've made on each instance are kept; any that no longer apply to the updated prefab are dropped. Names and positions are kept.",
    );
  });

  it('no longer describes a wholesale rebuild', () => {
    // Wave I: syncPrefabInstances merges (reuses scene ids, re-applies
    // overrides) rather than rebuilding every instance from scratch.
    expect(syncConfirmBody(3)).not.toMatch(/rebuild/i);
  });

  it('mentions that overrides are preserved', () => {
    expect(syncConfirmBody(3)).toMatch(/overrides.*kept/i);
  });

  it('still says "instances" (not "instance") for a count of 1', () => {
    // No singular/plural branching, same idiom as before.
    expect(syncConfirmBody(1)).toContain('Syncs 1 instances with this prefab.');
  });

  it('handles zero', () => {
    expect(syncConfirmBody(0)).toContain('Syncs 0 instances with this prefab.');
  });
});

describe('instanceOverrideCount', () => {
  it('counts every override record regardless of which member entity it belongs to', () => {
    const overrides = [
      { entity: 'ent_root' },
      { entity: 'ent_child' },
      { entity: 'ent_root' },
    ];
    expect(instanceOverrideCount(overrides)).toBe(3);
  });

  it('is zero for an instance with no overrides', () => {
    expect(instanceOverrideCount([])).toBe(0);
  });
});

describe('revertAllConfirmBody', () => {
  it('renders the count with correct pluralization', () => {
    expect(revertAllConfirmBody(1)).toBe(
      "Reverts 1 override across this prefab instance, restoring the prefab's own values.",
    );
    expect(revertAllConfirmBody(3)).toBe(
      "Reverts 3 overrides across this prefab instance, restoring the prefab's own values.",
    );
  });

  it('handles zero', () => {
    expect(revertAllConfirmBody(0)).toBe(
      "Reverts 0 overrides across this prefab instance, restoring the prefab's own values.",
    );
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

describe('createSyncPreflight', () => {
  it('reports a token current when no later begin() has been issued', () => {
    const preflight = createSyncPreflight();
    const token = preflight.begin();
    expect(preflight.isCurrent(token)).toBe(true);
  });

  it('invalidates an earlier token once a second begin() call is made — the second call wins, the first is stale', () => {
    const preflight = createSyncPreflight();
    const firstToken = preflight.begin();
    const secondToken = preflight.begin();
    expect(preflight.isCurrent(firstToken)).toBe(false);
    expect(preflight.isCurrent(secondToken)).toBe(true);
  });

  it('keeps the latest token current across repeated checks (does not consume it)', () => {
    const preflight = createSyncPreflight();
    const token = preflight.begin();
    expect(preflight.isCurrent(token)).toBe(true);
    expect(preflight.isCurrent(token)).toBe(true);
  });
});
