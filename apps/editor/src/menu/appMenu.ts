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
import { globalPlace } from '../store';
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
  { id: 'devteam', label: 'Dev team' },
  { id: 'terminal', label: 'Terminal' },
];

/**
 * The surfaces the right-hand stack can show, in View-menu order — the same
 * three the column's own tab strip offers (components/game/PaneStack.tsx), in
 * the same order.
 *
 * Tester was missing, which made this menu the app's only account of the
 * playtest column that disagreed with the column: two tabs here, three there.
 * A menu that lists some of the tabs is worse than one that lists none, since
 * the reader has no way to tell an omission from a surface that does not exist.
 */
const PANE_TABS: { id: PaneTab; label: string }[] = [
  { id: 'game', label: 'Game' },
  { id: 'tester', label: 'Tester' },
  { id: 'console', label: 'Console' },
];

export function buildAppMenu(store: AppState, ctx: AppMenuContext): AppMenuSection[] {
  const hasFolder = store.projectPath != null;
  /**
   * Everything under View is a view OF the working area, and a global screen
   * takes that area over. See `globalPlace`.
   *
   * An open folder was not enough on its own: from Skills, or from the blank
   * new-chat surface, the conversation column and the playtest column are not
   * on screen, so View > Console ticked a tab in a column nobody could see and
   * the app appeared to do nothing at all. The menu now says so the way a menu
   * says things — the item is there, and it is grey until you are somewhere it
   * means something. (Files is deliberately not gated: it opens over whatever
   * is showing, screens included.)
   */
  const inProject = hasFolder && globalPlace(store) === null;

  const file: AppMenuSection = {
    id: 'file',
    label: 'File',
    items: [
      { id: 'open-folder', label: 'Open a project…', accelerator: 'CmdOrCtrl+O', enabled: true, onSelect: ctx.onOpenFolder },
      { id: 'close-folder', label: 'Close project', enabled: hasFolder, onSelect: () => store.closeWorkspace() },
      { separator: true },
      // Not gated on a folder. Most of what settings holds is about this
      // computer rather than this project (which agent answers, the standing
      // instructions, the update check), and someone with no project open is
      // exactly the person who needs to reach it. The rail's copy of this item
      // lost the same gate for the same reason.
      { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', enabled: true, onSelect: ctx.onOpenSettings },
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
          enabled: inProject,
          checked: store.conversationMode === entry.id,
          onSelect: () => store.setConversationMode(entry.id),
        }),
      ),
      { separator: true },
      {
        id: 'pane',
        label: 'Playtest column',
        enabled: inProject,
        checked: store.paneOpen,
        onSelect: () => store.setPaneOpen(!store.paneOpen),
      },
      ...PANE_TABS.map(
        (tab): AppMenuItemModel => ({
          id: `pane:${tab.id}`,
          label: tab.label,
          // Picking a surface is a way of asking for the column, so it opens
          // one that is closed rather than checking a tab nobody can see.
          enabled: inProject,
          checked: store.paneOpen && store.paneTab === tab.id,
          onSelect: () => {
            store.setPaneTab(tab.id);
            if (!store.paneOpen) store.setPaneOpen(true);
          },
        }),
      ),
      { separator: true },
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
