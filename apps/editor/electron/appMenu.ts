/**
 * Native application menu (Electron main side). Turns the serialized menu model
 * the renderer ships (src/menu/appMenu.ts) into a real macOS menu:
 *
 *  - the standard macOS app menu comes first (About / Hide / Quit …);
 *  - each File/Edit/View/Help section becomes a submenu whose clicks echo back
 *    to the renderer as `menu:invoke <id>`, where the same model item's
 *    onSelect runs — one behavior for both the native and in-window menus;
 *  - accelerators are display-only (`registerAccelerator: false`): the
 *    renderer's own keybind dispatcher owns the keys, so a shortcut shows in the
 *    menu without double-firing.
 *
 * `null`/empty model → a baseline (app menu + system Edit + Window) so the app
 * is usable before a project is open (the launcher).
 */
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { SerializedMenuSection } from '../src/menu/appMenu';

export function buildAppMenuTemplate(
  model: SerializedMenuSection[] | null,
  onInvoke: (id: string) => void,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === 'darwin') {
    template.push({ role: 'appMenu' });
  }

  if (!model || model.length === 0) {
    // Baseline before a project is open: system Edit (copy/paste) + Window.
    template.push({ role: 'editMenu' }, { role: 'windowMenu' });
    return template;
  }

  for (const section of model) {
    template.push({
      label: section.label,
      submenu: section.items.map((item): MenuItemConstructorOptions => {
        if (item.type === 'separator') return { type: 'separator' };
        const isCheckbox = typeof item.checked === 'boolean';
        return {
          id: item.id,
          label: item.label,
          accelerator: item.accelerator,
          registerAccelerator: false,
          enabled: item.enabled !== false,
          type: isCheckbox ? 'checkbox' : 'normal',
          checked: item.checked === true,
          click: () => {
            if (item.id) onInvoke(item.id);
          },
        };
      }),
    });
  }

  return template;
}

/** Build the model into a Menu and install it as the application menu. */
export function applyAppMenu(model: SerializedMenuSection[] | null, win: BrowserWindow | null): void {
  const template = buildAppMenuTemplate(model, (id) => win?.webContents.send('menu:invoke', id));
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
