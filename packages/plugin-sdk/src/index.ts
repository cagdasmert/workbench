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

  /**
   * Brokered filesystem access. Proxied to the main process over IPC — plugins
   * never touch `node:fs`.
   *
   * `readFile` only serves paths the user granted through `pickFile` in this
   * session. That makes `fs:read:user-selected` mean something instead of being
   * a comment, and keeps the bridge from being an arbitrary-file-read primitive.
   * Widening this needs a new permission scope and a decision-log entry.
   */
  fs: {
    pickFile(filters?: FileFilter[]): Promise<string | undefined>;
    /**
     * Backed by a plain `ArrayBuffer`, never a `SharedArrayBuffer`. Stating that
     * in the type is what lets a plugin pass the result straight to `Blob`,
     * `createImageBitmap` or a `DataView` without a cast or a defensive copy.
     */
    readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  };

  /**
   * Per-plugin key/value storage, persisted across restarts and scoped to this
   * plugin's id. Values must be JSON-serializable — that is enforced by the type
   * rather than discovered at runtime when a `Map` silently round-trips to `{}`.
   *
   * `delete` is deliberately absent until something needs it.
   */
  storage: {
    get<T extends JsonValue>(key: string): Promise<T | undefined>;
    set<T extends JsonValue>(key: string, value: T): Promise<void>;
  };

  workspace: {
    openPanel(panelId: string): Promise<void>;
    closePanel(panelId: string): Promise<void>;
  };

  ui: {
    notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<void>;
  };

  log: Logger;
}

/** Anything that survives a JSON round trip, and nothing that doesn't. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Extensions carry no leading dot: `['png', 'jpg']`. */
export interface FileFilter {
  name: string;
  extensions: string[];
}

export type CommandHandler = (...args: unknown[]) => void | Promise<void>;

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}
