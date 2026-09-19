import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '@workbench/plugin-sdk';
import { createPluginHost, type PluginHost, type WorkbenchHostBridge } from '@workbench/plugin-host';
import { plugin, pullRequests, searchRequests } from './index.js';

/**
 * The disposal test (PRD §10.6, and "the highest-value test" since M0): the
 * real plugin, activated and torn down by the real host.
 *
 * Plus the reason the mailbox exists. `openPanel` resolves when the panel is
 * asked for, not when React has rendered it, so when the command is what opens
 * the panel there is nobody subscribed at the moment the request goes out. A
 * plain listener set drops it silently; a mailbox holds it until the panel
 * mounts.
 */

const ID = 'model-manager';

const manifest: PluginManifest = {
  id: ID,
  name: 'Models',
  version: '1.0.0',
  apiVersion: '1.0',
  main: './dist/index.js',
  activationEvents: ['onCommand:model.open', 'onCommand:model.search', 'onCommand:model.pull'],
  contributes: {
    panels: [{ id: 'model.main', title: 'Models' }],
    commands: [
      { id: 'model.open', title: 'Open Model Manager' },
      { id: 'model.search', title: 'Search Hugging Face' },
      { id: 'model.pull', title: 'Download a Model' },
    ],
  },
};

const netFetch = vi.fn(async () => ({ status: 200, ok: true, headers: {}, body: '{}' }));
const notify = vi.fn(async () => undefined);

const bridge: WorkbenchHostBridge = {
  listPlugins: async () => [],
  notify,
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
  notify.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  // A listener that outlived its test would swallow the next test's request.
  searchRequests.receive(() => undefined)();
  pullRequests.receive(() => undefined)();
  searchRequests.clear();
  pullRequests.clear();
});

describe('model-manager disposal', () => {
  it('registers its panel and all three commands through the context, and unwinds all of them', async () => {
    const h = host();
    await h.invokeCommand('model.open');

    expect(h.get(ID)?.state).toBe('active');
    expect(h.getPanel('model.main')).toBeDefined();
    // panel + model.open + model.search + model.pull — anything more is a
    // listener registered around the host, which is exactly what would leak.
    expect(h.get(ID)?.disposables).toHaveLength(4);

    await h.deactivate(ID);

    expect(h.get(ID)?.state).toBe('disposed');
    expect(h.getPanel('model.main')).toBeUndefined();
    expect(h.get(ID)?.disposables).toEqual([]);
  });

  it('touches the network only from a mounted panel, never from activation', async () => {
    const h = host();
    await h.invokeCommand('model.open');
    await h.deactivate(ID);
    expect(netFetch).not.toHaveBeenCalled();
  });
});

describe('model-manager request mailbox', () => {
  it('delivers a search request to a panel that subscribes after the command', async () => {
    const h = host();
    // The command is what opens the panel, so nothing is subscribed yet.
    await h.invokeCommand('model.search', 'whisper', 'stt');

    // The panel mounts now and subscribes, as PanelHost's async queue does.
    const seen = vi.fn();
    const off = searchRequests.receive(seen);

    expect(seen).toHaveBeenCalledWith({ query: 'whisper', task: 'stt' });
    expect(searchRequests.pending).toBeUndefined();
    off();
  });

  it('delivers a pull request to a panel that subscribes after the command', async () => {
    const h = host();
    await h.invokeCommand('model.pull', 'openai/whisper-large-v3', 'external');

    const seen = vi.fn();
    const off = pullRequests.receive(seen);

    expect(seen).toHaveBeenCalledWith({ repo: 'openai/whisper-large-v3', to: 'external' });
    expect(pullRequests.pending).toBeUndefined();
    off();
  });

  it('hands a request straight to a panel that is already listening', async () => {
    const h = host();
    const seen = vi.fn();
    const off = searchRequests.receive(seen);

    await h.invokeCommand('model.search', 'flux', 'image');

    expect(seen).toHaveBeenCalledWith({ query: 'flux', task: 'image' });
    expect(searchRequests.pending).toBeUndefined();
    off();
  });

  it('stops delivering once the panel unsubscribes', async () => {
    const h = host();
    const seen = vi.fn();
    searchRequests.receive(seen)();

    await h.invokeCommand('model.search', 'flux', 'image');

    expect(seen).not.toHaveBeenCalled();
    expect(searchRequests.pending).toEqual({ query: 'flux', task: 'image' });
  });

  it('drops an empty query rather than queueing it', async () => {
    const h = host();
    await h.invokeCommand('model.search', '', 'image');
    expect(searchRequests.pending).toBeUndefined();
  });

  it('warns on a pull with no repo rather than queueing it', async () => {
    const h = host();
    await h.invokeCommand('model.pull', '', 'external');
    expect(pullRequests.pending).toBeUndefined();
    expect(notify).toHaveBeenCalledWith('model.pull needs a repo id', 'warn');
  });

  it('does not carry undrained requests into the next activation', async () => {
    const h = host();
    // No panel mounts under test, so both requests stay queued — the case a
    // panel closed before it rendered would produce.
    await h.invokeCommand('model.search', 'whisper', 'stt');
    await h.invokeCommand('model.pull', 'openai/whisper-large-v3', '');
    expect(searchRequests.pending).toEqual({ query: 'whisper', task: 'stt' });
    expect(pullRequests.pending).toEqual({ repo: 'openai/whisper-large-v3', to: '' });

    await h.deactivate(ID);

    expect(searchRequests.pending).toBeUndefined();
    expect(pullRequests.pending).toBeUndefined();
  });
});
