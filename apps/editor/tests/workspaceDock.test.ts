// @vitest-environment jsdom
/**
 * Workspace dock lifecycle against a real dockview instance in jsdom.
 *
 * Two regression areas from Wave L L-003:
 * - Disposed-dock guards: the View menu's closures can hold a dockview that a
 *   project switch / StrictMode remount already disposed. `resetLayout` and
 *   `showPanel` on that stale reference used to surface uncaught errors
 *   (`api.clear()` → NotFoundError, `addPanel` → "invalid location") which
 *   wedged the menu. Both must silently no-op instead.
 * - Headless-group healing wiring: `buildDefaultLayout` seeds group-leading
 *   panels `inactive`, and persisted layouts can carry `activeView: null`, so
 *   both init paths must leave every non-empty group with an active panel
 *   (dockview paints the "All panels are closed" watermark into headless
 *   groups). These tests pin that `ensureGroupsActive` is actually invoked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDockview, type DockviewApi, type IContentRenderer } from 'dockview-core';
import { buildDefaultLayout, initLayout, resetLayout, showPanel } from '../src/workspace/Workspace';
import { ensureGroupsActive, serializeLayout } from '../src/workspace/layout';

// Spy-wrap ensureGroupsActive (keeping its real behavior) so the wiring tests
// can pin that Workspace's init paths actually invoke the heal — the vendored
// dockview-core currently self-heals grid groups on fromJSON, so a behavioral
// assertion alone would keep passing if the one-line wiring were reverted.
vi.mock('../src/workspace/layout', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/workspace/layout')>();
  return { ...mod, ensureGroupsActive: vi.fn(mod.ensureGroupsActive) };
});

// jsdom has no ResizeObserver; dockview's Resizable requires one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

function stubRenderer(): IContentRenderer {
  const element = document.createElement('div');
  return { element, init: () => undefined };
}

let parents: HTMLElement[] = [];
let docks: DockviewApi[] = [];

function makeDock(width = 1280, height = 720): DockviewApi {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const api = createDockview(parent, {
    createComponent: () => stubRenderer(),
    className: 'test-dock',
  });
  api.layout(width, height);
  parents.push(parent);
  docks.push(api);
  return api;
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(ensureGroupsActive).mockClear();
});

afterEach(() => {
  for (const api of docks) {
    try {
      api.dispose();
    } catch {
      /* already disposed by the test */
    }
  }
  for (const p of parents) p.remove();
  docks = [];
  parents = [];
  localStorage.clear();
});

function headlessGroups(api: DockviewApi): number {
  return api.groups.filter((g) => g.panels.length > 0 && !g.activePanel).length;
}

describe('disposed-dock guards', () => {
  it('resetLayout on a disposed dock no-ops without throwing', () => {
    const api = makeDock();
    buildDefaultLayout(api);
    api.dispose();
    expect(() => resetLayout(api, 'hearth.layout.test')).not.toThrow();
    // A no-op must not persist anything either.
    expect(localStorage.getItem('hearth.layout.test')).toBeNull();
  });

  it('showPanel on a disposed dock no-ops without throwing (open panel)', () => {
    const api = makeDock();
    buildDefaultLayout(api);
    api.dispose();
    // 'scene' still resolves via the stale panels list after dispose.
    expect(() => showPanel(api, 'scene')).not.toThrow();
  });

  it('showPanel on a disposed dock no-ops without throwing (closed panel)', () => {
    const api = makeDock();
    buildDefaultLayout(api);
    api.getPanel('live')?.api.close();
    api.dispose();
    // Re-opening takes the addPanel path, which threw "invalid location"
    // against a disposed instance.
    expect(() => showPanel(api, 'live')).not.toThrow();
  });

  it('resetLayout and showPanel still work on a live dock', () => {
    const api = makeDock();
    resetLayout(api, 'hearth.layout.live');
    expect(api.panels.length).toBeGreaterThan(0);
    expect(localStorage.getItem('hearth.layout.live')).not.toBeNull();
    api.getPanel('inspector')?.api.close();
    expect(api.getPanel('inspector')).toBeUndefined();
    showPanel(api, 'inspector');
    expect(api.getPanel('inspector')).toBeDefined();
  });
});

