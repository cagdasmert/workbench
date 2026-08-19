import { useEffect, useState } from 'react';
import type { PluginHost, PluginRecord } from '@workbench/plugin-host';

const STATE_LABEL: Record<string, string> = {
  discovered: 'idle',
  activating: 'starting…',
  active: 'active',
  failed: 'failed',
  disposed: 'idle',
};

export function PluginManager({
  host,
  revision,
  onClose,
}: {
  host: PluginHost;
  revision: number;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [, force] = useState(0);

  // `revision` bumps on reload; this redraws on enable/disable too.
  useEffect(() => force((n) => n + 1), [revision]);

  const records: PluginRecord[] = [...host.registry.values()]
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

  const toggle = async (rec: PluginRecord) => {
    const id = rec.manifest.id;
    const enabled = host.isDisabled(id);      // flipping to this
    setBusy(id);
    try {
      // Main persists and rebuilds the native menu; the host tears down or
      // restores contributions. Both, or the two disagree about what exists.
      await window.workbenchHost.setPluginEnabled(id, enabled);
      await host.setEnabled(id, enabled);
      force((n) => n + 1);
    } finally {
      setBusy(null);
    }
  };

  const reload = async (rec: PluginRecord) => {
    setBusy(rec.manifest.id);
    try {
      await host.reload(rec.manifest.id);
      force((n) => n + 1);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="shell-scrim" onMouseDown={onClose}>
      <div className="plugins-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          Plugins
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {records.length === 0 && <p className="settings-empty">No plugins discovered.</p>}

        {records.map((rec) => {
          const id = rec.manifest.id;
          const off = host.isDisabled(id);
          const state = off ? 'disabled' : STATE_LABEL[rec.state] ?? rec.state;

          return (
            <section key={id} className={off ? 'plugin-row plugin-off' : 'plugin-row'}>
              <div className="plugin-head">
                <span className="plugin-name">{rec.manifest.name}</span>
                <span className="plugin-version">{id} · v{rec.manifest.version}</span>
                <span className={`plugin-state plugin-state-${rec.state}`}>{state}</span>

                <button type="button" disabled={busy === id} onClick={() => void reload(rec)}>
                  Reload
                </button>
                <button type="button" disabled={busy === id} onClick={() => void toggle(rec)}>
                  {off ? 'Enable' : 'Disable'}
                </button>
              </div>

              {rec.manifest.permissions !== undefined
                && rec.manifest.permissions.length > 0 && (
                <div className="plugin-perms">
                  {rec.manifest.permissions.map((p) => (
                    <code key={p}>{p}</code>
                  ))}
                </div>
              )}

              {rec.error !== undefined && (
                <pre className="plugin-error">
                  {rec.error.stack ?? rec.error.message}
                </pre>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
