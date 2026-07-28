/**
 * The app's global keyboard shortcuts, in one place.
 *
 * Renders nothing. It exists so that the three shortcuts every desktop app is
 * expected to have are declared together and can be read at a glance, rather
 * than being buried in whichever component happens to own the surface they
 * open.
 *
 * Each one asks through the window event the rail already listens for, which
 * keeps this layer out of the business of knowing where the settings panel or
 * the search field actually live. The modifier is resolved per platform in
 * `shortcuts.ts`, so these work as Command on a Mac and as Control on Windows
 * without either being named here.
 */
import { useApp } from '../../store';
import { SHORTCUTS } from '../../shortcuts';
import { useShortcut } from '../../useShortcut';
import { OPEN_SETTINGS_EVENT } from './SettingsDialog';
import { OPEN_FOLDER_EVENT } from './useOpenFolder';

/** Ask the rail to open its search and put the cursor in it. */
export const FOCUS_SEARCH_EVENT = 'hearth:focus-search';

export function ShortcutLayer() {
  const newChat = useApp((s) => s.newChat);
  const hasFolder = useApp((s) => s.projectPath !== null);
  const peekOpen = useApp((s) => s.codePeek.open);
  const openCodePeek = useApp((s) => s.openCodePeek);
  const closeCodePeek = useApp((s) => s.closeCodePeek);

  useShortcut(SHORTCUTS.search, () => {
    window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT));
  });

  useShortcut(SHORTCUTS.newChat, () => {
    newChat();
  });

  useShortcut(SHORTCUTS.settings, () => {
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
  });

  useShortcut(SHORTCUTS.openFolder, () => {
    window.dispatchEvent(new CustomEvent(OPEN_FOLDER_EVENT));
  });

  // Files is a view of the open project, so it is bound only when there is
  // one. The menu greys the item out in the same case.
  useShortcut(
    SHORTCUTS.files,
    () => {
      if (peekOpen) closeCodePeek();
      else openCodePeek();
    },
    hasFolder,
  );

  return null;
}
