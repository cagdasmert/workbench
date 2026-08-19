import { app, ipcMain } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { JsonValue } from '@workbench/plugin-sdk';

type Store = Record<string, JsonValue>;

const caches = new Map<string, Store>();
const pending = new Map<string, NodeJS.Timeout>();
const WRITE_DEBOUNCE_MS = 250;

function dataDir(): string {
  return path.join(app.getPath('userData'), 'plugin-data');
}

/**
 * Plugin ids become filenames, so they cannot be trusted with path characters.
 * Manifest validation only checks that the id is a non-empty string — a plugin
 * called `../../config` would otherwise write outside plugin-data entirely.
 */
function safeId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._-]+$/.test(raw) || raw.startsWith('.')) {
    throw new Error(`storage: invalid plugin id ${JSON.stringify(raw)}`);
  }
  return raw;
}

async function load(pluginId: string): Promise<Store> {
  const cached = caches.get(pluginId);
  if (cached !== undefined) return cached;

  let store: Store = {};
  try {
    const raw = await readFile(path.join(dataDir(), `${pluginId}.json`), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      store = parsed as Store;
    }
  } catch {
    // absent or corrupt is not an error — a plugin starts with an empty store
  }
  caches.set(pluginId, store);
  return store;
}

/** Debounced, and written via a temp file so a crash mid-write cannot truncate. */
function scheduleFlush(pluginId: string): void {
  const existing = pending.get(pluginId);
  if (existing !== undefined) clearTimeout(existing);

  pending.set(pluginId, setTimeout(() => {
    pending.delete(pluginId);
    void (async () => {
      try {
        const dir = dataDir();
        await mkdir(dir, { recursive: true });
        const target = path.join(dir, `${pluginId}.json`);
        const tmp = `${target}.tmp`;
        await writeFile(tmp, JSON.stringify(caches.get(pluginId) ?? {}, null, 2), 'utf8');
        await rename(tmp, target);
      } catch (err) {
        console.error(`[storage] flush failed for ${pluginId}`, err);
      }
    })();
  }, WRITE_DEBOUNCE_MS));
}

export function registerStorageBroker(): void {
  ipcMain.handle('storage:get', async (_event, rawId: unknown, rawKey: unknown) => {
    const pluginId = safeId(rawId);
    if (typeof rawKey !== 'string') throw new Error('storage:get expects a string key');
    return (await load(pluginId))[rawKey];
  });

  ipcMain.handle('storage:set', async (_event, rawId: unknown, rawKey: unknown, value: unknown) => {
    const pluginId = safeId(rawId);
    if (typeof rawKey !== 'string') throw new Error('storage:set expects a string key');

    // Round-trip through JSON so anything unserializable fails here, in main,
    // rather than silently degrading on the next read.
    const store = await load(pluginId);
    store[rawKey] = JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
    scheduleFlush(pluginId);
  });
}
