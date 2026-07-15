// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  allCollapsed,
  collapseStorageKey,
  loadCollapsed,
  saveCollapsed,
  setAllCollapsed,
  toggleCollapsed,
} from '../src/inspectorCollapse';

afterEach(() => localStorage.clear());

describe('collapseStorageKey', () => {
  it('scopes the key per project path', () => {
    expect(collapseStorageKey('/a/proj')).not.toBe(collapseStorageKey('/b/proj'));
    expect(collapseStorageKey(null)).toBe('hearth:inspectorCollapsed:_');
  });
});

describe('load/save round-trip', () => {
  it('persists and restores the collapsed set for a project', () => {
    saveCollapsed('/proj', new Set(['Transform', 'Script']));
    expect(loadCollapsed('/proj')).toEqual(new Set(['Transform', 'Script']));
    // A different project is independent.
    expect(loadCollapsed('/other')).toEqual(new Set());
  });

  it('returns an empty set for absent or malformed storage', () => {
    expect(loadCollapsed('/none')).toEqual(new Set());
    localStorage.setItem(collapseStorageKey('/bad'), 'not json');
    expect(loadCollapsed('/bad')).toEqual(new Set());
    localStorage.setItem(collapseStorageKey('/obj'), '{"a":1}');
    expect(loadCollapsed('/obj')).toEqual(new Set());
  });
});

describe('toggleCollapsed', () => {
  it('adds then removes a type without mutating the input', () => {
    const start = new Set<string>();
    const added = toggleCollapsed(start, 'Script');
    expect(added.has('Script')).toBe(true);
    expect(start.has('Script')).toBe(false);
    expect(toggleCollapsed(added, 'Script').has('Script')).toBe(false);
  });
});

describe('allCollapsed / setAllCollapsed', () => {
  it('reports true only when every current type is collapsed', () => {
    const types = ['Transform', 'Script'];
    expect(allCollapsed(new Set(types), types)).toBe(true);
    expect(allCollapsed(new Set(['Transform']), types)).toBe(false);
    expect(allCollapsed(new Set(), [])).toBe(false);
  });

  it('collapses or expands only the given types', () => {
    const start = new Set(['OtherCard']);
    const collapsed = setAllCollapsed(start, ['Transform', 'Script'], true);
    expect(collapsed).toEqual(new Set(['OtherCard', 'Transform', 'Script']));
    const expanded = setAllCollapsed(collapsed, ['Transform', 'Script'], false);
    expect(expanded).toEqual(new Set(['OtherCard']));
  });
});
