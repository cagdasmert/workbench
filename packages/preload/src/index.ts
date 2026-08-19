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
  pickDirectory: () => ipcRenderer.invoke('fs:pickDirectory'),
  readDir: (path: string) => ipcRenderer.invoke('fs:readDir', path),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),

  netFetch: (pluginId: string, url: string, init?: unknown) =>
    ipcRenderer.invoke('net:fetch', pluginId, url, init),

  session: () => ipcRenderer.invoke('session:get'),
  setSessionPanel: (panelId: string | null) => ipcRenderer.invoke('session:setPanel', panelId),

  keyOverrides: () => ipcRenderer.invoke('keys:overrides'),
  setKeyOverride: (command: string, key: string | null) =>
    ipcRenderer.invoke('keys:set', command, key),
  onKeysChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('keys:changed', listener);
    return () => ipcRenderer.off('keys:changed', listener);
  },

  disabledPlugins: () => ipcRenderer.invoke('plugins:disabled'),
  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke('plugins:setEnabled', pluginId, enabled),
  onPluginEnabledChanged: (cb: (pluginId: string, enabled: boolean) => void) => {
    const listener = (_e: unknown, id: string, enabled: boolean) => cb(id, enabled);
    ipcRenderer.on('plugins:enabledChanged', listener);
    return () => ipcRenderer.off('plugins:enabledChanged', listener);
  },

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
