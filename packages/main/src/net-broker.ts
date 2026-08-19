import { ipcMain } from 'electron';
import type { NetRequestInit, NetResponse, PluginManifest } from '@workbench/plugin-sdk';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Hosts each plugin declared via `net:fetch:<host>`. Built once from the
 * manifests — a plugin cannot widen its own reach at runtime.
 *
 * This is narrow enforcement, not a permission engine (D5 still stands): without
 * it, a brokered fetch is an open proxy handed to the renderer, which is exactly
 * what architecture §9 says must not cross the bridge.
 */
const allowed = new Map<string, Set<string>>();

export function loadNetPermissions(manifests: PluginManifest[]): void {
  allowed.clear();
  for (const m of manifests) {
    const hosts = new Set<string>();
    for (const p of m.permissions ?? []) {
      if (p.startsWith('net:fetch:')) hosts.add(p.slice('net:fetch:'.length));
    }
    if (hosts.size > 0) allowed.set(m.id, hosts);
  }
}

function assertAllowed(pluginId: string, url: URL): void {
  const hosts = allowed.get(pluginId);
  if (hosts === undefined) {
    throw new Error(`net:fetch denied — ${pluginId} declares no net:fetch permission`);
  }
  if (hosts.has('*')) return;
  if (!hosts.has(url.host)) {
    throw new Error(
      `net:fetch denied — ${pluginId} may not reach ${url.host} `
      + `(declared: ${[...hosts].join(', ')})`,
    );
  }
}

export function registerNetBroker(): void {
  ipcMain.handle('net:fetch', async (
    _event,
    rawPluginId: unknown,
    rawUrl: unknown,
    rawInit: unknown,
  ): Promise<NetResponse> => {
    if (typeof rawPluginId !== 'string') throw new Error('net:fetch expects a plugin id');
    if (typeof rawUrl !== 'string') throw new Error('net:fetch expects a url string');

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(`net:fetch — malformed url ${JSON.stringify(rawUrl)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`net:fetch — unsupported protocol ${url.protocol}`);
    }
    assertAllowed(rawPluginId, url);

    const init = (typeof rawInit === 'object' && rawInit !== null ? rawInit : {}) as NetRequestInit;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: init.method ?? 'GET',
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });

      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_BODY_BYTES) {
        throw new Error(`net:fetch — response exceeds ${MAX_BODY_BYTES} bytes`);
      }
      return {
        status: res.status,
        ok: res.ok,
        headers: Object.fromEntries(res.headers.entries()),
        body: new TextDecoder().decode(buffer),
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`net:fetch — timed out after ${init.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
      }
      // Node's fetch reports every transport failure as a bare "fetch failed",
      // which tells a plugin author nothing. Name the host that was unreachable.
      if (err instanceof Error && /fetch failed/i.test(err.message)) {
        throw new Error(`net:fetch — could not reach ${url.host} (is it running?)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
}
