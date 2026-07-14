import { useEffect, useState } from 'react';
import type { DockviewApi } from 'dockview-react';

/**
 * The set of panel ids currently open in the dock. Kept honest while the user
 * drags/closes panels with the menu closed by subscribing to dockview's
 * add/remove/layout events. Extracted from the old ViewMenu so the View
 * section of the application menu (appMenu.ts) can drive its panel checkboxes.
 */
export function useOpenPanels(dock: DockviewApi | null): ReadonlySet<string> {
  const [openPanels, setOpenPanels] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!dock) {
      setOpenPanels(new Set());
      return;
    }
    const update = () => setOpenPanels(new Set(dock.panels.map((p) => p.id)));
    update();
    const disposables = [dock.onDidAddPanel(update), dock.onDidRemovePanel(update), dock.onDidLayoutFromJSON(update)];
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [dock]);
  return openPanels;
}
