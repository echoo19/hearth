/**
 * Native application menu bridge (Electron). Ships the serialized menu model
 * to the main process so it can build a real `Menu.setApplicationMenu`, and
 * dispatches a native-menu click (echoed back as `menu:invoke <id>`) to the
 * live `onSelect` of the matching model item. No-op in the browser, which has
 * no application menu to install.
 */
import { useEffect, useMemo, useRef } from 'react';
import { hearthNative } from '../native';
import { useApp } from '../store';
import { buildAppMenu, serializeAppMenu, isMenuSeparator, DOCS_URL, type AppMenuSection } from './appMenu';

export function useNativeAppMenu(sections: AppMenuSection[]): void {
  // Every Electron platform, not just macOS: `Menu.setApplicationMenu` renders
  // as the macOS menu bar and as the window menu bar on Windows/Linux, and the
  // app no longer ships an in-window bar to fall back to.
  const native = hearthNative();
  const hasNativeMenu = native?.setAppMenu != null;

  // The live model, read at click time so a stale closure never fires an
  // outdated handler.
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  // menu:invoke <id> → the matching item's onSelect.
  useEffect(() => {
    if (!hasNativeMenu || !native?.onMenuInvoke) return;
    return native.onMenuInvoke((id) => {
      for (const section of sectionsRef.current) {
        for (const entry of section.items) {
          if (!isMenuSeparator(entry) && entry.id === id) {
            entry.onSelect();
            return;
          }
        }
      }
    });
  }, [hasNativeMenu, native]);

  // Push the serialized model whenever enabled/checked/labels change. The JSON
  // diff keeps this to one IPC call per actual change, not per render.
  const json = useMemo(() => JSON.stringify(serializeAppMenu(sections)), [sections]);
  useEffect(() => {
    if (!native?.setAppMenu) return;
    native.setAppMenu(JSON.parse(json));
  }, [native, json]);

  // Restore the baseline (app menu only) when the shell unmounts / the folder
  // closes — separate from the update effect so a model change doesn't flicker
  // through null.
  useEffect(() => {
    if (!native?.setAppMenu) return;
    return () => native.setAppMenu?.(null);
  }, [native]);
}

/**
 * Build the app menu from live store state and install it. One call from the
 * shell; re-subscribes on every field the menu reflects (open folder, current
 * pane, drawer states) so checkmarks and enabled states never drift.
 */
export function useNativeMenu(): void {
  const native = hearthNative();
  const projectPath = useApp((s) => s.projectPath);
  const conversationMode = useApp((s) => s.conversationMode);
  const paneTab = useApp((s) => s.paneTab);
  const codePeekOpen = useApp((s) => s.codePeek.open);

  const sections = useMemo(
    () =>
      buildAppMenu(useApp.getState(), {
        onOpenFolder: () => {
          void (async () => {
            const picked = await native?.pickDirectory();
            if (picked) await useApp.getState().openWorkspace(picked);
          })();
        },
        onOpenSettings: () => window.dispatchEvent(new CustomEvent('hearth:open-settings')),
        openDocs: () => window.open(DOCS_URL, '_blank', 'noopener'),
        checkForUpdates: native?.checkForUpdates ? () => void native.checkForUpdates?.() : null,
      }),
    // The store fields the model reads; getState() inside supplies the rest.
    [native, projectPath, conversationMode, paneTab, codePeekOpen],
  );

  useNativeAppMenu(sections);
}
