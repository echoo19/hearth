import { describe, expect, it } from 'vitest';
import { commandLabel } from '../src/store';

/**
 * Pure-function coverage for commandLabel — the map that replaces raw
 * camelCase command names (createEntity, snapshotProject, ...) with plain
 * language in Console log lines (exec()'s error/warning/summary paths and
 * refreshDiff()'s diffProject error). No store instance, no DOM — mirrors
 * the style of postEffectsHumanize.test.ts / inspectorHumanize.test.ts.
 */
describe('commandLabel', () => {
  it('maps the highest-traffic commands to plain language', () => {
    expect(commandLabel('createEntity')).toBe('Create entity');
    expect(commandLabel('deleteEntity')).toBe('Delete entity');
    expect(commandLabel('moveEntity')).toBe('Move entity');
    expect(commandLabel('setComponentProperty')).toBe('Edit component');
    expect(commandLabel('editScript')).toBe('Save script');
    expect(commandLabel('snapshotProject')).toBe('Save checkpoint');
    expect(commandLabel('revertProject')).toBe('Restore checkpoint');
    expect(commandLabel('syncPrefabInstances')).toBe('Sync prefab instances');
    expect(commandLabel('diffProject')).toBe('Review changes');
  });

  it('falls back to the raw command name for anything not yet in the map', () => {
    expect(commandLabel('resizeTilemap')).toBe('resizeTilemap');
    expect(commandLabel('undo')).toBe('undo');
    expect(commandLabel('')).toBe('');
  });
});
