import type { PluginManifest } from '@workbench/plugin-sdk';

export const FS_WRITE_PERMISSION = 'fs:write:user-selected';

/**
 * Plugins that declared the write permission, built once from the manifests —
 * a plugin cannot widen its own reach at runtime.
 *
 * `fs` reads have no per-plugin check: grants are session-global, so any loaded
 * plugin can read a path another plugin was granted. That is a known gap. It is
 * not extended to writing, which is why this table exists.
 */
const mayWrite = new Set<string>();

export function loadFsPermissions(manifests: PluginManifest[]): void {
  mayWrite.clear();
  for (const m of manifests) {
    if ((m.permissions ?? []).includes(FS_WRITE_PERMISSION)) mayWrite.add(m.id);
  }
}

export function assertMayWrite(pluginId: string): void {
  if (!mayWrite.has(pluginId)) {
    throw new Error(`fs:write denied — ${pluginId} declares no ${FS_WRITE_PERMISSION} permission`);
  }
}
