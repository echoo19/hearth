/**
 * Application menu model.
 *
 * buildAppMenu is a pure function of (store, ctx); these tests pin the
 * enabled-state logic, the checkbox reflection, that every shortcut string
 * comes from the keybind registry (never hardcoded), and that serialization
 * for the native menu drops onSelect and converts combos to accelerators.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildAppMenu,
  serializeAppMenu,
  comboToAccelerator,
  isMenuSeparator,
  type AppMenuContext,
  type AppMenuSection,
  type AppMenuItemModel,
} from '../src/menu/appMenu';
import { KEYBINDS, canonicalCombo } from '../src/keybinds';
import type { EditorStore } from '../src/store';

function mockStore(over: Partial<EditorStore> = {}): EditorStore {
  return {
    info: { id: 'p', name: 'Demo', scenes: [] },
    debugDraw: false,
    checkpoint: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    closeProject: vi.fn(),
    requestCloseProject: vi.fn(),
    requestCodeSearch: vi.fn(),
    setDebugDraw: vi.fn(),
    setShortcutSheet: vi.fn(),
    ...over,
  } as unknown as EditorStore;
}

function baseCtx(over: Partial<AppMenuContext> = {}): AppMenuContext {
  return {
    canUndo: true,
    canRedo: true,
    onNewScene: vi.fn(),
    onExport: vi.fn(),
    onReview: vi.fn(),
    openDocs: vi.fn(),
    checkForUpdates: null,
    view: {
      panels: [
        { id: 'hierarchy', label: 'Hierarchy', open: true },
        { id: 'inspector', label: 'Inspector', open: false },
      ],
      togglePanel: vi.fn(),
      resetLayout: vi.fn(),
      canReset: true,
      workspaceTemplate: null,
      applyWorkspace: vi.fn(),
    },
    ...over,
  };
}

function allItems(sections: AppMenuSection[]): AppMenuItemModel[] {
  return sections.flatMap((s) => s.items).filter((e): e is AppMenuItemModel => !isMenuSeparator(e));
}

function findItem(sections: AppMenuSection[], id: string): AppMenuItemModel {
  const item = allItems(sections).find((i) => i.id === id);
  if (!item) throw new Error(`no menu item ${id}`);
  return item;
}

describe('buildAppMenu — structure', () => {
  it('has File / Edit / View / Help sections in order', () => {
    const sections = buildAppMenu(mockStore(), baseCtx());
    expect(sections.map((s) => s.id)).toEqual(['file', 'edit', 'view', 'help']);
  });

  it('surfaces the moved-off-toolbar actions under File', () => {
    const sections = buildAppMenu(mockStore(), baseCtx());
    const fileIds = sections[0].items.filter((e) => !isMenuSeparator(e)).map((e) => (e as AppMenuItemModel).id);
    expect(fileIds).toEqual(['new-scene', 'checkpoint', 'review', 'export', 'close-project']);
  });
});

describe('buildAppMenu — enabled-state logic', () => {
  it('disables Undo when history is empty', () => {
    const sections = buildAppMenu(mockStore(), baseCtx({ canUndo: false }));
    expect(findItem(sections, 'undo').enabled).toBe(false);
  });

  it('enables Undo when history has an entry', () => {
    const sections = buildAppMenu(mockStore(), baseCtx({ canUndo: true }));
    expect(findItem(sections, 'undo').enabled).toBe(true);
  });

  it('disables project-scoped items when no project is open', () => {
    const sections = buildAppMenu(mockStore({ info: null }), baseCtx());
    for (const id of ['new-scene', 'checkpoint', 'review', 'export', 'close-project', 'find-scripts', 'debug-overlay']) {
      expect(findItem(sections, id).enabled).toBe(false);
    }
  });

  it('keeps Help items enabled with no project open', () => {
    const sections = buildAppMenu(mockStore({ info: null }), baseCtx({ view: null }));
    expect(findItem(sections, 'shortcuts').enabled).toBe(true);
    expect(findItem(sections, 'docs').enabled).toBe(true);
  });

  it('disables Reset layout when there is no view context', () => {
    const sections = buildAppMenu(mockStore(), baseCtx({ view: null }));
    expect(findItem(sections, 'reset-layout').enabled).toBe(false);
  });
});

describe('buildAppMenu — View section', () => {
  it('renders one checkbox per panel reflecting its open state', () => {
    const sections = buildAppMenu(mockStore(), baseCtx());
    const hierarchy = findItem(sections, 'panel:hierarchy');
    const inspector = findItem(sections, 'panel:inspector');
    expect(hierarchy.checked).toBe(true);
    expect(hierarchy.keepOpen).toBe(true);
    expect(inspector.checked).toBe(false);
  });

  it('reflects debugDraw as the Debug overlay checkbox', () => {
    expect(findItem(buildAppMenu(mockStore({ debugDraw: true }), baseCtx()), 'debug-overlay').checked).toBe(true);
    expect(findItem(buildAppMenu(mockStore({ debugDraw: false }), baseCtx()), 'debug-overlay').checked).toBe(false);
  });

  it('places the workspace items between the debug-overlay separator and reset-layout', () => {
    const sections = buildAppMenu(mockStore(), baseCtx());
    const view = sections.find((s) => s.id === 'view')!;
    const ids = view.items.map((e) => (isMenuSeparator(e) ? '---' : e.id));
    const debugIdx = ids.indexOf('debug-overlay');
    const agentIdx = ids.indexOf('workspace-agent');
    const studioIdx = ids.indexOf('workspace-studio');
    const resetIdx = ids.indexOf('reset-layout');
    // debug-overlay, separator, workspace-agent, workspace-studio, separator, reset-layout
    expect(ids[debugIdx + 1]).toBe('---');
    expect(agentIdx).toBe(debugIdx + 2);
    expect(studioIdx).toBe(agentIdx + 1);
    expect(ids[studioIdx + 1]).toBe('---');
    expect(resetIdx).toBe(studioIdx + 2);
  });

  it('checks the workspace item matching the current template', () => {
    const agentSections = buildAppMenu(mockStore(), baseCtx({ view: { ...baseCtx().view!, workspaceTemplate: 'agent' } }));
    expect(findItem(agentSections, 'workspace-agent').checked).toBe(true);
    expect(findItem(agentSections, 'workspace-studio').checked).toBe(false);

    const studioSections = buildAppMenu(mockStore(), baseCtx({ view: { ...baseCtx().view!, workspaceTemplate: 'studio' } }));
    expect(findItem(studioSections, 'workspace-agent').checked).toBe(false);
    expect(findItem(studioSections, 'workspace-studio').checked).toBe(true);

    const nullSections = buildAppMenu(mockStore(), baseCtx({ view: { ...baseCtx().view!, workspaceTemplate: null } }));
    expect(findItem(nullSections, 'workspace-agent').checked).toBe(false);
    expect(findItem(nullSections, 'workspace-studio').checked).toBe(false);
  });

  it('disables both workspace items when there is no view context', () => {
    const sections = buildAppMenu(mockStore(), baseCtx({ view: null }));
    expect(findItem(sections, 'workspace-agent').enabled).toBe(false);
    expect(findItem(sections, 'workspace-studio').enabled).toBe(false);
  });
});

describe('buildAppMenu — workspace switching', () => {
  it('routes selecting a workspace item through applyWorkspace with the matching template', () => {
    const applyWorkspace = vi.fn();
    const ctx = baseCtx({ view: { ...baseCtx().view!, applyWorkspace } });
    const sections = buildAppMenu(mockStore(), ctx);
    findItem(sections, 'workspace-agent').onSelect();
    expect(applyWorkspace).toHaveBeenCalledWith('agent');
    findItem(sections, 'workspace-studio').onSelect();
    expect(applyWorkspace).toHaveBeenCalledWith('studio');
  });
});

describe('buildAppMenu — onSelect wiring', () => {
  it('routes Undo/Redo through the store (one code path with the keybinds)', () => {
    const store = mockStore();
    const sections = buildAppMenu(store, baseCtx());
    findItem(sections, 'undo').onSelect();
    findItem(sections, 'redo').onSelect();
    expect(store.undo).toHaveBeenCalledTimes(1);
    expect(store.redo).toHaveBeenCalledTimes(1);
  });

  it('toggles Debug overlay to the inverse of the current state', () => {
    const store = mockStore({ debugDraw: false });
    findItem(buildAppMenu(store, baseCtx()), 'debug-overlay').onSelect();
    expect(store.setDebugDraw).toHaveBeenCalledWith(true);
  });

  it('opens the shortcut sheet from Help', () => {
    const store = mockStore();
    findItem(buildAppMenu(store, baseCtx()), 'shortcuts').onSelect();
    expect(store.setShortcutSheet).toHaveBeenCalledWith(true);
  });
});

describe('buildAppMenu — shortcuts come from the registry', () => {
  it('every item keybind matches a real KEYBINDS combo', () => {
    const withKeybind = allItems(buildAppMenu(mockStore(), baseCtx())).filter((i) => i.keybind);
    // At least the ones we expect to carry accelerators.
    expect(withKeybind.map((i) => i.id).sort()).toEqual(['checkpoint', 'find-scripts', 'redo', 'shortcuts', 'undo']);
    for (const item of withKeybind) {
      const combo = canonicalCombo(item.keybind!);
      expect(KEYBINDS.some((b) => canonicalCombo(b.combo) === combo)).toBe(true);
    }
  });
});

describe('serializeAppMenu', () => {
  it('drops onSelect, keeps ids/labels, and converts combos to accelerators', () => {
    const serialized = serializeAppMenu(buildAppMenu(mockStore(), baseCtx()));
    const flat = serialized.flatMap((s) => s.items);
    const undo = flat.find((i) => i.id === 'undo')!;
    expect(undo).not.toHaveProperty('onSelect');
    expect(undo.accelerator).toBe('CmdOrCtrl+Z');
    const checkpoint = flat.find((i) => i.id === 'checkpoint')!;
    expect(checkpoint.accelerator).toBe('Shift+CmdOrCtrl+S');
    expect(serialized[0].items.some((i) => i.type === 'separator')).toBe(true);
  });

  it('carries checked for the workspace items', () => {
    const ctx = baseCtx({ view: { ...baseCtx().view!, workspaceTemplate: 'agent' } });
    const serialized = serializeAppMenu(buildAppMenu(mockStore(), ctx));
    const flat = serialized.flatMap((s) => s.items);
    const agentItem = flat.find((i) => i.id === 'workspace-agent')!;
    const studioItem = flat.find((i) => i.id === 'workspace-studio')!;
    expect(agentItem.checked).toBe(true);
    expect(studioItem.checked).toBe(false);
  });
});

describe('comboToAccelerator', () => {
  it('maps modifiers and letter keys', () => {
    expect(comboToAccelerator('mod+z')).toBe('CmdOrCtrl+Z');
    expect(comboToAccelerator('shift+mod+z')).toBe('Shift+CmdOrCtrl+Z');
    expect(comboToAccelerator('mod+enter')).toBe('CmdOrCtrl+Return');
  });

  it('returns undefined for keys Electron cannot safely accept', () => {
    expect(comboToAccelerator('shift+/')).toBeUndefined();
  });
});

describe('buildAppMenu — Check for updates (desktop only)', () => {
  it('appears under Help and runs the native check when available', () => {
    const check = vi.fn();
    const sections = buildAppMenu(mockStore(), baseCtx({ checkForUpdates: check }));
    const help = sections.find((s) => s.id === 'help');
    const item = help?.items.find((e): e is AppMenuItemModel => !isMenuSeparator(e) && e.id === 'check-updates');
    expect(item, 'Help → Check for updates… missing').toBeTruthy();
    expect(item!.enabled).toBe(true);
    item!.onSelect();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('is absent in browser mode, where there is nothing to update', () => {
    const sections = buildAppMenu(mockStore(), baseCtx());
    expect(allItems(sections).some((i) => i.id === 'check-updates')).toBe(false);
  });
});
