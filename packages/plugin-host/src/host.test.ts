import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Disposable, Plugin, PluginManifest } from '@workbench/plugin-sdk';
import { createPluginHost, type PluginHost, type WorkbenchHostBridge } from './index.js';

const PLUGIN_ID = 'test';

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: PLUGIN_ID,
    name: 'Test',
    version: '1.0.0',
    apiVersion: '1.0',
    main: './dist/index.js',
    activationEvents: ['onCommand:test.open'],
    contributes: {},
    ...overrides,
  };
}

const bridge: WorkbenchHostBridge = {
  listPlugins: async () => [],
  notify: async () => undefined,
  pickFile: async () => undefined,
  pickDirectory: async () => undefined,
  readDir: async () => [],
  readFile: async () => new Uint8Array(),
  pickDirectoryForWrite: async () => undefined,
  copyFile: async () => ({ name: '', renamed: false }),
  netFetch: async () => ({ status: 200, ok: true, headers: {}, body: '' }),
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

/** A host wired to a fake module loader — the plugin:// scheme never appears. */
function hostFor(plugin: Plugin, m: PluginManifest = manifest()): PluginHost {
  const host = createPluginHost({ bridge, importModule: async () => ({ plugin }) });
  host.load([m]);
  return host;
}

/** Push a disposable straight onto the record, so disposal order is observable. */
function push(host: PluginHost, dispose: () => void): void {
  const rec = host.get(PLUGIN_ID);
  if (rec === undefined) throw new Error('no record');
  const d: Disposable = { dispose };
  rec.disposables.push(d);
}

const noop: Plugin = { activate: () => undefined };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('disposal', () => {
  it('unwinds disposables in reverse registration order', async () => {
    const order: string[] = [];
    const host = hostFor(noop);
    await host.activate(PLUGIN_ID);

    push(host, () => void order.push('first'));
    push(host, () => void order.push('second'));
    push(host, () => void order.push('third'));

    await host.deactivate(PLUGIN_ID);

    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('keeps unwinding when a disposer throws', async () => {
    const order: string[] = [];
    const host = hostFor(noop);
    await host.activate(PLUGIN_ID);

    // registered first, so it disposes last
    push(host, () => void order.push('survivor'));
    push(host, () => { throw new Error('disposer exploded'); });

    await expect(host.deactivate(PLUGIN_ID)).resolves.toBeUndefined();

    expect(order).toEqual(['survivor']);
    expect(host.get(PLUGIN_ID)?.state).toBe('disposed');
  });

  it('unwinds partial registrations when activation throws', async () => {
    const exploding: Plugin = {
      activate(ctx) {
        ctx.registerPanel('test.main', { mount: () => undefined });
        ctx.registerCommand('test.open', () => undefined);
        throw new Error('activation exploded');
      },
    };
    const host = hostFor(exploding);

    await host.activate(PLUGIN_ID);

    const rec = host.get(PLUGIN_ID);
    expect(rec?.state).toBe('failed');
    expect(rec?.error?.message).toBe('activation exploded');
    // `failed` has to mean "contributed nothing"
    expect(rec?.disposables).toEqual([]);
    expect(host.getPanel('test.main')).toBeUndefined();

    // and a later deactivate is still safe
    await expect(host.deactivate(PLUGIN_ID)).resolves.toBeUndefined();
    expect(host.get(PLUGIN_ID)?.state).toBe('disposed');
  });

  it('is idempotent — a second deactivate does not re-run disposers', async () => {
    let calls = 0;
    const host = hostFor(noop);
    await host.activate(PLUGIN_ID);
    push(host, () => { calls += 1; });

    await host.deactivate(PLUGIN_ID);
    await host.deactivate(PLUGIN_ID);

    expect(calls).toBe(1);
  });

  it('unwinds even when the plugin deactivate() throws', async () => {
    let disposed = false;
    const badExit: Plugin = {
      activate: () => undefined,
      deactivate: () => { throw new Error('deactivate exploded'); },
    };
    const host = hostFor(badExit);
    await host.activate(PLUGIN_ID);
    push(host, () => { disposed = true; });

    await expect(host.deactivate(PLUGIN_ID)).resolves.toBeUndefined();

    expect(disposed).toBe(true);
    expect(host.get(PLUGIN_ID)?.state).toBe('disposed');
  });
});

describe('content bus', () => {
  function twoPlugins(acceptsA: string[], acceptsB: string[]) {
    const host = createPluginHost({
      bridge,
      importModule: async () => ({ plugin: noop }),
    });
    host.load([
      { ...manifest(), id: 'a', name: 'A', contributes: { accepts: acceptsA } },
      { ...manifest(), id: 'b', name: 'B', contributes: { accepts: acceptsB } },
    ]);
    return host;
  }

  it('routes to the single plugin that accepts the type', async () => {
    const host = twoPlugins(['image/svg+xml'], ['application/json']);
    const seen: string[] = [];
    const spy: Plugin = {
      activate(ctx) { ctx.bus.onReceive((c) => { seen.push(`${ctx.id}:${c.type}`); }); },
    };
    const routed = createPluginHost({ bridge, importModule: async () => ({ plugin: spy }) });
    routed.load([
      { ...manifest(), id: 'a', name: 'A', contributes: { accepts: ['image/svg+xml'] } },
      { ...manifest(), id: 'b', name: 'B', contributes: { accepts: ['application/json'] } },
    ]);

    await routed.emit({ type: 'image/svg+xml', data: '<svg/>' });

    expect(seen).toEqual(['a:image/svg+xml']);
    expect(routed.get('b')?.state).toBe('discovered');   // never woken
    void host;
  });

  it('raises a choice when several plugins accept the type', async () => {
    const host = twoPlugins(['text/plain'], ['text/plain']);
    const choices: string[][] = [];
    host.onRouteChoice((c) => choices.push(c.candidates.map((x) => x.pluginId)));

    await host.emit({ type: 'text/plain', data: 'hi' });

    expect(choices).toEqual([['a', 'b']]);
    // nothing delivered until the user picks
    expect(host.get('a')?.state).toBe('discovered');
  });

  it('notices when nothing accepts the type', async () => {
    const host = twoPlugins(['text/plain'], ['application/json']);
    const notices: string[] = [];
    host.onNotice((m) => notices.push(m));

    await host.emit({ type: 'video/mp4', data: 'x' });

    expect(notices).toEqual(['No plugin accepts video/mp4']);
  });

  it('never routes a payload back to its emitter', async () => {
    const host = twoPlugins(['text/plain'], ['text/plain']);
    const notices: string[] = [];
    host.onNotice((m) => notices.push(m));
    const choices: unknown[] = [];
    host.onRouteChoice((c) => choices.push(c));

    // 'a' emits a type both accept — only 'b' is a candidate, so it routes
    // directly instead of asking.
    await host.emit({ type: 'text/plain', data: 'x' }, 'a');

    expect(choices).toEqual([]);
    expect(notices).toEqual([]);
    expect(host.get('b')?.state).toBe('active');
    expect(host.get('a')?.state).toBe('discovered');
  });

  it('runs handlers as a waterfall: transform, then short-circuit', async () => {
    const order: string[] = [];
    const waterfall: Plugin = {
      activate(ctx) {
        ctx.bus.onReceive((c) => {
          order.push(`first:${String(c.data)}`);
          return { content: { ...c, data: `${String(c.data)}+1` } };
        });
        ctx.bus.onReceive((c) => {
          order.push(`second:${String(c.data)}`);
          return { handled: true };
        });
        ctx.bus.onReceive(() => { order.push('third'); });
      },
    };
    const host = createPluginHost({ bridge, importModule: async () => ({ plugin: waterfall }) });
    host.load([{ ...manifest(), id: 'a', name: 'A', contributes: { accepts: ['text/plain'] } }]);

    await host.emit({ type: 'text/plain', data: 'x' });

    // second sees the transformed payload; third never runs
    expect(order).toEqual(['first:x', 'second:x+1']);
  });

  it('stamps the emitting plugin into meta', async () => {
    let got: unknown;
    const spy: Plugin = { activate(ctx) { ctx.bus.onReceive((c) => { got = c.meta; }); } };
    const host = createPluginHost({ bridge, importModule: async () => ({ plugin: spy }) });
    host.load([
      { ...manifest(), id: 'a', name: 'A', contributes: { accepts: [] } },
      { ...manifest(), id: 'b', name: 'B', contributes: { accepts: ['text/plain'] } },
    ]);

    await host.emit({ type: 'text/plain', data: 'x' }, 'a');

    expect(got).toEqual({ sourcePluginId: 'a' });
  });

  it('treats accepts:["*"] as a universal sink', async () => {
    const host = twoPlugins(['*'], ['application/json']);
    const notices: string[] = [];
    host.onNotice((m) => notices.push(m));

    await host.emit({ type: 'video/mp4', data: 'x' });

    expect(notices).toEqual([]);
    expect(host.get('a')?.state).toBe('active');
  });
});

describe('contributions', () => {
  it('removes panels and commands registered through the context', async () => {
    let ran = 0;
    const plugin: Plugin = {
      activate(ctx) {
        ctx.registerPanel('test.main', { mount: () => undefined });
        ctx.registerCommand('test.open', () => { ran += 1; });
      },
    };
    const host = hostFor(plugin);

    await host.invokeCommand('test.open');       // lazy activation via onCommand:
    expect(host.get(PLUGIN_ID)?.state).toBe('active');
    expect(ran).toBe(1);
    expect(host.getPanel('test.main')).toBeDefined();

    await host.deactivate(PLUGIN_ID);

    expect(host.getPanel('test.main')).toBeUndefined();
    expect(host.get(PLUGIN_ID)?.disposables).toEqual([]);
  });

  it('re-activates a disposed plugin when its command is invoked again', async () => {
    let ran = 0;
    const plugin: Plugin = {
      activate(ctx) {
        ctx.registerPanel('test.main', { mount: () => undefined });
        ctx.registerCommand('test.open', () => { ran += 1; });
      },
    };
    const host = hostFor(plugin);

    await host.invokeCommand('test.open');
    await host.deactivate(PLUGIN_ID);
    expect(host.get(PLUGIN_ID)?.state).toBe('disposed');

    // Lazy activation is what makes the menu work after a hot reload has
    // disposed the plugin — the command has to bring it back.
    await host.invokeCommand('test.open');

    expect(host.get(PLUGIN_ID)?.state).toBe('active');
    expect(ran).toBe(2);
    expect(host.getPanel('test.main')).toBeDefined();
  });

  it('proxies ctx.fs straight through to the bridge', async () => {
    const calls: string[] = [];
    const fsBridge: WorkbenchHostBridge = {
      ...bridge,
      pickFile: async (filters) => {
        calls.push(`pickFile:${JSON.stringify(filters)}`);
        return '/tmp/picked.png';
      },
      readFile: async (p) => {
        calls.push(`readFile:${p}`);
        return new Uint8Array([1, 2, 3]);
      },
    };

    let bytes: Uint8Array | undefined;
    const plugin: Plugin = {
      async activate(ctx) {
        const picked = await ctx.fs.pickFile([{ name: 'Images', extensions: ['png'] }]);
        if (picked !== undefined) bytes = await ctx.fs.readFile(picked);
      },
    };
    const host = createPluginHost({
      bridge: fsBridge,
      importModule: async () => ({ plugin }),
    });
    host.load([manifest()]);

    await host.activate(PLUGIN_ID);

    expect(calls).toEqual([
      'pickFile:[{"name":"Images","extensions":["png"]}]',
      'readFile:/tmp/picked.png',
    ]);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(host.get(PLUGIN_ID)?.state).toBe('active');
  });

  it('proxies the write half of ctx.fs, injecting the plugin id on copyFile', async () => {
    const calls: string[] = [];
    const fsBridge: WorkbenchHostBridge = {
      ...bridge,
      pickDirectoryForWrite: async (pluginId, defaultPath) => {
        calls.push(`pickDirectoryForWrite:${pluginId}:${defaultPath ?? ''}`);
        return '/tmp/exports';
      },
      copyFile: async (pluginId, source, destDir) => {
        calls.push(`copyFile:${pluginId}:${source}:${destDir}`);
        return { name: 'photo-1.png', renamed: true };
      },
    };

    let result: { name: string; renamed: boolean } | undefined;
    const plugin: Plugin = {
      async activate(ctx) {
        const dir = await ctx.fs.pickDirectoryForWrite('/tmp/last-used');
        if (dir !== undefined) result = await ctx.fs.copyFile('/tmp/photo.png', dir);
      },
    };
    const host = createPluginHost({
      bridge: fsBridge,
      importModule: async () => ({ plugin }),
    });
    host.load([manifest()]);

    await host.activate(PLUGIN_ID);

    expect(calls).toEqual([
      // the plugin id is injected by the host, exactly as it is for copyFile —
      // the plugin only ever passes defaultPath, never its own id
      `pickDirectoryForWrite:${PLUGIN_ID}:/tmp/last-used`,
      `copyFile:${PLUGIN_ID}:/tmp/photo.png:/tmp/exports`,
    ]);
    expect(result).toEqual({ name: 'photo-1.png', renamed: true });
    expect(host.get(PLUGIN_ID)?.state).toBe('active');
  });

  it('scopes ctx.storage to the calling plugin id', async () => {
    const writes: string[] = [];
    const store = new Map<string, unknown>();
    const storageBridge: WorkbenchHostBridge = {
      ...bridge,
      storageGet: async (id, key) => store.get(`${id}/${key}`) as never,
      storageSet: async (id, key, value) => {
        writes.push(`${id}/${key}`);
        store.set(`${id}/${key}`, value);
      },
    };

    let roundTripped: unknown;
    const plugin: Plugin = {
      async activate(ctx) {
        await ctx.storage.set('doc', { text: '{"a":1}', expanded: ['$'] });
        roundTripped = await ctx.storage.get('doc');
      },
    };
    const host = createPluginHost({
      bridge: storageBridge,
      importModule: async () => ({ plugin }),
    });
    host.load([manifest()]);

    await host.activate(PLUGIN_ID);

    // the plugin never names itself — the host supplies the scope
    expect(writes).toEqual(['test/doc']);
    expect(roundTripped).toEqual({ text: '{"a":1}', expanded: ['$'] });
  });

  it('activates for a declared command with no matching activation event', async () => {
    let ran = 0;
    const plugin: Plugin = {
      activate(ctx) {
        ctx.registerCommand('test.declared', () => { ran += 1; });
      },
    };
    // activationEvents lists only test.open; the command lives in contributes
    const host = hostFor(plugin, manifest({
      activationEvents: ['onCommand:test.open'],
      contributes: { commands: [{ id: 'test.declared', title: 'Declared' }] },
    }));

    await host.invokeCommand('test.declared');

    expect(host.get(PLUGIN_ID)?.state).toBe('active');
    expect(ran).toBe(1);
  });

  it('lists commands from plugins that have never activated', async () => {
    const host = hostFor(noop, manifest({
      contributes: {
        commands: [
          { id: 'test.open', title: 'Open Test' },
          {
            id: 'test.args', title: 'With Args',
            args: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
          },
        ],
      },
    }));

    expect(host.get(PLUGIN_ID)?.state).toBe('discovered');

    const listed = host.listCommands();
    expect(listed.map((c) => c.id).sort()).toEqual(['test.args', 'test.open']);
    expect(listed.find((c) => c.id === 'test.args')?.args?.required).toEqual(['n']);
    // still not activated — listing must not have side effects
    expect(host.get(PLUGIN_ID)?.state).toBe('discovered');
  });

  it('makes a disabled plugin contribute nothing', async () => {
    let activations = 0;
    const plugin: Plugin = {
      activate(ctx) {
        activations += 1;
        ctx.registerCommand('test.open', () => undefined);
      },
    };
    const host = hostFor(plugin, manifest({
      contributes: { commands: [{ id: 'test.open', title: 'Open Test' }], accepts: ['text/plain'] },
    }));

    await host.setEnabled(PLUGIN_ID, false);
    await host.invokeCommand('test.open');

    expect(activations).toBe(0);
    expect(host.listCommands()).toEqual([]);
    expect(host.get(PLUGIN_ID)?.state).toBe('discovered');

    // and it is not a routing candidate
    const notices: string[] = [];
    host.onNotice((m) => notices.push(m));
    await host.emit({ type: 'text/plain', data: 'x' });
    expect(notices).toEqual(['No plugin accepts text/plain']);

    // re-enabling restores everything
    await host.setEnabled(PLUGIN_ID, true);
    await host.invokeCommand('test.open');
    expect(activations).toBe(1);
    expect(host.listCommands().map((c) => c.id)).toEqual(['test.open']);
  });

  it('tears down an active plugin when it is disabled', async () => {
    let disposed = false;
    const plugin: Plugin = {
      activate(ctx) { ctx.registerPanel('test.main', { mount: () => undefined }); },
      deactivate() { disposed = true; },
    };
    const host = hostFor(plugin, manifest({
      contributes: { panels: [{ id: 'test.main', title: 'T' }] },
    }));

    await host.activate(PLUGIN_ID);
    expect(host.getPanel('test.main')).toBeDefined();

    await host.setEnabled(PLUGIN_ID, false);

    expect(disposed).toBe(true);
    expect(host.get(PLUGIN_ID)?.state).toBe('disposed');
    expect(host.getPanel('test.main')).toBeUndefined();
  });

  it('restores a panel without needing a command for it', async () => {
    const plugin: Plugin = {
      activate(ctx) { ctx.registerPanel('test.main', { mount: () => undefined }); },
    };
    // no commands declared at all
    const host = hostFor(plugin, manifest({
      activationEvents: [],
      contributes: { panels: [{ id: 'test.main', title: 'T' }] },
    }));

    expect(await host.restorePanel('test.main')).toBe(true);
    expect(host.get(PLUGIN_ID)?.state).toBe('active');
    expect(host.getActivePanelId()).toBe('test.main');
  });

  it('refuses to restore a panel whose plugin is disabled', async () => {
    const plugin: Plugin = {
      activate(ctx) { ctx.registerPanel('test.main', { mount: () => undefined }); },
    };
    const host = hostFor(plugin, manifest({
      contributes: { panels: [{ id: 'test.main', title: 'T' }] },
    }));
    await host.setEnabled(PLUGIN_ID, false);

    expect(await host.restorePanel('test.main')).toBe(false);
    expect(host.get(PLUGIN_ID)?.state).toBe('discovered');
    expect(host.getActivePanelId()).toBeUndefined();
  });

  it('reports a failed restore for a panel that no longer exists', async () => {
    const host = hostFor(noop, manifest({ contributes: { panels: [] } }));
    expect(await host.restorePanel('gone.main')).toBe(false);
  });

  it('reports a failed restore when the plugin throws on activate', async () => {
    const broken: Plugin = { activate() { throw new Error('boom'); } };
    const host = hostFor(broken, manifest({
      contributes: { panels: [{ id: 'test.main', title: 'T' }] },
    }));

    expect(await host.restorePanel('test.main')).toBe(false);
    expect(host.get(PLUGIN_ID)?.state).toBe('failed');
  });

  it('marks a plugin failed when the module exports no activate()', async () => {
    const host = createPluginHost({ bridge, importModule: async () => ({}) });
    host.load([manifest()]);

    await host.activate(PLUGIN_ID);

    expect(host.get(PLUGIN_ID)?.state).toBe('failed');
    expect(host.get(PLUGIN_ID)?.error?.message).toBe('plugin exports no activate()');
  });
});
