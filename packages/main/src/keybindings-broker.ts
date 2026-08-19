import { app, ipcMain } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * User rebinds ONLY — never a copy of the defaults.
 *
 * This is the whole point of the file (architecture §6): defaults live in
 * manifests and change when a plugin updates. If defaults were snapshotted here,
 * a plugin update would either be silently ignored or would clobber a user's
 * rebind, depending on merge order. Storing only the diff makes that impossible:
 * anything absent falls through to whatever the plugin currently declares.
 *
 * An empty string is a meaningful value — it means "unbound", which is different
 * from "not overridden".
 */
let overrides: Record<string, string> = {};

function bindingsFile(): string {
  return path.join(app.getPath('userData'), 'keybindings.json');
}

export async function loadKeybindings(): Promise<void> {
  try {
    const raw = await readFile(bindingsFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      overrides = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string') as Array<[string, string]>,
      );
    }
  } catch {
    overrides = {};
  }
}

async function persist(): Promise<void> {
  try {
    const file = bindingsFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(overrides, null, 2), 'utf8');
    await rename(`${file}.tmp`, file);
  } catch (err) {
    console.error('[keys] could not persist overrides', err);
  }
}

export function registerKeybindingsBroker(broadcast: () => void): void {
  ipcMain.handle('keys:overrides', () => ({ ...overrides }));

  ipcMain.handle('keys:set', async (_e, rawCommand: unknown, rawKey: unknown) => {
    if (typeof rawCommand !== 'string') throw new Error('keys:set expects a command id');
    if (rawKey !== null && typeof rawKey !== 'string') {
      throw new Error('keys:set expects a chord string or null');
    }

    if (rawKey === null) {
      delete overrides[rawCommand];      // revert to the declared default
    } else {
      overrides[rawCommand] = rawKey;    // '' means deliberately unbound
    }

    await persist();
    broadcast();
  });
}
