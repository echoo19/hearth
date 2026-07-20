/**
 * Application menu model. The single source of truth for the editor's
 * File / Edit / View / Help menus. One `buildAppMenu` call feeds BOTH surfaces:
 *
 *  - the slim in-window menu bar in the toolbar (browser dev, and Electron on
 *    Windows/Linux) — see MenuBar.tsx;
 *  - the native macOS application menu — the renderer serializes this model and
 *    ships it over IPC, the Electron main process turns it into a real
 *    `Menu.setApplicationMenu`, and a click sends `menu:invoke <id>` back so the
 *    renderer runs the exact same `onSelect` — see menu/nativeMenu.ts and
 *    electron/appMenu.ts.
 *
 * Shortcut combos are never hardcoded here: they come from the keybind registry
 * via `keybindFor`, so a menu accelerator can't drift from the dispatcher or
 * the cheat sheet. `enabled` is derived from live store/history state so both
 * surfaces grey items out identically (e.g. Undo with empty history).
 */
import type { EditorStore } from '../store';
import { keybindFor } from '../keybinds';

export interface AppMenuItemModel {
  /** Stable id — used for IPC dispatch (menu:invoke) and tests. */
  id: string;
  label: string;
  /** Registry combo string (e.g. 'mod+z'); display via comboDisplay. */
  keybind?: string;
  enabled: boolean;
  /** Present → renders as a checkbox item (✓ gutter / native checkbox). */
  checked?: boolean;
  /** Keep the menu open after selecting (batch toggles: panels, debug). */
  keepOpen?: boolean;
  onSelect: () => void;
}

export type AppMenuEntry = AppMenuItemModel | { separator: true };

export interface AppMenuSection {
  id: 'file' | 'edit' | 'view' | 'help';
  label: string;
  items: AppMenuEntry[];
}

export function isMenuSeparator(entry: AppMenuEntry): entry is { separator: true } {
  return 'separator' in entry;
}

/** Live View-menu context (panels + layout), supplied by the workspace shell. */
export interface AppMenuViewContext {
  panels: { id: string; label: string; open: boolean }[];
  togglePanel: (id: string) => void;
  resetLayout: () => void;
  canReset: boolean;
}

/**
 * The bits `buildAppMenu` can't read off the store: history availability
 * (fetched async by useHistoryList), the modal/panel openers whose state lives
 * in the toolbar, and the dock-backed View context. Kept explicit so the model
 * stays a pure function of (store, ctx) — trivially testable.
 */
export interface AppMenuContext {
  canUndo: boolean;
  canRedo: boolean;
  onNewScene: () => void;
  onExport: () => void;
  onReview: () => void;
  openDocs: () => void;
  /** Desktop-only: ask the main process to check for app updates (null in the browser). */
  checkForUpdates: (() => void) | null;
  view: AppMenuViewContext | null;
}

/** Where Help → Documentation points. */
export const DOCS_URL = 'https://hearthengine.com';

