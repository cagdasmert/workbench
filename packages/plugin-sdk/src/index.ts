// ─── lifecycle ───────────────────────────────────────────────
export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface Plugin {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ─── panels ──────────────────────────────────────────────────
/**
 * Framework-agnostic panel contract. The host hands the plugin a detached
 * DOM element; the plugin owns everything inside it and returns a teardown.
 * Nothing React-specific crosses this boundary.
 */
export type PanelTeardown = () => void | Promise<void>;

export interface PanelDefinition {
  mount(el: HTMLElement, ctx: PanelContext):
    PanelTeardown | void | Promise<PanelTeardown | void>;
}

export interface PanelContext {
  readonly panelId: string;
  readonly plugin: PluginContext;
  /** Payload the panel was opened with. Unused in M0; the content bus lands in M2. */
  readonly payload?: unknown;
}

// ─── manifest (mirrors plugin.json) ──────────────────────────
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  main: string;
  activationEvents: string[];
  contributes: {
    panels?: Array<{ id: string; title: string }>;
    menu?: Array<{ command: string; label: string; group?: string }>;
    commands?: Array<{ id: string; title: string }>;
    /** Declared from day one, routed at M2. Parsed and ignored until then —
     *  so plugin.json files written during M1 never need revising. */
    accepts?: string[];
    emits?: string[];
    settings?: Record<string, unknown>;
  };
  permissions?: string[];
}

// ─── host API ────────────────────────────────────────────────
export interface PluginContext {
  readonly id: string;
  readonly apiVersion: string;

  registerPanel(panelId: string, def: PanelDefinition): Disposable;
  registerCommand(commandId: string, handler: CommandHandler): Disposable;

  workspace: {
    openPanel(panelId: string): Promise<void>;
    closePanel(panelId: string): Promise<void>;
  };

  ui: {
    notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<void>;
  };

  log: Logger;
}

export type CommandHandler = (...args: unknown[]) => void | Promise<void>;

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}
