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
    conversationMode: 'chat',
    paneTab: 'game',
    paneOpen: true,
    // Where the app is standing — View's items are about the working area, and
    // a global screen takes that area over. Null/false is "inside a project",
    // which is what every case below assumes unless it says otherwise.
    screen: null,
    composing: false,
    codePeek: { open: false, path: null },
    closeWorkspace: vi.fn(),
    setConversationMode: vi.fn(),
    setPaneTab: vi.fn(),
    setPaneOpen: vi.fn(),
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

  it('leaves the two things that do not need a folder available, and disables the rest', () => {
    const sections = buildAppMenu(mockStore({ projectPath: null }), baseCtx());
    expect(item(sections, 'open-folder').enabled).toBe(true);
    // Settings is mostly about this computer rather than this project: which
    // agent answers, the standing instructions, the update check. Someone with
    // no project open is exactly the person who needs to reach it.
    expect(item(sections, 'settings').enabled).toBe(true);
    expect(item(sections, 'close-folder').enabled).toBe(false);
    for (const entry of items(sections, 'view')) expect(entry.enabled).toBe(false);
  });

  it('checks the current pane and nothing else', () => {
    const sections = buildAppMenu(mockStore({ paneTab: 'console' }), baseCtx());
    expect(item(sections, 'pane:game').checked).toBe(false);
    expect(item(sections, 'pane:console').checked).toBe(true);
  });

  it('offers the surfaces the pane stack actually has — the shell is not one of them', () => {
    const sections = buildAppMenu(mockStore(), baseCtx());
    const ids = items(sections, 'view').map((entry) => entry.id);
    // All three tabs the column really has, or the menu is the app's one
    // account of that column that disagrees with the column.
    expect(ids).toContain('pane:game');
    expect(ids).toContain('pane:tester');
    expect(ids).toContain('pane:console');
    expect(ids).not.toContain('pane:terminal');
  });

  /**
   * A global screen (Skills, Tester) and the blank new-chat surface take the
   * whole working area. Neither the conversation column nor the playtest
   * column is on screen there, so every View item that moves one of them would
   * move something nobody can see: the app appeared to do nothing at all.
   */
  describe('View while the working area is covered', () => {
    for (const [what, over] of [
      ['the Skills screen', { screen: 'skills' as const }],
      ['the Tester screen', { screen: 'tester' as const }],
      ['the blank new-chat surface', { composing: true }],
    ] as const) {
      it(`greys the column items on ${what}, folder open or not`, () => {
        const sections = buildAppMenu(mockStore(over), baseCtx());
        expect(item(sections, 'mode:chat').enabled).toBe(false);
        expect(item(sections, 'mode:terminal').enabled).toBe(false);
        expect(item(sections, 'pane').enabled).toBe(false);
        expect(item(sections, 'pane:game').enabled).toBe(false);
        expect(item(sections, 'pane:tester').enabled).toBe(false);
        expect(item(sections, 'pane:console').enabled).toBe(false);
      });
    }

    it('keeps Files reachable, because it opens over whatever is showing', () => {
      const sections = buildAppMenu(mockStore({ screen: 'skills' }), baseCtx());
      expect(item(sections, 'files').enabled).toBe(true);
    });

    it('keeps Close project reachable — not current is not the same as not open', () => {
      const sections = buildAppMenu(mockStore({ screen: 'skills' }), baseCtx());
      expect(item(sections, 'close-folder').enabled).toBe(true);
    });
  });

  it('checks the current conversation mode — the terminal is reachable from View', () => {
    const chat = buildAppMenu(mockStore({ conversationMode: 'chat' }), baseCtx());
    expect(item(chat, 'mode:chat').checked).toBe(true);
    expect(item(chat, 'mode:terminal').checked).toBe(false);

    const terminal = buildAppMenu(mockStore({ conversationMode: 'terminal' }), baseCtx());
    expect(item(terminal, 'mode:chat').checked).toBe(false);
    expect(item(terminal, 'mode:terminal').checked).toBe(true);
  });

  it('routes a conversation-mode selection to the store', () => {
    const setConversationMode = vi.fn();
    const sections = buildAppMenu(mockStore({ setConversationMode }), baseCtx());
    item(sections, 'mode:terminal').onSelect();
    expect(setConversationMode).toHaveBeenCalledWith('terminal');
  });

  it('reflects code peek as a checkbox', () => {
    const sections = buildAppMenu(
      mockStore({ codePeek: { open: true, path: 'src/game.js' } }),
      baseCtx(),
    );
    expect(item(sections, 'files').checked).toBe(true);
  });

  it('routes a pane selection to the store', () => {
    const setPaneTab = vi.fn();
    const sections = buildAppMenu(mockStore({ setPaneTab }), baseCtx());
    item(sections, 'pane:console').onSelect();
    expect(setPaneTab).toHaveBeenCalledWith('console');
  });

  it('opens the playtest column when a surface is picked while it is closed', () => {
    // Otherwise View > Console ticks a tab in a column nobody can see.
    const setPaneOpen = vi.fn();
    const sections = buildAppMenu(mockStore({ paneOpen: false, setPaneOpen }), baseCtx());
    item(sections, 'pane:console').onSelect();
    expect(setPaneOpen).toHaveBeenCalledWith(true);
  });

  it('leaves an already-open column alone', () => {
    const setPaneOpen = vi.fn();
    const sections = buildAppMenu(mockStore({ paneOpen: true, setPaneOpen }), baseCtx());
    item(sections, 'pane:game').onSelect();
    expect(setPaneOpen).not.toHaveBeenCalled();
  });

  it('shows no surface as current while the column is closed', () => {
    const sections = buildAppMenu(mockStore({ paneOpen: false, paneTab: 'game' }), baseCtx());
    expect(item(sections, 'pane:game').checked).toBe(false);
    expect(item(sections, 'pane').checked).toBe(false);
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
      label: 'Open a project…',
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
    const serialized = serializeAppMenu(buildAppMenu(mockStore({ paneTab: 'game', paneOpen: true }), baseCtx()));
    const view = serialized.find((section) => section.label === 'View')!;
    expect(view.items.find((entry) => entry.id === 'pane:game')!.checked).toBe(true);
    const help = serialized.find((section) => section.label === 'Help')!;
    expect(help.items.find((entry) => entry.id === 'docs')!.checked).toBeUndefined();
  });
});
