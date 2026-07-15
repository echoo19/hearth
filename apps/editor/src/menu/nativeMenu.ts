/**
 * Native application menu bridge (Electron, macOS). Ships the serialized menu
 * model to the main process so it can build a real `Menu.setApplicationMenu`,
 * and dispatches a native-menu click (echoed back as `menu:invoke <id>`) to the
 * live `onSelect` of the matching model item — the same handler the in-window
 * bar runs. No-op in the browser and on Windows/Linux (which use the in-window
 * MenuBar instead).
 */
import { useEffect, useMemo, useRef } from 'react';
import { hearthNative } from '../native';
import { serializeAppMenu, isMenuSeparator, type AppMenuSection } from './appMenu';

export function useNativeAppMenu(sections: AppMenuSection[]): void {
  const native = hearthNative();
  const isMac = native?.platform === 'darwin';

  // The live model, read at click time so a stale closure never fires an
  // outdated handler.
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  // menu:invoke <id> → the matching item's onSelect.
  useEffect(() => {
    if (!isMac || !native?.onMenuInvoke) return;
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
  }, [isMac, native]);

  // Push the serialized model whenever enabled/checked/labels change. The JSON
  // diff keeps this to one IPC call per actual change, not per render.
  const json = useMemo(() => JSON.stringify(serializeAppMenu(sections)), [sections]);
  useEffect(() => {
    if (!isMac || !native?.setAppMenu) return;
    native.setAppMenu(JSON.parse(json));
  }, [isMac, native, json]);

  // Restore the baseline (app menu only) when the editor unmounts / project
  // closes — separate from the update effect so a model change doesn't flicker
  // through null.
  useEffect(() => {
    if (!isMac || !native?.setAppMenu) return;
    return () => native.setAppMenu?.(null);
  }, [isMac, native]);
}

/**
 * Whether the in-window menu bar should render: browser, non-macOS Electron, or
 * a macOS build whose preload does NOT expose the native-menu API. That last
 * case (e.g. a stale preload after an app update) can't install the native
 * macOS menu via `setAppMenu`, so the in-window bar must take over — otherwise
 * the user is stranded with no File/Edit/View/Help at all. This is also the
 * path that surfaces the in-window popover on a packaged macOS app, so its
 * dropdowns must be viewport-clamped (see MenuButton/menuDropdownPosition).
 */
export function useShowInWindowMenuBar(): boolean {
  const native = hearthNative();
  return !native || native.platform !== 'darwin' || !native.setAppMenu;
}
