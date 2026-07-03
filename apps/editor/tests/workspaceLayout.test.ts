import { describe, expect, it } from 'vitest';
import {
  LAYOUT_VERSION,
  isValidDockviewLayout,
  layoutStorageKey,
  restoreLayout,
  serializeLayout,
} from '../src/workspace/layout';

/** Minimal but structurally honest dockview toJSON() output. */
function sampleLayout(panelIds: string[] = ['scene', 'hierarchy']) {
  const panels: Record<string, unknown> = {};
  for (const id of panelIds) {
    panels[id] = { id, contentComponent: id, title: id };
  }
  return {
    grid: {
      root: { type: 'branch', data: [] },
      width: 1280,
      height: 720,
      orientation: 'HORIZONTAL',
    },
    panels,
    activeGroup: '1',
  };
}

describe('workspace layout persistence helpers', () => {
  it('builds the localStorage key from the project id', () => {
    expect(layoutStorageKey('proj-123')).toBe('hearth.layout.proj-123');
    expect(layoutStorageKey('/Users/me/games/demo')).toBe('hearth.layout./Users/me/games/demo');
  });

  it('round-trips a layout through serialize/restore', () => {
    const layout = sampleLayout();
    const restored = restoreLayout(serializeLayout(layout));
    expect(restored).toEqual(layout);
  });

  it('stamps the current layout version', () => {
    const stored = JSON.parse(serializeLayout(sampleLayout())) as { version: number };
    expect(stored.version).toBe(LAYOUT_VERSION);
  });

  it('returns null for missing or malformed values', () => {
    expect(restoreLayout(null)).toBeNull();
    expect(restoreLayout(undefined)).toBeNull();
    expect(restoreLayout('')).toBeNull();
    expect(restoreLayout('not json{{')).toBeNull();
    expect(restoreLayout('42')).toBeNull();
    expect(restoreLayout('[1,2,3]')).toBeNull();
  });

  it('rejects a version-stamped envelope from a different layout version', () => {
    const stale = JSON.stringify({ version: LAYOUT_VERSION + 1, layout: sampleLayout() });
    expect(restoreLayout(stale)).toBeNull();
  });

  it('rejects layouts referencing unknown panels', () => {
    const foreign = JSON.stringify({ version: LAYOUT_VERSION, layout: sampleLayout(['scene', 'timeline']) });
    expect(restoreLayout(foreign)).toBeNull();
  });

  it('rejects layouts with a broken grid', () => {
    const layout = sampleLayout() as Record<string, unknown>;
    expect(isValidDockviewLayout({ ...layout, grid: undefined })).toBe(false);
    expect(isValidDockviewLayout({ ...layout, grid: { root: null } })).toBe(false);
    expect(isValidDockviewLayout({ ...layout, panels: 'nope' })).toBe(false);
    expect(isValidDockviewLayout(layout)).toBe(true);
  });
});
