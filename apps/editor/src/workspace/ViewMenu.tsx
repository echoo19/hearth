/**
 * Toolbar "View" menu: one checkbox per workspace panel (open/close) plus
 * "Reset layout" and "Keyboard shortcuts". Popover mechanics (open/close,
 * click-outside, Escape, arrow-key focus) come from the shared MenuButton
 * primitive; this file only declares the items. Panel-toggle items keep the
 * menu open (closeOnSelect: false) so several panels can be toggled in a row.
 */
import React, { useEffect, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { PANEL_TITLES, VIEW_MENU_PANELS, resetLayout, showPanel } from './Workspace';
import type { PanelId } from './layout';
import { useEditor } from '../store';
import { comboDisplay } from '../keybinds';
import { MenuButton, type MenuItem } from '../components/ui/Menu';

export function ViewMenu({ dock, storageKey }: { dock: DockviewApi | null; storageKey: string }) {
  const setShortcutSheet = useEditor((s) => s.setShortcutSheet);
  const [openPanels, setOpenPanels] = useState<ReadonlySet<string>>(new Set());

  // Track which panels exist so the checkboxes stay honest while the user
  // drags/closes panels with the menu closed.
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

  function togglePanel(id: PanelId) {
    if (!dock) return;
    const panel = dock.getPanel(id);
    if (panel) panel.api.close();
    else showPanel(dock, id);
  }

  const items: MenuItem[] = [
    ...VIEW_MENU_PANELS.map(
      (id): MenuItem => ({
        label: PANEL_TITLES[id],
        checked: openPanels.has(id),
        closeOnSelect: false,
        onSelect: () => togglePanel(id),
      }),
    ),
    { separator: true },
    { label: 'Reset layout', onSelect: () => dock && resetLayout(dock, storageKey) },
    { separator: true },
    { label: 'Keyboard shortcuts', shortcut: comboDisplay('shift+/'), onSelect: () => setShortcutSheet(true) },
  ];

  return <MenuButton trigger="View" label="View" items={items} disabled={!dock} />;
}
