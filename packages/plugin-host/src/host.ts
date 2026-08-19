import type {
  CommandHandler,
  Disposable,
  Logger,
  PanelContext,
  PanelDefinition,
  Plugin,
  PluginContext,
  PluginManifest,
} from '@workbench/plugin-sdk';
import { getBridge, type WorkbenchHostBridge } from './bridge.js';

export type PluginState = 'discovered' | 'activating' | 'active' | 'failed' | 'disposed';

export interface PluginRecord {
  manifest: PluginManifest;
  state: PluginState;
  instance: Plugin | undefined;
  error: Error | undefined;
  disposables: Disposable[];
}

export interface ActivePanel {
  panelId: string;
  definition: PanelDefinition;
  ctx: PanelContext;
}

/** Injectable so tests never touch the plugin:// scheme. */
export type ImportModule = (url: string) => Promise<unknown>;

export interface PluginHostOptions {
  bridge?: WorkbenchHostBridge;
  importModule?: ImportModule;
}

const defaultImport: ImportModule = (url) => import(/* @vite-ignore */ url);

/** Narrow an imported module to a Plugin without trusting its shape. */
function pickPlugin(mod: unknown): Plugin | undefined {
  if (typeof mod !== 'object' || mod === null) return undefined;
  const candidate = (mod as { plugin?: unknown; default?: unknown }).plugin
    ?? (mod as { default?: unknown }).default;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return typeof (candidate as { activate?: unknown }).activate === 'function'
    ? (candidate as Plugin)
    : undefined;
}

export class PluginHost {
  readonly registry = new Map<string, PluginRecord>();

  private readonly panels = new Map<string, { pluginId: string; definition: PanelDefinition }>();
  private readonly commands = new Map<string, { pluginId: string; handler: CommandHandler }>();
  private readonly panelListeners = new Set<(panelId: string | undefined) => void>();
  private readonly reloadListeners = new Set<(pluginId: string) => void>();

  private readonly bridge: WorkbenchHostBridge;
  private readonly importModule: ImportModule;

  private activePanelId: string | undefined;
  /** True while reload() is swapping a module: the panel is coming straight back,
   *  so disposing its registration must not clear the active panel. Letting it
   *  clear causes the shell to unmount the container div mid-reload, taking the
   *  plugin's DOM with it. */
  private reloading = false;
  protected reloadCounter = 0;

  constructor(options: PluginHostOptions = {}) {
    this.bridge = options.bridge ?? getBridge();
    this.importModule = options.importModule ?? defaultImport;
  }

  // ── registry ─────────────────────────────────────────────────────

  load(manifests: PluginManifest[]): void {
    for (const manifest of manifests) {
      this.registry.set(manifest.id, {
        manifest,
        state: 'discovered',
        instance: undefined,
        error: undefined,
        disposables: [],
      });
    }
  }

  get(pluginId: string): PluginRecord | undefined {
    return this.registry.get(pluginId);
  }

  // ── activation ───────────────────────────────────────────────────

  async activate(pluginId: string): Promise<void> {
    const rec = this.registry.get(pluginId);
    if (rec === undefined) return;
    if (rec.state === 'active' || rec.state === 'activating') return;

    rec.state = 'activating';
    rec.error = undefined;
    try {
      const url = `plugin://${rec.manifest.id}/index.js`
        + `?v=${rec.manifest.version}-${this.reloadCounter}`;
      const instance = pickPlugin(await this.importModule(url));
      if (instance === undefined) throw new Error('plugin exports no activate()');

      await instance.activate(this.createContext(rec));

      rec.instance = instance;
      rec.state = 'active';
    } catch (err) {
      rec.state = 'failed';
      rec.error = err instanceof Error ? err : new Error(String(err));
      // Partial activation leaves partial registrations. `failed` has to mean
      // "contributed nothing", so unwind before giving up.
      await this.unwind(rec);
      console.error(`[plugin:${pluginId}] activation failed`, rec.error);
      // deliberately swallowed — a failed plugin must never break the shell
    }
  }

  /** Unwind every registration. Idempotent, and safe after a failed activation. */
  private async unwind(rec: PluginRecord): Promise<void> {
    // copy before reversing — Array.prototype.reverse() mutates in place
    for (const d of [...rec.disposables].reverse()) {
      try {
        await d.dispose();
      } catch (err) {
        console.error(`[plugin:${rec.manifest.id}] dispose failed`, err);
      }
    }
    rec.disposables = [];
  }

  async deactivate(pluginId: string): Promise<void> {
    const rec = this.registry.get(pluginId);
    if (rec === undefined) return;

    try {
      await rec.instance?.deactivate?.();
    } catch (err) {
      console.error(`[plugin:${pluginId}] deactivate threw`, err);
      // keep going — a throwing deactivate must not strand the registrations
    }
    await this.unwind(rec);
    rec.instance = undefined;
    rec.state = 'disposed';
  }

