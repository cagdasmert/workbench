import { useEffect, useMemo, useState } from 'react';
import {
  createPluginHost,
  type CommandDescriptor,
  type RouteChoice,
} from '@workbench/plugin-host';
import type { PluginManifest } from '@workbench/plugin-sdk';
import { PanelHost } from './PanelHost.js';
import { CommandPalette } from './CommandPalette.js';
import { SettingsPanel } from './SettingsPanel.js';
import { PluginManager } from './PluginManager.js';

export function App() {
  const [host] = useState(() => createPluginHost());
  const [manifests, setManifests] = useState<PluginManifest[]>([]);
  const [panelId, setPanelId] = useState<string | undefined>(undefined);

  useEffect(() => {
    void (async () => {
      const [discovered, disabled] = await Promise.all([
        window.workbenchHost.listPlugins(),
        window.workbenchHost.disabledPlugins(),
      ]);
      host.setDisabledIds(disabled);      // before load, so nothing can wake early
      host.load(discovered);
      setManifests(discovered);
    })();
  }, [host]);

  useEffect(() => host.onActivePanelChange(setPanelId), [host]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [route, setRoute] = useState<RouteChoice | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Multiple plugins accept the type — architecture §5.2 says ask, don't guess.
  useEffect(() => host.onRouteChoice(setRoute), [host]);

  // One path from a settings write to a plugin observing it: main persists,
  // broadcasts, and the host fans out to that plugin's listeners.
  useEffect(
    () => window.workbenchHost.onSettingChanged((pluginId, key, value) => {
      host.notifySettingChanged(pluginId, key, value);
    }),
    [host],
  );

  useEffect(() => host.onNotice((msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3200);
  }), [host]);

  // Shell actions are commands too — no exceptions (architecture §6). They live
  // in the same registry the palette reads, so the palette can close itself.
  useEffect(() => {
    const disposables = [
      host.registerShellCommand('shell.closePanel', 'Close Panel', async () => {
        const open = host.getActivePanelId();
        if (open !== undefined) await host.closeActivePanel();
      }),
      host.registerShellCommand('shell.reloadPlugins', 'Reload All Plugins', async () => {
        for (const rec of host.registry.values()) await host.reload(rec.manifest.id);
      }),
      host.registerShellCommand('shell.openSettings', 'Open Settings', async () => {
        setSettingsOpen(true);
      }),
      host.registerShellCommand('shell.openPlugins', 'Open Plugin Manager', async () => {
        setPluginsOpen(true);
      }),
      host.registerShellCommand('shell.commandPalette', 'Show Command Palette', async () => {
        setPaletteOpen(true);
      }),
    ];
    return () => { for (const d of disposables) void d.dispose(); };
  }, [host]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The preload returns the unsubscribe directly, which is exactly what an
  // effect wants back. Without it, hot reload would stack duplicate listeners.
  useEffect(
    () => window.workbenchHost.onCommand((id) => void host.invokeCommand(id)),
    [host],
  );

  useEffect(
    () => window.workbenchHost.onPluginChanged((id) => void host.reload(id)),
    [host],
  );

  // A reload keeps the same panelId but replaces the definition behind it, so the
  // memo below needs something to invalidate on or it would hand back dead code.
  const [revision, setRevision] = useState(0);
  useEffect(() => host.onReload(() => setRevision((r) => r + 1)), [host]);

  // Memoised: getPanel() builds a fresh object each call, and an unstable value
  // here would remount the panel on every render.
  const commands = useMemo(
    () => host.listCommands(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute on open
    [host, manifests, paletteOpen, revision],
  );

  const panel = useMemo(
    () => (panelId === undefined ? null : host.getPanel(panelId) ?? null),
    [host, panelId, revision],
  );

  return (
    <div className="shell">
      <header className="shell-chrome">
        <span className="shell-title">Workbench</span>
        <span className="shell-status">
          {manifests.length === 0
            ? 'no plugins discovered'
            : `${manifests.length} plugin${manifests.length === 1 ? '' : 's'}: ` +
              manifests.map((m) => m.id).join(', ')}
        </span>
      </header>
      <main className="shell-workspace">
        <PanelHost panel={panel} onReload={(pluginId) => void host.reload(pluginId)} />
      </main>
      {notice !== null && <div className="shell-toast">{notice}</div>}
      {pluginsOpen && (
        <PluginManager host={host} revision={revision} onClose={() => setPluginsOpen(false)} />
      )}
      {settingsOpen && (
        <SettingsPanel manifests={manifests} onClose={() => setSettingsOpen(false)} />
      )}
      {route !== null && (
        <div className="shell-scrim" onMouseDown={() => setRoute(null)}>
          <div className="shell-picker" onMouseDown={(e) => e.stopPropagation()}>
            <header>Send {route.content.type} to…</header>
            <ul>
              {route.candidates.map((c) => (
                <li key={c.pluginId}>
                  <button
                    type="button"
                    onClick={() => {
                      const target = c.pluginId;
                      const content = route.content;
                      setRoute(null);
                      void host.deliver(target, content);
                    }}
                  >{c.name}</button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {paletteOpen && (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
          onRun={(command: CommandDescriptor) => {
            setPaletteOpen(false);
            void host.invokeCommand(command.id);
          }}
        />
      )}
    </div>
  );
}
