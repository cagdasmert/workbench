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