  /**
   * Swap a plugin's module in place.
   *
   * The ordering is the whole trick and is easy to get subtly wrong: capture open
   * panel state → deactivate fully → bump the counter → reactivate → restore.
   * Bumping first means the old module's disposers get looked up against the new
   * module; restoring before reactivation means opening a panel whose definition
   * no longer exists.
   */
  async reload(pluginId: string): Promise<void> {
    const rec = this.registry.get(pluginId);
    if (rec === undefined) return;

    const wasActive = rec.state === 'active';
    const active = this.activePanelId;
    const owned = [...this.panels.entries()]
      .filter(([, entry]) => entry.pluginId === pluginId)
      .map(([id]) => id);
    const reopen = active !== undefined && owned.includes(active) ? active : undefined;

    this.reloading = true;
    try {
      await this.deactivate(pluginId);
      this.reloadCounter += 1;        // new URL ⇒ fresh module. ESM URLs are cache keys.
      if (wasActive) await this.activate(pluginId);
    } finally {
      this.reloading = false;
    }

    if (reopen !== undefined && !this.panels.has(reopen)) {
      // the reloaded plugin no longer contributes the panel that was open
      this.setActivePanel(undefined);
    }
    for (const cb of this.reloadListeners) cb(pluginId);
  }

  /**
   * Fires after a reload. The shell needs this because `panelId` is unchanged
   * across a reload while the panel *definition* behind it is not — without a
   * signal, a memoised lookup would keep handing back the dead definition.
   */
  onReload(cb: (pluginId: string) => void): () => void {
    this.reloadListeners.add(cb);
    return () => this.reloadListeners.delete(cb);
  }

  // ── commands ─────────────────────────────────────────────────────

  /** Lazy activation: activate whichever plugin declares `onCommand:<id>` first. */
  async invokeCommand(commandId: string, ...args: unknown[]): Promise<void> {
    if (!this.commands.has(commandId)) {
      const owner = [...this.registry.values()].find((rec) =>
        rec.manifest.activationEvents.includes(`onCommand:${commandId}`));
      if (owner !== undefined) await this.activate(owner.manifest.id);
    }

    const entry = this.commands.get(commandId);
    if (entry === undefined) {
      console.warn(`[host] no handler for command "${commandId}"`);
      return;
    }
    try {
      await entry.handler(...args);
    } catch (err) {
      console.error(`[plugin:${entry.pluginId}] command "${commandId}" threw`, err);
    }
  }

  // ── panels ───────────────────────────────────────────────────────

  getPanel(panelId: string): ActivePanel | undefined {
    const entry = this.panels.get(panelId);
    if (entry === undefined) return undefined;
    const rec = this.registry.get(entry.pluginId);
    if (rec === undefined) return undefined;
    return {
      panelId,
      definition: entry.definition,
      ctx: { panelId, plugin: this.createContext(rec) },
    };
  }

  getActivePanelId(): string | undefined {
    return this.activePanelId;
  }

  onActivePanelChange(cb: (panelId: string | undefined) => void): () => void {
    this.panelListeners.add(cb);
    return () => this.panelListeners.delete(cb);
  }

  private setActivePanel(panelId: string | undefined): void {
    this.activePanelId = panelId;
    for (const cb of this.panelListeners) cb(panelId);
  }

  // ── the plugin-facing context ────────────────────────────────────

  private createContext(rec: PluginRecord): PluginContext {
    const pluginId = rec.manifest.id;

    const track = (dispose: () => void): Disposable => {
      const disposable: Disposable = { dispose };
      rec.disposables.push(disposable);
      return disposable;
    };

    const log: Logger = {
      debug: (msg, ...rest) => console.debug(`[plugin:${pluginId}]`, msg, ...rest),
      info: (msg, ...rest) => console.info(`[plugin:${pluginId}]`, msg, ...rest),
      warn: (msg, ...rest) => console.warn(`[plugin:${pluginId}]`, msg, ...rest),
      error: (msg, ...rest) => console.error(`[plugin:${pluginId}]`, msg, ...rest),
    };

    return {
      id: pluginId,
      apiVersion: rec.manifest.apiVersion,

      registerPanel: (panelId, definition) => {
        this.panels.set(panelId, { pluginId, definition });
        return track(() => {
          // only remove it if this registration still owns it
          if (this.panels.get(panelId)?.definition === definition) {
            this.panels.delete(panelId);
            if (this.activePanelId === panelId && !this.reloading) {
              this.setActivePanel(undefined);
            }
          }
        });
      },

      registerCommand: (commandId, handler) => {
        this.commands.set(commandId, { pluginId, handler });
        return track(() => {
          if (this.commands.get(commandId)?.handler === handler) {
            this.commands.delete(commandId);
          }
        });
      },

      workspace: {
        openPanel: async (panelId) => {
          if (!this.panels.has(panelId)) {
            throw new Error(`no panel registered with id "${panelId}"`);
          }
          this.setActivePanel(panelId);
        },
        closePanel: async (panelId) => {
          if (this.activePanelId === panelId) this.setActivePanel(undefined);
        },
      },

      ui: {
        notify: async (message, level) => {
          await this.bridge.notify(message, level);
        },
      },

      log,
    };
  }
}

export function createPluginHost(options: PluginHostOptions = {}): PluginHost {
  return new PluginHost(options);
}
