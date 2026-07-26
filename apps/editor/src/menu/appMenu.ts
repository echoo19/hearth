/**
 * Application menu model — the single source of truth for the app's
 * File / View / Help menus.
 *
 * The renderer builds this model, serializes it, and ships it over IPC; the
 * Electron main process turns it into a real `Menu.setApplicationMenu` and
 * echoes a click back as `menu:invoke <id>`, where the same `onSelect` runs
 * (see menu/nativeMenu.ts and electron/appMenu.ts). The standard Edit and
 * Window menus are supplied by Electron itself, so this model only carries
 * what is genuinely Hearth's.
 */
import type { AppState, ConversationMode, PaneTab } from '../store';

export interface AppMenuItemModel {
  /** Stable id — used for IPC dispatch (menu:invoke) and tests. */
  id: string;
  label: string;
  /** Display-only accelerator hint, e.g. 'CmdOrCtrl+O'. */
  accelerator?: string;
  enabled: boolean;
  /** Present → renders as a checkbox item. */
  checked?: boolean;
  onSelect: () => void;
}

export type AppMenuEntry = AppMenuItemModel | { separator: true };

export interface AppMenuSection {
  id: 'file' | 'view' | 'help';
  label: string;
  items: AppMenuEntry[];
}

export function isMenuSeparator(entry: AppMenuEntry): entry is { separator: true } {
  return 'separator' in entry;
}

/**
 * The bits `buildAppMenu` can't read off the store: the native folder picker
 * and the update check, both of which live outside React state.
 */
export interface AppMenuContext {
  onOpenFolder: () => void;
  onOpenSettings: () => void;
  openDocs: () => void;
  /** Desktop-only; null in the browser. */
  checkForUpdates: (() => void) | null;
}

/** Where Help → Documentation points. */
export const DOCS_URL = 'https://hearthengine.com';

/** What the conversation column can be, in View-menu order. */
const CONVERSATION_MODES: { id: ConversationMode; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'terminal', label: 'Terminal' },
];

/** The two surfaces the right-hand stack can show, in View-menu order. */
const PANE_TABS: { id: PaneTab; label: string }[] = [
  { id: 'game', label: 'Game' },
  { id: 'console', label: 'Console' },
];

export function buildAppMenu(store: AppState, ctx: AppMenuContext): AppMenuSection[] {
  const hasFolder = store.projectPath != null;

  const file: AppMenuSection = {
    id: 'file',
    label: 'File',
    items: [
      { id: 'open-folder', label: 'Open folder…', accelerator: 'CmdOrCtrl+O', enabled: true, onSelect: ctx.onOpenFolder },
      { id: 'close-folder', label: 'Close folder', enabled: hasFolder, onSelect: () => store.closeWorkspace() },
      { separator: true },
      { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', enabled: hasFolder, onSelect: ctx.onOpenSettings },
    ],
  };

  const view: AppMenuSection = {
    id: 'view',
    label: 'View',
    items: [
      // The conversation column first — it is the primary surface, and the
      // terminal is only reachable from here now that it isn't a pane tab.
      ...CONVERSATION_MODES.map(
        (entry): AppMenuItemModel => ({
          id: `mode:${entry.id}`,
          label: entry.label,
          enabled: hasFolder,
          checked: store.conversationMode === entry.id,
          onSelect: () => store.setConversationMode(entry.id),
        }),
      ),
      { separator: true },
      ...PANE_TABS.map(
        (tab): AppMenuItemModel => ({
          id: `pane:${tab.id}`,
          label: tab.label,
          enabled: hasFolder,
          checked: store.paneTab === tab.id,
          onSelect: () => store.setPaneTab(tab.id),
        }),
      ),
      { separator: true },
      {
        id: 'evidence',
        label: 'Playtests',
        enabled: hasFolder,
        checked: store.evidenceOpen,
        onSelect: () => store.setEvidenceOpen(!store.evidenceOpen),
      },
      {
        id: 'files',
        label: 'Files',
        accelerator: 'CmdOrCtrl+P',
        enabled: hasFolder,
        checked: store.codePeek.open,
        onSelect: () => (store.codePeek.open ? store.closeCodePeek() : store.openCodePeek()),
      },
    ],
  };

  const help: AppMenuSection = {
    id: 'help',
    label: 'Help',
    items: [
      { id: 'docs', label: 'Documentation', enabled: true, onSelect: ctx.openDocs },
      ...(ctx.checkForUpdates
        ? [{ id: 'check-updates', label: 'Check for updates…', enabled: true, onSelect: ctx.checkForUpdates }]
        : []),
    ],
  };

  return [file, view, help];
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

export function serializeAppMenu(sections: AppMenuSection[]): SerializedMenuSection[] {
  return sections.map((section) => ({
    label: section.label,
    items: section.items.map((entry): SerializedMenuItem => {
      if (isMenuSeparator(entry)) return { type: 'separator' };
      return {
        id: entry.id,
        label: entry.label,
        accelerator: entry.accelerator,
        enabled: entry.enabled,
        checked: entry.checked,
      };
    }),
  }));
}
