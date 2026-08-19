import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanPlugins } from './plugins.js';
import { registerPluginScheme, handlePluginProtocol } from './protocol.js';
import { buildMenu } from './menu.js';
import { watchPluginBuilds } from './watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEV = process.env['VITE_DEV_SERVER_URL'] !== undefined;
const PLUGIN_DEV_DIR = path.join(__dirname, '../../../plugins');

// Must happen before app.whenReady().
registerPluginScheme();

/**
 * The CSP differs between dev and prod: Vite's React Fast Refresh injects inline
 * scripts and opens an HMR websocket, both of which the shipped policy blocks.
 * `plugin:` must appear in both, or the dynamic import of plugin code is blocked.
 */
function installCsp(): void {
  // `plugin:` appears in script-src so plugin modules can be imported, and in
  // connect-src so a plugin can fetch its own bundled assets. Omitting either is
  // a silent block, not an error.
  const csp = DEV
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' plugin:; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: plugin:; " +
      "connect-src 'self' plugin: ws://localhost:5173;"
    : "default-src 'self'; script-src 'self' plugin:; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: plugin:; " +
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
    width: 1280,
    height: 820,
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/dist/index.cjs'),
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
    void win.loadFile(path.join(__dirname, '../../shell/dist/index.html'));
  }
  return win;
}

app.whenReady().then(async () => {
  installCsp();
  handlePluginProtocol();

  const manifests = await scanPlugins(PLUGIN_DEV_DIR);
  console.log(
    `[plugins] discovered ${manifests.length} in ${PLUGIN_DEV_DIR}:`,
    manifests.map((m) => `${m.id}@${m.version}`),
  );
  for (const m of manifests) console.log('[plugins] manifest:', JSON.stringify(m));

  ipcMain.handle('plugins:list', () => manifests);

  // Treat everything arriving from the renderer as untrusted — it is a local
  // RPC boundary, not a function call.
  ipcMain.handle('ui:notify', (_event, message: unknown, level: unknown) => {
    const lvl = level === 'warn' || level === 'error' ? level : 'info';
    console.log(`[notify:${lvl}]`, typeof message === 'string' ? message : String(message));
  });

  const win = createWindow();
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