describe('headless-group healing wiring', () => {
  it('buildDefaultLayout leaves no group without an active panel', () => {
    const api = makeDock();
    buildDefaultLayout(api);
    // Side/bottom groups are seeded with inactive leading panels; without the
    // ensureGroupsActive sweep they'd render the watermark.
    expect(api.groups.length).toBeGreaterThan(1);
    expect(headlessGroups(api)).toBe(0);
    expect(vi.mocked(ensureGroupsActive)).toHaveBeenCalled();
    // Scene remains the visually active group.
    expect(api.activePanel?.id).toBe('scene');
  });

  it('initLayout heals a persisted layout that saved headless groups', () => {
    // Reproduce the persisted broken state: a dock whose side groups were
    // saved with no active panel (activeView missing), as pre-fix builds
    // wrote for users who had rearranged panels.
    const source = makeDock();
    buildDefaultLayout(source);
    const layout = source.toJSON();
    const stripActiveViews = (node: unknown): void => {
      if (node == null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(stripActiveViews);
        return;
      }
      const record = node as Record<string, unknown>;
      if ('activeView' in record) delete record.activeView;
      stripActiveViews(record.data);
    };
    stripActiveViews(layout.grid.root);
    const key = 'hearth.layout.healing';
    localStorage.setItem(key, serializeLayout(layout));

    const api = makeDock();
    vi.mocked(ensureGroupsActive).mockClear();
    initLayout(api, key);
    // The layout restored (not the default-built path: 'live' is closed in
    // the default layout too, so assert via the restored panel set instead).
    expect(api.panels.length).toBeGreaterThan(0);
    // Every non-empty group has an active panel, and OUR sweep ran on the
    // fromJSON path (the vendored dockview-core currently also self-heals
    // grid groups here, so the spy is what pins the wiring).
    expect(headlessGroups(api)).toBe(0);
    expect(vi.mocked(ensureGroupsActive)).toHaveBeenCalledTimes(1);
  });

  it('initLayout falls back to the default layout when nothing is stored', () => {
    const api = makeDock();
    initLayout(api, 'hearth.layout.missing');
    expect(api.getPanel('scene')).toBeDefined();
    expect(headlessGroups(api)).toBe(0);
    expect(vi.mocked(ensureGroupsActive)).toHaveBeenCalled();
  });
});

