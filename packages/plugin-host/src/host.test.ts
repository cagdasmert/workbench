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
  readFile: async () => new Uint8Array(),
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

  it('marks a plugin failed when the module exports no activate()', async () => {
    const host = createPluginHost({ bridge, importModule: async () => ({}) });
    host.load([manifest()]);

    await host.activate(PLUGIN_ID);

    expect(host.get(PLUGIN_ID)?.state).toBe('failed');
    expect(host.get(PLUGIN_ID)?.error?.message).toBe('plugin exports no activate()');
  });
});
