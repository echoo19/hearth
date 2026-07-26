/**
 * "Open a folder…" — one implementation, three callers.
 *
 * The rail's nav row, Home's quiet line, and the composer's `+` menu all mean
 * the same act, so they share this. The composer can't import the rail, so it
 * asks by dispatching `hearth:open-folder` on the window; the rail is the one
 * component guaranteed to be mounted, and it is the one that listens.
 */
import { useCallback, useEffect } from 'react';
import { hearthNative } from '../../native';
import { useApp } from '../../store';

/** The event the composer's `+` menu dispatches. */
export const OPEN_FOLDER_EVENT = 'hearth:open-folder';

/**
 * Ask for a folder. The native picker in the desktop app; a prompt in a
 * browser tab, where there is no picker to open and typing a path is the only
 * honest fallback (dev only — the packaged app is always native).
 */
export async function pickFolder(): Promise<string | null> {
  const native = hearthNative();
  if (native) return native.pickDirectory();
  const typed = window.prompt('Folder path');
  return typed && typed.trim() !== '' ? typed.trim() : null;
}

/** Pick a folder and open it. Stable identity, safe to put in a dep array. */
export function useOpenFolder(): () => Promise<void> {
  const openWorkspace = useApp((s) => s.openWorkspace);
  return useCallback(async () => {
    const picked = await pickFolder();
    if (picked) await openWorkspace(picked);
  }, [openWorkspace]);
}

/**
 * Serve `hearth:open-folder` for the whole window. Mounted exactly once (the
 * rail) — two listeners would open two pickers for one click.
 */
export function useOpenFolderRequests(): void {
  const openFolder = useOpenFolder();
  useEffect(() => {
    const onRequest = (): void => void openFolder();
    window.addEventListener(OPEN_FOLDER_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_FOLDER_EVENT, onRequest);
  }, [openFolder]);
}
