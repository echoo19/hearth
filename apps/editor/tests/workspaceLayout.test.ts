import { describe, expect, it, vi } from 'vitest';
import {
  LAYOUT_VERSION,
  ensureGroupsActive,
  isValidDockviewLayout,
  layoutStorageKey,
  nextAutoReveal,
  restoreLayout,
  serializeLayout,
  type GroupsActiveApi,
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
    expect(restored).toEqual({ layout, migrateAgentDock: false, template: 'studio' });
  });

  it('stamps the current layout version', () => {
    const stored = JSON.parse(serializeLayout(sampleLayout())) as { version: number };
    expect(stored.version).toBe(2);
  });

  it('accepts a version-1 envelope and flags it for the agent-dock migration', () => {
    const v1 = JSON.stringify({ version: 1, layout: sampleLayout(['scene', 'agent']) });
    const restored = restoreLayout(v1);
    expect(restored).not.toBeNull();
    expect(restored!.migrateAgentDock).toBe(true);
    expect(restored!.layout).toEqual(sampleLayout(['scene', 'agent']));
  });

  it('returns null for missing or malformed values', () => {
    expect(restoreLayout(null)).toBeNull();
    expect(restoreLayout(undefined)).toBeNull();
    expect(restoreLayout('')).toBeNull();
    expect(restoreLayout('not json{{')).toBeNull();
    expect(restoreLayout('42')).toBeNull();
    expect(restoreLayout('[1,2,3]')).toBeNull();
  });

  it('rejects a version-stamped envelope from an unknown layout version', () => {
    const stale = JSON.stringify({ version: LAYOUT_VERSION + 1, layout: sampleLayout() });
    expect(restoreLayout(stale)).toBeNull();
    expect(restoreLayout(JSON.stringify({ version: 0, layout: sampleLayout() }))).toBeNull();
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

  it('round-trips the workspace template', () => {
    const restored = restoreLayout(serializeLayout(sampleLayout(), 'agent'));
    expect(restored?.template).toBe('agent');
  });

  it('defaults an absent template to studio', () => {
    const restored = restoreLayout(serializeLayout(sampleLayout()));
    expect(restored?.template).toBe('studio');
  });

  it('tolerates a garbled template value', () => {
    const raw = JSON.stringify({ version: LAYOUT_VERSION, layout: sampleLayout(), template: 'kiosk' });
    const restored = restoreLayout(raw);
    expect(restored).not.toBeNull();
    expect(restored?.template).toBe('studio');
  });

  it('reports studio for migrated v1 envelopes', () => {
    const raw = JSON.stringify({ version: 1, layout: sampleLayout() });
    const restored = restoreLayout(raw);
    expect(restored?.migrateAgentDock).toBe(true);
    expect(restored?.template).toBe('studio');
  });
});

describe('nextAutoReveal', () => {
  it('opens the inspector once on first selection in the agent workspace', () => {
    const r = nextAutoReveal('idle', { template: 'agent', hasSelection: true, inspectorOpen: false });
    expect(r).toEqual({ state: 'opened', open: true });
  });

  it('never opens in the studio workspace or without a selection', () => {
    expect(nextAutoReveal('idle', { template: 'studio', hasSelection: true, inspectorOpen: false }).open).toBe(
      false,
    );
    expect(nextAutoReveal('idle', { template: 'agent', hasSelection: false, inspectorOpen: false }).open).toBe(
      false,
    );
    expect(nextAutoReveal('idle', { template: null, hasSelection: true, inspectorOpen: false }).open).toBe(false);
  });

  it('treats a vanished inspector after auto-open as a dismissal', () => {
    const r = nextAutoReveal('opened', { template: 'agent', hasSelection: true, inspectorOpen: false });
    expect(r).toEqual({ state: 'dismissed', open: false });
  });

  it('stays dismissed', () => {
    const r = nextAutoReveal('dismissed', { template: 'agent', hasSelection: true, inspectorOpen: false });
    expect(r).toEqual({ state: 'dismissed', open: false });
  });

  it('holds state while the inspector is open', () => {
    const r = nextAutoReveal('opened', { template: 'agent', hasSelection: true, inspectorOpen: true });
    expect(r).toEqual({ state: 'opened', open: false });
  });
});

// A fake dockview panel/group graph for ensureGroupsActive. Each panel records
// setActive() calls so the tests can assert exactly which panels got activated.
function fakePanel(id: string, calls: string[]) {
  return { id, api: { setActive: () => calls.push(id) } };
}

function fakeApi(
  groups: Array<{ panels: ReturnType<typeof fakePanel>[]; activeId: string | null }>,
  activeId: string | null,
  calls: string[],
): GroupsActiveApi {
  const findPanel = (id: string | null) =>
    id == null ? undefined : groups.flatMap((g) => g.panels).find((p) => p.id === id);
  return {
    groups: groups.map((g) => ({
      panels: g.panels,
      activePanel: g.panels.find((p) => p.id === g.activeId) ?? null,
    })),
    activePanel: findPanel(activeId),
  };
}

describe('ensureGroupsActive', () => {
  it('activates the first panel of a group that has panels but no active one', () => {
    const calls: string[] = [];
    // Mirrors the reported bug: a Hierarchy-only side group left headless
    // renders the "All panels are closed" watermark until its panel is active.
    const api = fakeApi([{ panels: [fakePanel('hierarchy', calls)], activeId: null }], null, calls);
    ensureGroupsActive(api);
    expect(calls).toEqual(['hierarchy']);
  });

  it('heals every headless group in one pass and restores global focus', () => {
    const calls: string[] = [];
    const api = fakeApi(
      [
        { panels: [fakePanel('hierarchy', calls)], activeId: null },
        { panels: [fakePanel('scene', calls), fakePanel('game', calls)], activeId: 'scene' },
        { panels: [fakePanel('inspector', calls)], activeId: null },
        { panels: [fakePanel('assets', calls), fakePanel('console', calls)], activeId: null },
      ],
      'scene',
      calls,
    );
    ensureGroupsActive(api);
    // Both headless side groups plus the bottom group are healed, then Scene
    // is re-activated last so it stays the visually active group.
    expect(calls).toEqual(['hierarchy', 'inspector', 'assets', 'scene']);
  });

  it('is a no-op when every group already has an active panel', () => {
    const calls: string[] = [];
    const api = fakeApi(
      [
        { panels: [fakePanel('hierarchy', calls)], activeId: 'hierarchy' },
        { panels: [fakePanel('scene', calls)], activeId: 'scene' },
      ],
      'scene',
      calls,
    );
    ensureGroupsActive(api);
    // Only the focus-restore touch, no watermark-evicting activations.
    expect(calls).toEqual(['scene']);
  });

  it('ignores empty groups', () => {
    const calls: string[] = [];
    const setActive = vi.fn();
    const api: GroupsActiveApi = {
      groups: [{ panels: [], activePanel: null }],
      activePanel: { api: { setActive } },
    };
    ensureGroupsActive(api);
    expect(calls).toEqual([]);
    expect(setActive).toHaveBeenCalledTimes(1); // just the focus restore
  });
});
