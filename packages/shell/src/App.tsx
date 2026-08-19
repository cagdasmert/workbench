import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createPluginHost,
  chordFromEvent,
  chordMap,
  resolveBindings,
  type Binding,
  type CommandDescriptor,
  type RouteChoice,
} from '@workbench/plugin-host';
import type { PluginManifest } from '@workbench/plugin-sdk';
import { PanelHost } from './PanelHost.js';
import { CommandPalette } from './CommandPalette.js';
import { SettingsPanel } from './SettingsPanel.js';
import { PluginManager } from './PluginManager.js';
import { Keybindings } from './Keybindings.js';

/** Shell defaults. Data, resolved through the same path as plugin defaults. */
const SHELL_KEYS = [
  { command: 'shell.commandPalette', key: 'cmd+k' },
  { command: 'shell.openSettings', key: 'cmd+,' },
  { command: 'shell.openPlugins', key: 'cmd+shift+p' },
  { command: 'shell.openKeybindings', key: 'cmd+alt+k' },
];

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
  const [keysOpen, setKeysOpen] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
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
        setPaletteOpen((open) => !open);
      }),
      host.registerShellCommand('shell.openKeybindings', 'Open Keyboard Shortcuts', async () => {
        setKeysOpen(true);
      }),
    ];
    return () => { for (const d of disposables) void d.dispose(); };
  }, [host]);

  const refreshOverrides = useCallback(async () => {
    setOverrides(await window.workbenchHost.keyOverrides());
  }, []);

  useEffect(() => { void refreshOverrides(); }, [refreshOverrides]);
  useEffect(
    () => window.workbenchHost.onKeysChanged(() => void refreshOverrides()),
    [refreshOverrides],
  );

  const bindings: Binding[] = useMemo(
    () => resolveBindings(manifests, SHELL_KEYS, overrides),
    [manifests, overrides],
  );

  // One dispatcher for every chord, shell and plugin alike — there is no
  // hardcoded shortcut left to drift from the registry.
  useEffect(() => {
    const map = chordMap(bindings);
    const onKey = (e: KeyboardEvent) => {
      // While a chord is being recorded, the sheet owns the keyboard.
      // e.target is not always an Element — it is `window` for a synthetic
      // dispatch and `document` in some paths, neither of which has closest().
      const target = e.target;
      if (target instanceof Element && target.closest('.keys-recording') !== null) return;

      const chord = chordFromEvent(e);
      if (chord === null) return;
      const command = map.get(chord);
      if (command === undefined) return;
      e.preventDefault();
      void host.invokeCommand(command);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [host, bindings]);

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
      {keysOpen && (
        <Keybindings
          bindings={bindings}
          commands={commands}
          onClose={() => setKeysOpen(false)}
          onSet={(command, key) => {
            void window.workbenchHost.setKeyOverride(command, key);
          }}
        />
      )}
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
