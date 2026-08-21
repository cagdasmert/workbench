import type {
  CommandArgSchema,
  JsonValue,
  CommandHandler,
  Content,
  ContentHandler,
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

/** Owner id for commands contributed by the shell itself. */
export const SHELL_ID = '$shell';

export interface CommandDescriptor {
  id: string;
  title: string;
  /** Human-readable owner, for the palette's right-hand column. */
  source: string;
  pluginId: string;
  args?: CommandArgSchema;
}

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

/** Candidate targets when a payload matches more than one plugin. */
export interface RouteChoice {
  content: Content;
  candidates: Array<{ pluginId: string; name: string; panelId?: string }>;
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
  private readonly commands =
    new Map<string, { pluginId: string; handler: CommandHandler; title?: string }>();
  private readonly panelListeners = new Set<(panelId: string | undefined) => void>();
  private readonly reloadListeners = new Set<(pluginId: string) => void>();

  private readonly bridge: WorkbenchHostBridge;
  private readonly importModule: ImportModule;

  private readonly receivers = new Map<string, ContentHandler[]>();
  private readonly settingsListeners =
    new Map<string, Array<(key: string, value: JsonValue) => void>>();
  private readonly routeListeners = new Set<(choice: RouteChoice) => void>();
  private readonly noticeListeners = new Set<(msg: string) => void>();

  private readonly disabled = new Set<string>();

  private activePanelId: string | undefined;
  private activePayload: Content | undefined;
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

  // ── enable / disable ─────────────────────────────────────────────

  setDisabledIds(ids: string[]): void {
    this.disabled.clear();
    for (const id of ids) this.disabled.add(id);
  }

  isDisabled(pluginId: string): boolean {
    return this.disabled.has(pluginId);
  }

  /**
   * A disabled plugin contributes nothing and cannot be woken. Disabling one
   * that is already active tears it down through the normal disposal path, so
   * "disabled" and "never activated" look identical to the rest of the shell.
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (enabled) {
      this.disabled.delete(pluginId);
    } else {
      this.disabled.add(pluginId);
      const rec = this.registry.get(pluginId);
      if (rec !== undefined && rec.state === 'active') await this.deactivate(pluginId);
    }
    for (const cb of this.reloadListeners) cb(pluginId);
  }

  // ── activation ───────────────────────────────────────────────────

  async activate(pluginId: string): Promise<void> {
    const rec = this.registry.get(pluginId);
    if (rec === undefined) return;
    if (this.disabled.has(pluginId)) return;
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
  /** Called by the shell when a setting is written, so plugins observe one path. */
  notifySettingChanged(pluginId: string, key: string, value: JsonValue): void {
    for (const cb of this.settingsListeners.get(pluginId) ?? []) {
      try {
        cb(key, value);
      } catch (err) {
        console.error(`[plugin:${pluginId}] settings.onChange threw`, err);
      }
    }
  }

  onReload(cb: (pluginId: string) => void): () => void {
    this.reloadListeners.add(cb);
    return () => this.reloadListeners.delete(cb);
  }

  // ── commands ─────────────────────────────────────────────────────

  /**
   * Every command the app knows about, whether or not its plugin has activated.
   *
   * The palette has to list commands from inactive plugins — that is the entire
   * point of lazy activation (D4), and it is why argument schemas live in the
   * manifest rather than being passed to `registerCommand`: a schema that only
   * exists after activation is a schema the palette can never show.
   *
   * Shell commands registered through `registerShellCommand` are included, so
   * "every action is a command" holds with no exceptions (architecture §6).
   */
  listCommands(): CommandDescriptor[] {
    const out: CommandDescriptor[] = [];
    const seen = new Set<string>();

    for (const rec of this.registry.values()) {
      if (this.disabled.has(rec.manifest.id)) continue;
      for (const cmd of rec.manifest.contributes.commands ?? []) {
        seen.add(cmd.id);
        out.push({
          id: cmd.id,
          title: cmd.title,
          source: rec.manifest.name,
          pluginId: rec.manifest.id,
          ...(cmd.args === undefined ? {} : { args: cmd.args }),
        });
      }
    }

    // Registered but undeclared — shell commands, and any plugin that registers
    // a command it never put in its manifest.
    for (const [id, entry] of this.commands) {
      if (seen.has(id)) continue;
      out.push({
        id,
        title: entry.title ?? id,
        source: entry.pluginId === SHELL_ID ? 'Shell' : entry.pluginId,
        pluginId: entry.pluginId,
      });
    }

    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * Reopen a panel from a previous session. Deliberately distinct from
   * `invokeCommand`: the plugin owning a panel may declare no command for it,
   * and restoring must not depend on one existing.
   *
   * Returns false when the panel cannot be restored — the plugin is gone,
   * disabled, failed to activate, or no longer contributes that panel. All four
   * are normal after an update, so a failed restore is not an error.
   */
  async restorePanel(panelId: string): Promise<boolean> {
    const owner = [...this.registry.values()].find((rec) =>
      (rec.manifest.contributes.panels ?? []).some((p) => p.id === panelId));

    if (owner === undefined) return false;
    if (this.disabled.has(owner.manifest.id)) return false;

    await this.activate(owner.manifest.id);
    if (!this.panels.has(panelId)) return false;

    this.setActivePanel(panelId);
    return true;
  }

  /** Shell-owned commands. Same registry, same palette, no special path. */
  registerShellCommand(id: string, title: string, handler: CommandHandler): Disposable {
    this.commands.set(id, { pluginId: SHELL_ID, handler, title });
    return {
      dispose: () => {
        if (this.commands.get(id)?.handler === handler) this.commands.delete(id);
      },
    };
  }

  /** Lazy activation: activate whichever plugin declares `onCommand:<id>` first. */
  async invokeCommand(commandId: string, ...args: unknown[]): Promise<void> {
    if (!this.commands.has(commandId)) {
      // Explicit activation event first, then the implicit one: a plugin that
      // *declares* a command in contributes.commands has, by declaring it, said
      // the command should work. Requiring a matching onCommand: entry as well
      // means the palette lists commands that silently do nothing — the failure
      // is invisible because the palette closes either way.
      const owner = [...this.registry.values()].find((rec) =>
        rec.manifest.activationEvents.includes(`onCommand:${commandId}`))
        ?? [...this.registry.values()].find((rec) =>
          (rec.manifest.contributes.commands ?? []).some((c) => c.id === commandId));
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

  // ── content bus ──────────────────────────────────────────────────

  /**
   * Plugins that declare `type` in `accepts`, read from manifests alone — no
   * plugin is loaded to answer the question. `"*"` makes a universal sink.
   */
  private candidatesFor(type: string, excludePluginId?: string): PluginRecord[] {
    return [...this.registry.values()].filter((rec) => {
      if (this.disabled.has(rec.manifest.id)) return false;
      if (rec.manifest.id === excludePluginId) return false;   // never route to self
      const accepts = rec.manifest.contributes.accepts ?? [];
      return accepts.includes(type) || accepts.includes('*');
    });
  }

  /**
   * Route a payload. Exactly one candidate goes straight there; several raise a
   * "Send to…" choice in the shell; none produces a notice (architecture §5.2).
   */
  async emit(content: Content, fromPluginId?: string): Promise<void> {
    const stamped: Content = {
      ...content,
      meta: { ...content.meta, ...(fromPluginId === undefined ? {} : { sourcePluginId: fromPluginId }) },
    };

    const candidates = this.candidatesFor(stamped.type, fromPluginId);
    if (candidates.length === 0) {
      for (const cb of this.noticeListeners) cb(`No plugin accepts ${stamped.type}`);
      return;
    }
    if (candidates.length > 1) {
      for (const cb of this.routeListeners) {
        cb({
          content: stamped,
          candidates: candidates.map((rec) => ({
            pluginId: rec.manifest.id,
            name: rec.manifest.name,
            ...(rec.manifest.contributes.panels?.[0] === undefined
              ? {}
              : { panelId: rec.manifest.contributes.panels[0].id }),
          })),
        });
      }
      return;
    }

    const only = candidates[0];
    if (only !== undefined) await this.deliver(only.manifest.id, stamped);
  }

  /**
   * Deliver to one plugin: activate it, run its `onReceive` handlers as a
   * waterfall, then open its panel with whatever payload survived.
   */
  async deliver(pluginId: string, content: Content): Promise<void> {
    await this.activate(pluginId);

    let current = content;
    for (const handler of this.receivers.get(pluginId) ?? []) {
      try {
        const result = await handler(current);
        if (result === undefined) continue;                 // not handled, keep going
        if ('handled' in result) return;                    // short-circuit
        if ('content' in result) current = result.content;  // transformed
      } catch (err) {
        console.error(`[plugin:${pluginId}] content handler threw`, err);
      }
    }

    const rec = this.registry.get(pluginId);
    const panelId = rec?.manifest.contributes.panels?.[0]?.id;
    if (panelId !== undefined && this.panels.has(panelId)) {
      this.activePayload = current;
      this.setActivePanel(panelId);
    }
  }

  onRouteChoice(cb: (choice: RouteChoice) => void): () => void {
    this.routeListeners.add(cb);
    return () => this.routeListeners.delete(cb);
  }

  onNotice(cb: (msg: string) => void): () => void {
    this.noticeListeners.add(cb);
    return () => this.noticeListeners.delete(cb);
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
      ctx: {
        panelId,
        plugin: this.createContext(rec),
        ...(this.activePayload === undefined ? {} : { payload: this.activePayload }),
      },
    };
  }

  async closeActivePanel(): Promise<void> {
    this.activePayload = undefined;
    this.setActivePanel(undefined);
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

      fs: {
        pickFile: async (filters) => this.bridge.pickFile(filters),
        pickDirectory: async () => this.bridge.pickDirectory(),
        pickDirectoryForWrite: async (defaultPath) =>
          this.bridge.pickDirectoryForWrite(defaultPath),
        readDir: async (dirPath) => this.bridge.readDir(dirPath),
        readFile: async (filePath) => this.bridge.readFile(filePath),
        copyFile: async (sourcePath, destDir) =>
          this.bridge.copyFile(pluginId, sourcePath, destDir),
      },

      storage: {
        get: async (key) => await this.bridge.storageGet(pluginId, key) as never,
        set: async (key, value) => { await this.bridge.storageSet(pluginId, key, value); },
      },

      settings: {
        get: async (key) => await this.bridge.settingsGet(pluginId, key) as never,
        onChange: (cb) => {
          const list = this.settingsListeners.get(pluginId) ?? [];
          list.push(cb);
          this.settingsListeners.set(pluginId, list);
          return track(() => {
            const current = this.settingsListeners.get(pluginId) ?? [];
            const at = current.indexOf(cb);
            if (at !== -1) current.splice(at, 1);
          });
        },
      },

      net: {
        fetch: async (url, init) => {
          try {
            return await this.bridge.netFetch(pluginId, url, init);
          } catch (err) {
            // Electron prefixes every rejected invoke with
            // "Error invoking remote method 'x': Error: ..." — that wrapper is an
            // implementation detail of the bridge, not something a plugin should
            // have to parse or display.
            const raw = err instanceof Error ? err.message : String(err);
            throw new Error(raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
          }
        },
      },

      bus: {
        emit: async (content) => { await this.emit(content, pluginId); },
        onReceive: (handler) => {
          const list = this.receivers.get(pluginId) ?? [];
          list.push(handler);
          this.receivers.set(pluginId, list);
          return track(() => {
            const current = this.receivers.get(pluginId) ?? [];
            const at = current.indexOf(handler);
            if (at !== -1) current.splice(at, 1);
          });
        },
      },

      workspace: {
        openPanel: async (panelId, payload) => {
          if (!this.panels.has(panelId)) {
            throw new Error(`no panel registered with id "${panelId}"`);
          }
          this.activePayload = payload;
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
