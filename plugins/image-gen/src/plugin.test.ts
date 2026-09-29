import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetRequestInit, NetResponse, PluginManifest } from '@workbench/plugin-sdk';
import { createPluginHost, type PluginHost, type WorkbenchHostBridge } from '@workbench/plugin-host';
import { jobStarted, plugin } from './index.js';

/**
 * The disposal test ("the highest-value test" since M0): the real plugin,
 * activated and torn down by the real host. The host's own tests prove it
 * unwinds whatever it is given; this proves Images gives it everything.
 */

const ID = 'image-gen';

const manifest: PluginManifest = {
  id: ID,
  name: 'Images',
  version: '1.0.0',
  apiVersion: '1.0',
  main: './dist/index.js',
  activationEvents: ['onCommand:imagegen.open', 'onCommand:imagegen.generate'],
  contributes: {
    panels: [{ id: 'imagegen.main', title: 'Images' }],
    commands: [
      { id: 'imagegen.open', title: 'Open Images' },
      { id: 'imagegen.generate', title: 'Generate an Image' },
    ],
  },
};

const RUNNING = JSON.stringify({ id: 'job1', kind: 'image', state: 'running' });
const netFetch = vi.fn(
  async (_pluginId: string, _url: string, _init?: NetRequestInit): Promise<NetResponse> =>
    ({ status: 200, ok: true, headers: {}, body: RUNNING }),
);
const notify = vi.fn(async (_message: string, _level?: string) => undefined);

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
  jobStarted.clear();
});

describe('image-gen disposal', () => {
  it('registers its panel and both commands through the context, and unwinds all of them', async () => {
    const h = host();
    await h.invokeCommand('imagegen.open');

    expect(h.get(ID)?.state).toBe('active');
    expect(h.getPanel('imagegen.main')).toBeDefined();
    // panel + imagegen.open + imagegen.generate. Anything more is a listener
    // registered around the host, which is exactly what would leak.
    expect(h.get(ID)?.disposables).toHaveLength(3);

    await h.deactivate(ID);

    expect(h.get(ID)?.state).toBe('disposed');
    expect(h.getPanel('imagegen.main')).toBeUndefined();
    expect(h.get(ID)?.disposables).toEqual([]);
  });

  it('forgets every panel subscription on deactivate', async () => {
    const h = host();
    await h.invokeCommand('imagegen.open');
    jobStarted.subscribe(() => undefined);
    await h.deactivate(ID);
    expect(jobStarted.size).toBe(0);
  });

  it('touches the network only when a command asks, never from activation', async () => {
    const h = host();
    await h.invokeCommand('imagegen.open');
    await h.deactivate(ID);
    expect(netFetch).not.toHaveBeenCalled();
  });
});

describe('imagegen.generate', () => {
  it('posts the job itself with the configured defaults, then opens the panel and nudges it', async () => {
    const h = host();
    const nudged = vi.fn();
    jobStarted.subscribe(nudged);

    await h.invokeCommand('imagegen.generate', 'a green gate', '', 0, 7);

    expect(netFetch).toHaveBeenCalledTimes(1);
    const [, url, init] = netFetch.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8077/v1/generate/image');
    expect(JSON.parse(init?.body ?? '')).toEqual({
      prompt: 'a green gate', model: 'mflux-community/z-image-turbo-mflux-q8', seed: 7,
    });
    expect(h.getActivePanelId()).toBe('imagegen.main');
    expect(nudged).toHaveBeenCalledTimes(1);
  });

  it('opens the panel instead of warning when the palette invokes it with no args', async () => {
    const h = host();
    await h.invokeCommand('imagegen.generate');
    expect(netFetch).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(h.getActivePanelId()).toBe('imagegen.main');
  });

  it("shows the daemon's refusal and leaves the panel closed", async () => {
    netFetch.mockResolvedValueOnce({
      status: 409, ok: false, headers: {},
      body: JSON.stringify({ error: 'another image job is running (m/x)', hint: 'poll /v1/jobs/abc' }),
    });
    const h = host();
    await h.invokeCommand('imagegen.generate', 'a gate');
    expect(notify).toHaveBeenCalledWith('another image job is running (m/x) — poll /v1/jobs/abc', 'error');
    expect(h.getActivePanelId()).toBeUndefined();
  });
});
