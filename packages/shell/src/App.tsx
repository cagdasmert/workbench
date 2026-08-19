import { useEffect, useMemo, useState } from 'react';
import { createPluginHost, type CommandDescriptor } from '@workbench/plugin-host';
import type { PluginManifest } from '@workbench/plugin-sdk';
import { PanelHost } from './PanelHost.js';
import { CommandPalette } from './CommandPalette.js';

export function App() {
  const [host] = useState(() => createPluginHost());
  const [manifests, setManifests] = useState<PluginManifest[]>([]);
  const [panelId, setPanelId] = useState<string | undefined>(undefined);

  useEffect(() => {
    void (async () => {
      const discovered = await window.workbenchHost.listPlugins();
      host.load(discovered);
      setManifests(discovered);
    })();
  }, [host]);

  useEffect(() => host.onActivePanelChange(setPanelId), [host]);

  const [paletteOpen, setPaletteOpen] = useState(false);

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
        <PanelHost panel={panel} />
      </main>
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
