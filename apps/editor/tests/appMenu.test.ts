/**
 * Application menu model.
 *
 * `buildAppMenu` is a pure function of (store, ctx); these pin the
 * enabled-state logic, the checkbox reflection of live pane/drawer state, and
 * that serialization for the native menu drops onSelect while keeping ids.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildAppMenu,
  serializeAppMenu,
  isMenuSeparator,
  type AppMenuContext,
  type AppMenuItemModel,
  type AppMenuSection,
} from '../src/menu/appMenu';
import type { AppState } from '../src/store';

function mockStore(over: Partial<AppState> = {}): AppState {
  return {
    projectPath: '/work/game',
    paneTab: 'game',
    evidenceOpen: true,
    codePeek: { open: false, path: null },
    closeWorkspace: vi.fn(),
    setPaneTab: vi.fn(),
    setEvidenceOpen: vi.fn(),
    openCodePeek: vi.fn(),
    closeCodePeek: vi.fn(),
    ...over,
  } as unknown as AppState;
}

function baseCtx(over: Partial<AppMenuContext> = {}): AppMenuContext {
  return {
    onOpenFolder: vi.fn(),
    onOpenSettings: vi.fn(),
    openDocs: vi.fn(),
    checkForUpdates: null,
    ...over,
  };
}

function items(sections: AppMenuSection[], id: AppMenuSection['id']): AppMenuItemModel[] {
  return sections
    .find((section) => section.id === id)!
    .items.filter((entry): entry is AppMenuItemModel => !isMenuSeparator(entry));
}

function item(sections: AppMenuSection[], id: string): AppMenuItemModel {
  for (const section of sections) {
    for (const entry of section.items) {
      if (!isMenuSeparator(entry) && entry.id === id) return entry;
    }
  }
  throw new Error(`no menu item "${id}"`);
}

describe('buildAppMenu', () => {
  it('carries only Hearth-owned menus — Edit and Window are Electron roles', () => {
    const sections = buildAppMenu(mockStore(), baseCtx());
    expect(sections.map((section) => section.id)).toEqual(['file', 'view', 'help']);
  });

  it('leaves Open folder available with no folder open, but disables the rest', () => {
    const sections = buildAppMenu(mockStore({ projectPath: null }), baseCtx());
    expect(item(sections, 'open-folder').enabled).toBe(true);
    expect(item(sections, 'close-folder').enabled).toBe(false);
    expect(item(sections, 'settings').enabled).toBe(false);
    for (const entry of items(sections, 'view')) expect(entry.enabled).toBe(false);
  });

  it('checks the current pane and nothing else', () => {
    const sections = buildAppMenu(mockStore({ paneTab: 'terminal' }), baseCtx());
    expect(item(sections, 'pane:game').checked).toBe(false);
    expect(item(sections, 'pane:terminal').checked).toBe(true);
    expect(item(sections, 'pane:console').checked).toBe(false);
  });

  it('reflects the evidence rail and code peek as checkboxes', () => {
    const sections = buildAppMenu(
      mockStore({ evidenceOpen: false, codePeek: { open: true, path: 'src/game.js' } }),
      baseCtx(),
    );
    expect(item(sections, 'evidence').checked).toBe(false);
    expect(item(sections, 'files').checked).toBe(true);
  });

  it('routes a pane selection to the store', () => {
    const setPaneTab = vi.fn();
    const sections = buildAppMenu(mockStore({ setPaneTab }), baseCtx());
    item(sections, 'pane:console').onSelect();
    expect(setPaneTab).toHaveBeenCalledWith('console');
  });

  it('toggles the code peek closed when it is already open', () => {
    const openCodePeek = vi.fn();
    const closeCodePeek = vi.fn();
    const open = buildAppMenu(
      mockStore({ codePeek: { open: true, path: null }, openCodePeek, closeCodePeek }),
      baseCtx(),
    );
    item(open, 'files').onSelect();
    expect(closeCodePeek).toHaveBeenCalled();
    expect(openCodePeek).not.toHaveBeenCalled();
  });

  it('omits the update check outside the desktop app', () => {
    const browser = buildAppMenu(mockStore(), baseCtx({ checkForUpdates: null }));
    expect(browser.find((s) => s.id === 'help')!.items.some((e) => !isMenuSeparator(e) && e.id === 'check-updates')).toBe(
      false,
    );
    const desktop = buildAppMenu(mockStore(), baseCtx({ checkForUpdates: vi.fn() }));
    expect(item(desktop, 'check-updates').enabled).toBe(true);
  });
});

describe('serializeAppMenu', () => {
  it('keeps ids, labels, accelerators, enabled and checked — and drops onSelect', () => {
    const serialized = serializeAppMenu(buildAppMenu(mockStore(), baseCtx()));
    const file = serialized.find((section) => section.label === 'File')!;
    const openFolder = file.items.find((entry) => entry.id === 'open-folder')!;
    expect(openFolder).toEqual({
      id: 'open-folder',
      label: 'Open folder…',
      accelerator: 'CmdOrCtrl+O',
      enabled: true,
      checked: undefined,
    });
    expect(JSON.stringify(serialized)).not.toContain('onSelect');
  });

  it('preserves separators as separator entries', () => {
    const serialized = serializeAppMenu(buildAppMenu(mockStore(), baseCtx()));
    const file = serialized.find((section) => section.label === 'File')!;
    expect(file.items.some((entry) => entry.type === 'separator')).toBe(true);
  });

  it('marks checkbox items with a boolean and plain items with undefined', () => {
    const serialized = serializeAppMenu(buildAppMenu(mockStore({ paneTab: 'game' }), baseCtx()));
    const view = serialized.find((section) => section.label === 'View')!;
    expect(view.items.find((entry) => entry.id === 'pane:game')!.checked).toBe(true);
    const help = serialized.find((section) => section.label === 'Help')!;
    expect(help.items.find((entry) => entry.id === 'docs')!.checked).toBeUndefined();
  });
});
