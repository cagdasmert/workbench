import { app, BrowserWindow, ipcMain, session } from 'electron';

import { scanPlugins } from './plugins.js';
import { pluginSearchPaths, shellDist, preloadScript } from './paths.js';
import { registerPluginScheme, handlePluginProtocol } from './protocol.js';
import { registerAppScheme, handleAppProtocol, APP_ORIGIN } from './app-protocol.js';
import { buildMenu } from './menu.js';
import { watchPluginBuilds } from './watcher.js';
import { registerFsBroker } from './fs-broker.js';
import { registerStorageBroker } from './storage-broker.js';
import { registerNetBroker, loadNetPermissions } from './net-broker.js';
import { registerSettingsBroker, loadSettingsSchemas } from './settings-broker.js';
import { loadPluginState, registerPluginStateBroker, disabledIds } from './plugin-state.js';
import { loadKeybindings, registerKeybindingsBroker } from './keybindings-broker.js';
import { loadSession, initialBounds, trackWindow, registerSessionBroker } from './session.js';

// Architecture §7 puts everything under ~/Library/Application Support/Workbench.
// Without this the userData path follows the executable name and dev writes to
// .../Electron instead.
app.setName('Workbench');

const DEV = process.env['VITE_DEV_SERVER_URL'] !== undefined;

// Must happen before app.whenReady().
registerPluginScheme();
registerAppScheme();

/**
 * The CSP differs between dev and prod: Vite's React Fast Refresh injects inline
 * scripts and opens an HMR websocket, both of which the shipped policy blocks.
 * `plugin:` must appear in both, or the dynamic import of plugin code is blocked.
 */
function installCsp(): void {
  // Dev only. In production the shell is served over `app://` and carries its
  // policy on the response itself — a file:// origin cannot carry one at all,
  // which is why this never protected a packaged build. See app-protocol.ts.
  if (!DEV) return;

  // `plugin:` appears in script-src so plugin modules can be imported, and in
  // connect-src so a plugin can fetch its own bundled assets. Omitting either is
  // a silent block, not an error.
  const csp = DEV
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' plugin:; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: plugin:; " +
      "connect-src 'self' plugin: ws://localhost:5173;"
    : "default-src 'self'; script-src 'self' plugin:; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: plugin:; " +
      "connect-src 'self' plugin:;";

  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...initialBounds(),
    show: false,           // avoid a flash at the default size before restore
    titleBarStyle: 'default',
    webPreferences: {
      preload: preloadScript(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devServerUrl = process.env['VITE_DEV_SERVER_URL'];
  if (devServerUrl !== undefined) {
    void win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Not loadFile(): a file:// origin cannot carry a CSP.
    void win.loadURL(`${APP_ORIGIN}/index.html`);
  }
  win.once('ready-to-show', () => win.show());
  trackWindow(win);
  return win;
}

app.whenReady().then(async () => {
  installCsp();
  handlePluginProtocol();
  handleAppProtocol(shellDist());

  await loadPluginState();
  await loadKeybindings();
  await loadSession();

  const searchPaths = pluginSearchPaths();
  const manifests = await scanPlugins(searchPaths);
  console.log(
    `[plugins] discovered ${manifests.length} in ${searchPaths.join(', ')}:`,
    manifests.map((m) => `${m.id}@${m.version}`),
  );
  for (const m of manifests) console.log('[plugins] manifest:', JSON.stringify(m));

  loadNetPermissions(manifests);
  loadSettingsSchemas(manifests);

  ipcMain.handle('plugins:list', () => manifests);
  ipcMain.handle('plugins:disabledIds', () => disabledIds());

  // Treat everything arriving from the renderer as untrusted — it is a local
  // RPC boundary, not a function call.
  ipcMain.handle('ui:notify', (_event, message: unknown, level: unknown) => {
    const lvl = level === 'warn' || level === 'error' ? level : 'info';
    console.log(`[notify:${lvl}]`, typeof message === 'string' ? message : String(message));
  });

  const win = createWindow();
  registerFsBroker(win);
  registerPluginStateBroker(win, () => buildMenu(manifests, win));
  registerStorageBroker();
  registerNetBroker();
  registerSessionBroker();
  registerKeybindingsBroker(() => {
    if (!win.isDestroyed()) win.webContents.send('keys:changed');
  });
  registerSettingsBroker((pluginId, key, value) => {
    if (!win.isDestroyed()) win.webContents.send('settings:changed', pluginId, key, value);
  });
  buildMenu(manifests, win);

  // Dev only: the orchestrator builds, main just notices the output changed.
  if (DEV) {
    const stopWatching = watchPluginBuilds(win);
    win.on('closed', () => void stopWatching());
  }
}).catch((err: unknown) => {
  console.error('[main] startup failed', err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
