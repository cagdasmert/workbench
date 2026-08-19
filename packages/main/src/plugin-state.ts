import { app, ipcMain, type BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * Which plugins the user has switched off. Kept in its own file rather than in
 * `settings.json`: this is shell state about plugins, not a plugin's own
 * settings, and mixing them would put a key in `settings.json` that no schema
 * describes.
 */
let disabled = new Set<string>();

function stateFile(): string {
  return path.join(app.getPath('userData'), 'plugins.json');
}

export async function loadPluginState(): Promise<void> {
  try {
    const raw = await readFile(stateFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { disabled?: unknown }).disabled;
    if (Array.isArray(list)) {
      disabled = new Set(list.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    disabled = new Set();
  }
}

async function persist(): Promise<void> {
  try {
    const file = stateFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify({ disabled: [...disabled] }, null, 2), 'utf8');
    await rename(`${file}.tmp`, file);
  } catch (err) {
    console.error('[plugins] could not persist enabled state', err);
  }
}

export function isDisabled(pluginId: string): boolean {
  return disabled.has(pluginId);
}

export function disabledIds(): string[] {
  return [...disabled];
}

export function registerPluginStateBroker(
  getWindow: () => BrowserWindow | null,
  onChanged: () => void,
): void {
  ipcMain.handle('plugins:disabled', () => [...disabled]);

  ipcMain.handle('plugins:setEnabled', async (_e, rawId: unknown, rawEnabled: unknown) => {
    if (typeof rawId !== 'string') throw new Error('plugins:setEnabled expects a plugin id');
    if (typeof rawEnabled !== 'boolean') throw new Error('plugins:setEnabled expects a boolean');

    if (rawEnabled) disabled.delete(rawId);
    else disabled.add(rawId);

    await persist();
    onChanged();                      // rebuild the native menu
    const win = getWindow();
    if (win !== null) win.webContents.send('plugins:enabledChanged', rawId, rawEnabled);
  });
}