describe('agent right dock (v1.2 layout)', () => {
  it('default layout puts agent in its own group beside the inspector, not the bottom group', () => {
    const api = makeDock();
    buildDefaultLayout(api);
    const agent = api.getPanel('agent')!;
    const assets = api.getPanel('assets')!;
    expect(agent.group.panels.map((p) => p.id)).toEqual(['agent']);
    expect(agent.group).not.toBe(assets.group);
  });

  it('showPanel reopens a closed agent panel into its own group, not the bottom dock', () => {
    const api = makeDock();
    buildDefaultLayout(api);
    api.removePanel(api.getPanel('agent')!);
    showPanel(api, 'agent');
    const agent = api.getPanel('agent')!;
    expect(agent.group.panels.map((p) => p.id)).toEqual(['agent']);
  });

  it('restores custom widths from a current-version saved layout', () => {
    const source = makeDock();
    buildDefaultLayout(source);
    source.getPanel('hierarchy')!.api.setSize({ width: 400 });
    source.getPanel('inspector')!.api.setSize({ width: 340 });
    const expected = {
      hierarchy: source.getPanel('hierarchy')!.group.width,
      inspector: source.getPanel('inspector')!.group.width,
      agent: source.getPanel('agent')!.group.width,
    };
    const key = 'hearth.layout.custom-widths';
    localStorage.setItem(key, serializeLayout(source.toJSON()));

    const restored = makeDock();
    initLayout(restored, key);

    expect(restored.getPanel('hierarchy')!.group.width).toBeCloseTo(expected.hierarchy, 0);
    expect(restored.getPanel('inspector')!.group.width).toBeCloseTo(expected.inspector, 0);
    expect(restored.getPanel('agent')!.group.width).toBeCloseTo(expected.agent, 0);
  });

  // Replicates the v1 default: agent tabbed inside the bottom (assets) group.
  function buildV1Layout(api: DockviewApi): void {
    api.clear();
    api.addPanel({ id: 'scene', component: 'scene', title: 'Scene' });
    api.addPanel({ id: 'inspector', component: 'inspector', title: 'Inspector', position: { referencePanel: 'scene', direction: 'right' }, initialWidth: 300 });
    api.addPanel({ id: 'assets', component: 'assets', title: 'Assets', position: { referencePanel: 'scene', direction: 'below' }, initialHeight: 340 });
    api.addPanel({ id: 'agent', component: 'agent', title: 'Agent', position: { referencePanel: 'assets', direction: 'within' } });
  }

  it('initLayout migrates a v1 save: agent relocates to its own right group, rest preserved, persisted as v2', () => {
    const source = makeDock();
    buildV1Layout(source);
    const key = 'hearth.layout.migrate-test';
    localStorage.setItem(key, JSON.stringify({ version: 1, layout: source.toJSON() }));

    const api = makeDock();
    initLayout(api, key);
    const agent = api.getPanel('agent')!;
    expect(agent.group.panels.map((p) => p.id)).toEqual(['agent']);
    expect(api.getPanel('assets')).toBeTruthy();
    expect(api.getPanel('inspector')).toBeTruthy();
    const persisted = JSON.parse(localStorage.getItem(key)!) as { version: number };
    expect(persisted.version).toBe(2);
  });

  it('initLayout leaves a v1 agent panel alone when the user had already given it its own group', () => {
    const source = makeDock();
    source.clear();
    source.addPanel({ id: 'scene', component: 'scene', title: 'Scene' });
    source.addPanel({ id: 'agent', component: 'agent', title: 'Agent', position: { referencePanel: 'scene', direction: 'left' } });
    const key = 'hearth.layout.solo-test';
    localStorage.setItem(key, JSON.stringify({ version: 1, layout: source.toJSON() }));

    const api = makeDock();
    initLayout(api, key);
    const agent = api.getPanel('agent')!;
    expect(agent.group.panels.map((p) => p.id)).toEqual(['agent']);
    // Still stamped v2 so the migration never re-runs.
    expect((JSON.parse(localStorage.getItem(key)!) as { version: number }).version).toBe(2);
  });

  it('initLayout of a v1 save with agent closed adds nothing but still re-stamps v2', () => {
    const source = makeDock();
    source.clear();
    source.addPanel({ id: 'scene', component: 'scene', title: 'Scene' });
    const key = 'hearth.layout.closed-test';
    localStorage.setItem(key, JSON.stringify({ version: 1, layout: source.toJSON() }));

    const api = makeDock();
    initLayout(api, key);
    expect(api.getPanel('agent')).toBeUndefined();
    expect((JSON.parse(localStorage.getItem(key)!) as { version: number }).version).toBe(2);
  });

  // No 'inspector' panel at all: relocateAgentPanel's reference falls through
  // to the reference-less `{ direction: 'right' }` position. Pins that
  // dockview-core accepts that fallback instead of throwing.
  it('initLayout migrates a v1 save with a non-solo agent when the inspector panel is absent', () => {
    const source = makeDock();
    source.clear();
    source.addPanel({ id: 'scene', component: 'scene', title: 'Scene' });
    source.addPanel({ id: 'assets', component: 'assets', title: 'Assets', position: { referencePanel: 'scene', direction: 'below' }, initialHeight: 340 });
    source.addPanel({ id: 'agent', component: 'agent', title: 'Agent', position: { referencePanel: 'assets', direction: 'within' } });
    const key = 'hearth.layout.no-inspector-test';
    localStorage.setItem(key, JSON.stringify({ version: 1, layout: source.toJSON() }));

    const api = makeDock();
    initLayout(api, key);
    const agent = api.getPanel('agent')!;
    expect(agent.group.panels.map((p) => p.id)).toEqual(['agent']);
    const persisted = JSON.parse(localStorage.getItem(key)!) as { version: number };
    expect(persisted.version).toBe(2);
  });
});

