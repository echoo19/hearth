import { describe, it, expect } from 'vitest';
import { isFieldOverridden, overriddenEntityIds, overriddenPathsUnder } from '../src/prefabOverrides';
import type { EntityPrefabInfo, RawPrefabOverride } from '../src/prefabOverrides';

describe('isFieldOverridden', () => {
  it('is false when there is no prefab info at all (not an instance member)', () => {
    expect(isFieldOverridden(null, 'Transform', 'position')).toBe(false);
    expect(isFieldOverridden(undefined, 'Transform', 'position')).toBe(false);
  });

  it('is false when the instance has no overrides recorded', () => {
    const info: EntityPrefabInfo = { asset: 'ast_1', root: 'ent_root', localId: 'pfe_1', overridden: [] };
    expect(isFieldOverridden(info, 'Transform', 'position')).toBe(false);
  });

  it('matches an exact component + path override', () => {
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [{ component: 'Transform', path: 'position.x' }],
    };
    expect(isFieldOverridden(info, 'Transform', 'position.x')).toBe(true);
  });

  it('does not match a different component with the same path', () => {
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [{ component: 'Collider', path: 'position.x' }],
    };
    expect(isFieldOverridden(info, 'Transform', 'position.x')).toBe(false);
  });

  it('does not match an unrelated path on the same component', () => {
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [{ component: 'Transform', path: 'rotation' }],
    };
    expect(isFieldOverridden(info, 'Transform', 'position')).toBe(false);
  });

  it('a recorded override on a nested path marks its ancestor row overridden (Transform.position.x -> position)', () => {
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [{ component: 'Transform', path: 'position.x' }],
    };
    expect(isFieldOverridden(info, 'Transform', 'position')).toBe(true);
  });

  it('a recorded override on a whole field marks its descendant paths overridden (Transform.position -> position.x/position.y)', () => {
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [{ component: 'Transform', path: 'position' }],
    };
    expect(isFieldOverridden(info, 'Transform', 'position.x')).toBe(true);
    expect(isFieldOverridden(info, 'Transform', 'position.y')).toBe(true);
  });

  it('does not treat a sibling field with a shared prefix as an ancestor/descendant match', () => {
    // "positionX" must not be treated as a descendant of "position".
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [{ component: 'Transform', path: 'position' }],
    };
    expect(isFieldOverridden(info, 'Transform', 'positionX')).toBe(false);
  });

  it('checks every recorded override, not just the first', () => {
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [
        { component: 'Transform', path: 'rotation' },
        { component: 'SpriteRenderer', path: 'color' },
        { component: 'Transform', path: 'position.y' },
      ],
    };
    expect(isFieldOverridden(info, 'Transform', 'position')).toBe(true);
  });
});

describe('overriddenPathsUnder', () => {
  it('returns an empty list when there is no prefab info', () => {
    expect(overriddenPathsUnder(null, 'Transform', 'position')).toEqual([]);
  });

  it('returns the exact path when the row itself was recorded', () => {
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [{ component: 'SpriteRenderer', path: 'color' }],
    };
    expect(overriddenPathsUnder(info, 'SpriteRenderer', 'color')).toEqual(['color']);
  });

  it('collects every nested path recorded under a row, not a synthesized parent path', () => {
    // Independently-edited x and y axes record two separate override
    // entries; reverting the "Position" row must target both exact paths,
    // never a single "position" path (which was never actually recorded).
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [
        { component: 'Transform', path: 'position.x' },
        { component: 'Transform', path: 'position.y' },
        { component: 'Transform', path: 'rotation' },
      ],
    };
    expect(overriddenPathsUnder(info, 'Transform', 'position').sort()).toEqual(['position.x', 'position.y']);
  });

  it('does not match a different component with the same path', () => {
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [{ component: 'Collider', path: 'position.x' }],
    };
    expect(overriddenPathsUnder(info, 'Transform', 'position')).toEqual([]);
  });

  it('does not treat a sibling field with a shared prefix as nested', () => {
    const info: EntityPrefabInfo = {
      asset: 'ast_1',
      root: 'ent_root',
      localId: 'pfe_1',
      overridden: [{ component: 'Transform', path: 'positionX' }],
    };
    expect(overriddenPathsUnder(info, 'Transform', 'position')).toEqual([]);
  });
});

describe('overriddenEntityIds', () => {
  it('returns an empty list for no overrides', () => {
    expect(overriddenEntityIds([])).toEqual([]);
  });

  it('dedupes repeated entity ids, keeping first-seen order', () => {
    const overrides: RawPrefabOverride[] = [
      { entity: 'ent_a', component: 'Transform', path: 'position.x', value: 1 },
      { entity: 'ent_b', component: 'SpriteRenderer', path: 'color', value: '#fff' },
      { entity: 'ent_a', component: 'Transform', path: 'position.y', value: 2 },
    ];
    expect(overriddenEntityIds(overrides)).toEqual(['ent_a', 'ent_b']);
  });

  it('is stable for a single entity with multiple overrides', () => {
    const overrides: RawPrefabOverride[] = [
      { entity: 'ent_root', component: 'Transform', path: 'rotation', value: 90 },
      { entity: 'ent_root', component: 'Transform', path: 'position.x', value: 4 },
    ];
    expect(overriddenEntityIds(overrides)).toEqual(['ent_root']);
  });
});
