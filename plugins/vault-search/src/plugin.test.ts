import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '@workbench/plugin-sdk';
import { createPluginHost, type PluginHost, type WorkbenchHostBridge } from '@workbench/plugin-host';
import { plugin, requests } from './index.js';

/**
 * The disposal test (PRD §10.6, and "the highest-value test" since M0): the
 * real plugin, activated and torn down by the real host. The host's own tests
 * prove it unwinds whatever it is given; this proves Transcribe gives it
 * everything — nothing registered around it, nothing left behind.
 */

const ID = 'vault-search';

const manifest: PluginManifest = {
  id: ID,
  name: 'Vault',
  version: '1.0.0',
  apiVersion: '1.0',
  main: './dist/index.js',
  activationEvents: ['onCommand:vault.open', 'onCommand:vault.search'],
  contributes: {
    panels: [{ id: 'vault.main', title: 'Vault' }],
    commands: [
      { id: 'vault.open', title: 'Open Vault Search' },
      { id: 'vault.search', title: 'Search My Notes' },
    ],
  },
};

const netFetch = vi.fn(async () => ({ status: 200, ok: true, headers: {}, body: '{}' }));

const bridge: WorkbenchHostBridge = {
  listPlugins: async () => [],
  notify: async () => undefined,
  pickFile: async () => undefined,
  pickDirectory: async () => undefined,
  pickDirectoryForWrite: async () => undefined,
  copyFile: async () => ({ name: '', renamed: false }),
  readDir: async () => [],
  readFile: async () => new Uint8Array(),
  netFetch,
  session: async () => ({}),
  setSessionPanel: async () => undefined,
  keyOverrides: async () => ({}),
  setKeyOverride: async () => undefined,
  onKeysChanged: () => () => undefined,
  disabledPlugins: async () => [],
  setPluginEnabled: async () => undefined,
  onPluginEnabledChanged: () => () => undefined,
  settingsGet: async () => undefined,
  settingsAll: async () => ({}),
  settingsSchemas: async () => ({}),
  settingsSet: async () => undefined,
  onSettingChanged: () => () => undefined,
  storageGet: async () => undefined,
  storageSet: async () => undefined,
  onCommand: () => () => undefined,
  onPluginChanged: () => () => undefined,
};

function host(): PluginHost {
  const h = createPluginHost({ bridge, importModule: async () => ({ plugin }) });
  h.load([manifest]);
  return h;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  netFetch.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  requests.clear();
});

describe('vault-search disposal', () => {
  it('registers its panel and both commands through the context, and unwinds all of them', async () => {
    const h = host();
    await h.invokeCommand('vault.open');

    expect(h.get(ID)?.state).toBe('active');
    expect(h.getPanel('vault.main')).toBeDefined();
    // panel + vault.open + vault.search — anything more is a listener
    // registered around the host, which is exactly what would leak.
    expect(h.get(ID)?.disposables).toHaveLength(3);

    await h.deactivate(ID);

    expect(h.get(ID)?.state).toBe('disposed');
    expect(h.getPanel('vault.main')).toBeUndefined();
    expect(h.get(ID)?.disposables).toEqual([]);
  });

  it('does not carry an undrained search into the next activation', async () => {
    const h = host();
    // No panel mounts under test, so the request stays queued.
    await h.invokeCommand('vault.search', 'kavram araması');
    expect(requests.pending).toEqual({ query: 'kavram araması', limit: 8 });

    await h.deactivate(ID);

    expect(requests.pending).toBeUndefined();
  });

  it('clamps a palette limit and ignores a blank query', async () => {
    const h = host();
    await h.invokeCommand('vault.search', 'x', 500);
    expect(requests.pending).toEqual({ query: 'x', limit: 50 });
    requests.clear();
    await h.invokeCommand('vault.search', '   ');
    expect(requests.pending).toBeUndefined();
  });

  it('touches the network only from a mounted panel, never from activation', async () => {
    const h = host();
    await h.invokeCommand('vault.open');
    await h.deactivate(ID);
    expect(netFetch).not.toHaveBeenCalled();
  });
});
