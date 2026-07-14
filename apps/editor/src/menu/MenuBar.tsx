/**
 * In-window application menu bar — the slim File / Edit / View / Help strip that
 * sits after the wordmark in the toolbar. Rendered in browser dev mode and in
 * Electron on Windows/Linux; on macOS the native menu (menu/nativeMenu.ts)
 * takes over and this bar is hidden. Both surfaces are driven by the same
 * `buildAppMenu` model, so an item behaves identically wherever it's shown.
 */
import React from 'react';
import { comboDisplay } from '../keybinds';
import { MenuButton, type MenuItem } from '../components/ui/Menu';
import { isMenuSeparator, type AppMenuEntry, type AppMenuItemModel, type AppMenuSection } from './appMenu';

/** Glyphs for the plain action items (checkbox items keep the ✓ gutter instead). */
const ICON_BY_ID: Record<string, string> = {
  'new-scene': 'plus',
  checkpoint: 'checkpoint',
  review: 'review',
  export: 'export',
  'close-project': 'close',
  undo: 'undo',
  redo: 'redo',
  'find-scripts': 'script',
  'debug-overlay': 'debug',
};

function toMenuItem(entry: AppMenuEntry): MenuItem {
  if (isMenuSeparator(entry)) return { separator: true };
  const item: AppMenuItemModel = entry;
  const menuItem: MenuItem = {
    label: item.label,
    disabled: !item.enabled,
    // Batch-toggle items (panels, debug overlay) keep the menu open.
    closeOnSelect: item.keepOpen ? false : undefined,
    onSelect: item.onSelect,
  };
  if (item.keybind) menuItem.shortcut = comboDisplay(item.keybind);
  if (typeof item.checked === 'boolean') menuItem.checked = item.checked;
  const icon = ICON_BY_ID[item.id];
  if (icon) menuItem.icon = icon;
  return menuItem;
}

export function MenuBar({ sections }: { sections: AppMenuSection[] }) {
  return (
    <span className="menubar" role="menubar">
      {sections.map((section) => (
        <MenuButton
          key={section.id}
          label={section.label}
          trigger={section.label}
          triggerClassName="menubar-btn"
          items={section.items.map(toMenuItem)}
        />
      ))}
    </span>
  );
}
