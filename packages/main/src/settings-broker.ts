import { app, ipcMain } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { JsonValue, PluginManifest, SettingsSchema } from '@workbench/plugin-sdk';

type Scoped = Record<string, Record<string, JsonValue>>;

let cache: Scoped | null = null;
let schemas = new Map<string, SettingsSchema>();
let flushTimer: NodeJS.Timeout | null = null;

/** Shell settings live beside plugin settings, per architecture §7. */
function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettingsSchemas(manifests: PluginManifest[]): void {
  schemas = new Map(
    manifests
      .filter((m) => m.contributes.settings !== undefined)
      .map((m) => [m.id, m.contributes.settings as SettingsSchema]),
  );
}

async function load(): Promise<Scoped> {
  if (cache !== null) return cache;
  let parsed: Scoped = {};
  try {
    const raw = await readFile(settingsFile(), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      parsed = value as Scoped;
    }
  } catch {
    // absent or corrupt: start from declared defaults
  }
  cache = parsed;
  return parsed;
}

function scheduleFlush(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void (async () => {
      try {
        const file = settingsFile();
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(cache ?? {}, null, 2), 'utf8');
        await rename(`${file}.tmp`, file);
      } catch (err) {
        console.error('[settings] flush failed', err);
      }
    })();
  }, 200);
}

/**
 * A stored value is only honoured if it still matches the declared schema.
 * A plugin update that changes a setting's type or narrows its enum must not
 * hand the plugin a value it can no longer handle — the declared default wins.
 */
function coerce(schema: SettingsSchema[string] | undefined, stored: unknown): JsonValue | undefined {
  if (schema === undefined) return undefined;
  const fallback = (schema.default ?? undefined) as JsonValue | undefined;
  if (stored === undefined) return fallback;

  if (typeof stored !== schema.type) return fallback;
  if (schema.enum !== undefined && !schema.enum.includes(String(stored))) return fallback;
  return stored as JsonValue;
}

/** Declared defaults merged over stored values, for one plugin. */
export async function effectiveSettings(pluginId: string): Promise<Record<string, JsonValue>> {
  const all = await load();
  const schema = schemas.get(pluginId);
  const stored = all[pluginId] ?? {};
  if (schema === undefined) return {};

  const out: Record<string, JsonValue> = {};
  for (const [key, prop] of Object.entries(schema)) {
    const value = coerce(prop, stored[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function registerSettingsBroker(broadcast: (pluginId: string, key: string, value: JsonValue) => void): void {
  ipcMain.handle('settings:get', async (_e, pluginId: unknown, key: unknown) => {
    if (typeof pluginId !== 'string' || typeof key !== 'string') {
      throw new Error('settings:get expects (pluginId, key)');
    }
    return (await effectiveSettings(pluginId))[key];
  });

  ipcMain.handle('settings:all', async (_e, pluginId: unknown) => {
    if (typeof pluginId !== 'string') throw new Error('settings:all expects a plugin id');
    return await effectiveSettings(pluginId);
  });

  ipcMain.handle('settings:schemas', () =>
    Object.fromEntries([...schemas.entries()]));

  // Only the shell's settings UI calls this — plugins have no `set`.
  ipcMain.handle('settings:set', async (_e, pluginId: unknown, key: unknown, value: unknown) => {
    if (typeof pluginId !== 'string' || typeof key !== 'string') {
      throw new Error('settings:set expects (pluginId, key, value)');
    }
    const schema = schemas.get(pluginId)?.[key];
    if (schema === undefined) {
      throw new Error(`settings:set — ${pluginId} declares no setting "${key}"`);
    }
    if (typeof value !== schema.type) {
      throw new Error(`settings:set — "${key}" must be a ${schema.type}`);
    }
    if (schema.enum !== undefined && !schema.enum.includes(String(value))) {
      throw new Error(`settings:set — "${key}" must be one of ${schema.enum.join(', ')}`);
    }

    const all = await load();
    all[pluginId] = { ...all[pluginId], [key]: value as JsonValue };
    scheduleFlush();
    broadcast(pluginId, key, value as JsonValue);
  });
}
