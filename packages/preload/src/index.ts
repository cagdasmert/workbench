import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only surface the renderer sees. Small on purpose — every line here is
 * attack surface, and nothing that isn't serializable crosses it.
 *
 * Every subscription returns its own unsubscribe function. That is not a
 * convenience: hot reload re-registers listeners on every plugin edit, and
 * without disposal you get duplicate handlers that are maddening to diagnose
 * because everything still works, just twice.
 */
contextBridge.exposeInMainWorld('workbenchHost', {
  listPlugins: () => ipcRenderer.invoke('plugins:list'),

  notify: (msg: string, level = 'info') => ipcRenderer.invoke('ui:notify', msg, level),

  pickFile: (filters?: unknown) => ipcRenderer.invoke('fs:pickFile', filters),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),

  netFetch: (pluginId: string, url: string, init?: unknown) =>
    ipcRenderer.invoke('net:fetch', pluginId, url, init),

  settingsGet: (pluginId: string, key: string) =>
    ipcRenderer.invoke('settings:get', pluginId, key),
  settingsAll: (pluginId: string) => ipcRenderer.invoke('settings:all', pluginId),
  settingsSchemas: () => ipcRenderer.invoke('settings:schemas'),
  settingsSet: (pluginId: string, key: string, value: unknown) =>
    ipcRenderer.invoke('settings:set', pluginId, key, value),
  onSettingChanged: (cb: (pluginId: string, key: string, value: unknown) => void) => {
    const listener = (_e: unknown, p: string, k: string, v: unknown) => cb(p, k, v);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.off('settings:changed', listener);
  },

  storageGet: (pluginId: string, key: string) =>
    ipcRenderer.invoke('storage:get', pluginId, key),
  storageSet: (pluginId: string, key: string, value: unknown) =>
    ipcRenderer.invoke('storage:set', pluginId, key, value),

  onCommand: (cb: (commandId: string) => void) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('command:invoke', listener);
    return () => ipcRenderer.off('command:invoke', listener);
  },

  onPluginChanged: (cb: (pluginId: string) => void) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('plugin:changed', listener);
    return () => ipcRenderer.off('plugin:changed', listener);
  },
});