export function buildAppMenu(store: EditorStore, ctx: AppMenuContext): AppMenuSection[] {
  const hasProject = store.info != null;

  const file: AppMenuSection = {
    id: 'file',
    label: 'File',
    items: [
      { id: 'new-scene', label: 'New scene…', enabled: hasProject, onSelect: ctx.onNewScene },
      { separator: true },
      {
        id: 'checkpoint',
        label: 'Save checkpoint',
        keybind: keybindFor('checkpoint')?.combo,
        enabled: hasProject,
        onSelect: () => void store.checkpoint(),
      },
      { id: 'review', label: 'Review changes', enabled: hasProject, onSelect: ctx.onReview },
      { separator: true },
      { id: 'export', label: 'Export…', enabled: hasProject, onSelect: ctx.onExport },
      { separator: true },
      { id: 'close-project', label: 'Close project', enabled: hasProject, onSelect: () => store.requestCloseProject() },
    ],
  };

  const edit: AppMenuSection = {
    id: 'edit',
    label: 'Edit',
    items: [
      { id: 'undo', label: 'Undo', keybind: keybindFor('undo')?.combo, enabled: ctx.canUndo, onSelect: () => void store.undo() },
      { id: 'redo', label: 'Redo', keybind: keybindFor('redo')?.combo, enabled: ctx.canRedo, onSelect: () => void store.redo() },
      { separator: true },
      {
        id: 'find-scripts',
        label: 'Find in scripts…',
        keybind: keybindFor('search-scripts')?.combo,
        enabled: hasProject,
        onSelect: () => store.requestCodeSearch(),
      },
    ],
  };

  const panelItems: AppMenuEntry[] = ctx.view
    ? ctx.view.panels.map(
        (p): AppMenuItemModel => ({
          id: `panel:${p.id}`,
          label: p.label,
          enabled: true,
          checked: p.open,
          keepOpen: true,
          onSelect: () => ctx.view?.togglePanel(p.id),
        }),
      )
    : [];

  const view: AppMenuSection = {
    id: 'view',
    label: 'View',
    items: [
      ...panelItems,
      { separator: true },
      {
        id: 'debug-overlay',
        // Scoped honestly (L-028): this overlay only affects the Game view
        // runtime (collider/velocity/light draws), not the Scene tab's gizmos.
        label: 'Game view overlay',
        enabled: hasProject,
        checked: store.debugDraw,
        keepOpen: true,
        onSelect: () => store.setDebugDraw(!store.debugDraw),
      },
      { separator: true },
      { id: 'reset-layout', label: 'Reset layout', enabled: ctx.view?.canReset ?? false, onSelect: () => ctx.view?.resetLayout() },
    ],
  };

  const help: AppMenuSection = {
    id: 'help',
    label: 'Help',
    items: [
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        keybind: keybindFor('shortcuts')?.combo,
        enabled: true,
        onSelect: () => store.setShortcutSheet(true),
      },
      { id: 'docs', label: 'Documentation', enabled: true, onSelect: ctx.openDocs },
      // Only the desktop app has something to update; the browser dev editor
      // never shows this.
      ...(ctx.checkForUpdates
        ? [{ id: 'check-updates', label: 'Check for updates…', enabled: true, onSelect: ctx.checkForUpdates }]
        : []),
    ],
  };

  return [file, edit, view, help];
}

// ---------------------------------------------------------------------------
// Serialization for the native (Electron) menu. onSelect can't cross IPC, so
// the renderer ships this shape; the main process rebuilds a real Menu and
// echoes clicks back by id. See electron/appMenu.ts for the consumer.
// ---------------------------------------------------------------------------

export interface SerializedMenuItem {
  id?: string;
  label?: string;
  accelerator?: string;
  enabled?: boolean;
  /** Only set (true/false) for checkbox items; absent for plain items. */
  checked?: boolean;
  type?: 'separator';
}

export interface SerializedMenuSection {
  label: string;
  items: SerializedMenuItem[];
}

/**
 * Convert a registry combo ('shift+mod+z') to an Electron accelerator
 * ('Shift+CmdOrCtrl+Z'). Returns undefined for keys Electron won't reliably
 * accept — accelerators here are display-only (registerAccelerator:false on the
 * main side), so a missing one just omits the hint, never breaks the menu.
 */
export function comboToAccelerator(combo: string): string | undefined {
  const toks = combo.toLowerCase().split('+');
  const key = toks[toks.length - 1];
  const mods = new Set(toks.slice(0, -1));
  const keyMap: Record<string, string> = { enter: 'Return' };
  // Single letters/digits map straight through; a couple of named keys map;
  // anything else (e.g. '/', arrows) is dropped to stay Electron-safe.
  let accelKey: string | undefined;
  if (keyMap[key]) accelKey = keyMap[key];
  else if (/^[a-z0-9]$/.test(key)) accelKey = key.toUpperCase();
  if (!accelKey) return undefined;
  const parts: string[] = [];
  if (mods.has('ctrl')) parts.push('Ctrl');
  if (mods.has('alt')) parts.push('Alt');
  if (mods.has('shift')) parts.push('Shift');
  if (mods.has('mod')) parts.push('CmdOrCtrl');
  parts.push(accelKey);
  return parts.join('+');
}

export function serializeAppMenu(sections: AppMenuSection[]): SerializedMenuSection[] {
  return sections.map((section) => ({
    label: section.label,
    items: section.items.map((entry): SerializedMenuItem => {
      if (isMenuSeparator(entry)) return { type: 'separator' };
      return {
        id: entry.id,
        label: entry.label,
        accelerator: entry.keybind ? comboToAccelerator(entry.keybind) : undefined,
        enabled: entry.enabled,
        checked: entry.checked,
      };
    }),
  }));
}
