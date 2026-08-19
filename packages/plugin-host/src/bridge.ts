import type {
  FileFilter, JsonValue, NetRequestInit, NetResponse, PluginManifest,
} from '@workbench/plugin-sdk';

/**
 * The preload surface. plugin-host speaks to this and nothing else — no Electron
 * import anywhere in this package. That constraint is what lets the host move into
 * an iframe or worker later untouched, and it is also why this package unit-tests
 * under plain Vitest with no Electron harness.
 */
export interface WorkbenchHostBridge {
  listPlugins(): Promise<PluginManifest[]>;
  notify(message: string, level?: string): Promise<void>;
  pickFile(filters?: FileFilter[]): Promise<string | undefined>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  netFetch(pluginId: string, url: string, init?: NetRequestInit): Promise<NetResponse>;
  storageGet(pluginId: string, key: string): Promise<JsonValue | undefined>;
  storageSet(pluginId: string, key: string, value: JsonValue): Promise<void>;
  onCommand(cb: (commandId: string) => void): () => void;
  onPluginChanged(cb: (pluginId: string) => void): () => void;
}

interface MaybeWindow {
  window?: { workbenchHost?: WorkbenchHostBridge };
}

export function getBridge(): WorkbenchHostBridge {
  const bridge = (globalThis as MaybeWindow).window?.workbenchHost;
  if (bridge === undefined) {
    throw new Error('window.workbenchHost is unavailable — the preload script did not run');
  }
  return bridge;
}
