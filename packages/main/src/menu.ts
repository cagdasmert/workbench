import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { PluginManifest } from '@workbench/plugin-sdk';

/**
 * Assemble the macOS menu from manifests alone. A click sends the command id to the
 * renderer — main never invokes plugin code.
 */
export function buildMenu(manifests: PluginManifest[], win: BrowserWindow): void {
  const pluginItems: MenuItemConstructorOptions[] = manifests.flatMap((m) =>
    (m.contributes.menu ?? []).map((item) => ({
      label: item.label,
      click: () => win.webContents.send('command:invoke', item.command),
    })),
  );

  const pluginsSubmenu: MenuItemConstructorOptions[] = pluginItems.length > 0
    ? pluginItems
    : [{ label: 'No plugins discovered', enabled: false }];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Plugins', submenu: pluginsSubmenu },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}
