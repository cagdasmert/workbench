import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { PluginManifest } from '@workbench/plugin-sdk';
import { isDisabled } from './plugin-state.js';

/**
 * Assemble the macOS menu from manifests alone. A click sends the command id to the
 * renderer — main never invokes plugin code.
 */
export function buildMenu(manifests: PluginManifest[], win: BrowserWindow): void {
  // Disabled plugins contribute nothing. Rebuilt whenever that changes, which
  // is also what finally makes a manifest edit visible without a restart.
  const pluginItems: MenuItemConstructorOptions[] = manifests
    .filter((m) => !isDisabled(m.id))
    .flatMap((m) => (m.contributes.menu ?? []).map((item) => ({
      label: item.label,
      click: () => win.webContents.send('command:invoke', item.command),
    })));

  const pluginsSubmenu: MenuItemConstructorOptions[] = pluginItems.length > 0
    ? pluginItems
    : [{ label: 'No plugins enabled', enabled: false }];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Workbench',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+K',
          click: () => win.webContents.send('command:invoke', 'shell.commandPalette'),
        },
        {
          label: 'Plugin Manager…',
          click: () => win.webContents.send('command:invoke', 'shell.openPlugins'),
        },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => win.webContents.send('command:invoke', 'shell.openSettings'),
        },
      ],
    },
    { label: 'Plugins', submenu: pluginsSubmenu },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}