// Regression: adding the Agent panel `direction: 'right'` of the inspector
// carved its 380px out of the inspector's split, crushing the Inspector to
// ~100px ("Nothing selected" wrapping vertically). Each placement path must
// re-assert the inspector's width so it keeps ~RIGHT_WIDTH while the agent
// keeps ~AGENT_WIDTH and the center group absorbs the difference.
describe('agent dock does not crush the inspector', () => {
  // Not exact-pixel: dockview rounds and the center-absorb math can drift a
  // pixel or two. RIGHT_WIDTH is 300; a healthy inspector sits comfortably
  // above 280, a crushed one was ~100.
  const MIN_INSPECTOR = 280;

  function inspectorWidth(api: DockviewApi): number {
    return api.getPanel('inspector')!.group.width;
  }
  function agentWidth(api: DockviewApi): number {
    return api.getPanel('agent')!.group.width;
  }

  it('buildDefaultLayout leaves the inspector wide and the agent at its full width', () => {
    const api = makeDock();
    buildDefaultLayout(api);
    api.layout(1280, 720);
    expect(inspectorWidth(api)).toBeGreaterThanOrEqual(MIN_INSPECTOR);
    // Agent keeps roughly its intended 380 (center, not inspector, gave the room).
    expect(agentWidth(api)).toBeGreaterThanOrEqual(340);
  });

  it('keeps fresh side docks at their intended widths when built at the final wide size', () => {
    const api = makeDock(2560, 1440);
    buildDefaultLayout(api);

    expect(api.getPanel('hierarchy')!.group.width).toBeCloseTo(260, -1);
    expect(inspectorWidth(api)).toBeCloseTo(300, -1);
    expect(agentWidth(api)).toBeCloseTo(380, -1);
  });

  it('showPanel reopening a closed agent does not crush the inspector', () => {
    const api = makeDock();
    buildDefaultLayout(api);
    api.removePanel(api.getPanel('agent')!);
    showPanel(api, 'agent');
    api.layout(1280, 720);
    expect(inspectorWidth(api)).toBeGreaterThanOrEqual(MIN_INSPECTOR);
    expect(agentWidth(api)).toBeGreaterThanOrEqual(340);
  });

  it('initLayout migrating a v1 save does not crush the inspector', () => {
    // v1 default: agent tabbed inside the bottom (assets) group, inspector on the right.
    const source = makeDock();
    source.clear();
    source.addPanel({ id: 'scene', component: 'scene', title: 'Scene' });
    source.addPanel({ id: 'inspector', component: 'inspector', title: 'Inspector', position: { referencePanel: 'scene', direction: 'right' }, initialWidth: 300 });
    source.addPanel({ id: 'assets', component: 'assets', title: 'Assets', position: { referencePanel: 'scene', direction: 'below' }, initialHeight: 340 });
    source.addPanel({ id: 'agent', component: 'agent', title: 'Agent', position: { referencePanel: 'assets', direction: 'within' } });
    const key = 'hearth.layout.migrate-width';
    localStorage.setItem(key, JSON.stringify({ version: 1, layout: source.toJSON() }));

    const api = makeDock();
    initLayout(api, key);
    api.layout(1280, 720);
    expect(inspectorWidth(api)).toBeGreaterThanOrEqual(MIN_INSPECTOR);
    expect(agentWidth(api)).toBeGreaterThanOrEqual(340);
  });
});
