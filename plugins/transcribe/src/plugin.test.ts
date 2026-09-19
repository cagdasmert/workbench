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

const ID = 'transcribe';

const manifest: PluginManifest = {
  id: ID,
  name: 'Transcribe',
  version: '1.0.0',
  apiVersion: '1.0',
  main: './dist/index.js',
  activationEvents: ['onCommand:transcribe.open', 'onCommand:transcribe.file'],
  contributes: {
    panels: [{ id: 'transcribe.main', title: 'Transcribe' }],
    commands: [
      { id: 'transcribe.open', title: 'Open Transcribe' },
      { id: 'transcribe.file', title: 'Transcribe a File' },
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

describe('transcribe disposal', () => {
  it('registers its panel and both commands through the context, and unwinds all of them', async () => {
    const h = host();
    await h.invokeCommand('transcribe.open');

    expect(h.get(ID)?.state).toBe('active');
    expect(h.getPanel('transcribe.main')).toBeDefined();
    // panel + transcribe.open + transcribe.file — anything more is a listener
    // registered around the host, which is exactly what would leak.
    expect(h.get(ID)?.disposables).toHaveLength(3);

    await h.deactivate(ID);

    expect(h.get(ID)?.state).toBe('disposed');
    expect(h.getPanel('transcribe.main')).toBeUndefined();
    expect(h.get(ID)?.disposables).toEqual([]);
  });

  it('does not carry an undrained request into the next activation', async () => {
    const h = host();
    // No panel mounts under test, so the request stays queued — the case a
    // panel closed before it rendered would produce.
    await h.invokeCommand('transcribe.file', '/audio/memo.m4a', '', 'tr');
    expect(requests.pending).toEqual({ kind: 'run', path: '/audio/memo.m4a', model: '', language: 'tr' });

    await h.deactivate(ID);

    expect(requests.pending).toBeUndefined();
  });

  it('touches the network only from a mounted panel, never from activation', async () => {
    const h = host();
    await h.invokeCommand('transcribe.open');
    await h.deactivate(ID);
    expect(netFetch).not.toHaveBeenCalled();
  });
});
