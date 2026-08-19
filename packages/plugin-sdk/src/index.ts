/**
 * @workbench/plugin-sdk 1.0 — FROZEN.
 *
 * Earned, not declared: mermaid, image, and JSON viewers were all built against
 * this surface without a single change to `packages/shell` (decision D8).
 *
 * From here, changes to `PluginContext` are versioned decisions, not drive-by
 * edits. Additive methods are a minor bump; changing or removing anything below
 * is a major bump plus a migration note in the architecture decision log.
 */

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
    commands?: Array<{
      id: string;
      title: string;
      /**
       * JSON-schema argument signature. Optional, but fill it in from a
       * command's first commit: a mature command registry is mechanically an
       * agent tool manifest, and retrofitting schemas onto sixty commands later
       * is the tedium that kills that idea (see `ai-layer-options.md` §5).
       */
      args?: CommandArgSchema;
    }>;
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

  /**
   * Brokered HTTP, proxied through main. Plugins cannot `fetch` directly: the
   * renderer's CSP would have to name every endpoint any plugin might ever use,
   * which puts plugin configuration in the shell.
   *
   * A request is allowed only if the manifest declares `net:fetch:<host>` (or
   * `net:fetch:*`) for that host. The declaration is the grant, exactly as the
   * file dialog is the grant for `fs`.
   */
  net: {
    fetch(url: string, init?: NetRequestInit): Promise<NetResponse>;
  };

  /**
   * Typed content routing. The shell builds a table from the `accepts`/`emits`
   * declared in every manifest, so it knows which plugins could receive a
   * payload without loading any of them.
   */
  bus: {
    emit(content: Content): Promise<void>;
    onReceive(handler: ContentHandler): Disposable;
  };

  workspace: {
    /** `payload` reaches the panel as `PanelContext.payload`. */
    openPanel(panelId: string, payload?: Content): Promise<void>;
    closePanel(panelId: string): Promise<void>;
  };

  ui: {
    notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<void>;
  };

  log: Logger;
}

// ─── brokered network ────────────────────────────────────────
export interface NetRequestInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Already-serialized body. Objects are the plugin's job to stringify. */
  body?: string;
  timeoutMs?: number;
}

export interface NetResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

// ─── content bus ─────────────────────────────────────────────
export interface Content {
  /** MIME where one exists, `text/vnd.*` otherwise. */
  type: string;
  data: string | Uint8Array | JsonValue;
  meta?: {
    filename?: string;
    sourcePluginId?: string;
    [k: string]: unknown;
  };
}

/**
 * Waterfall result. Architecture §5 describes Cordis-style middleware with a
 * `(payload, next)` signature, but passing `next` *into* a handler is a
 * callback-in-argument and invariant 2 forbids it — under iframe isolation
 * there is no way to hand a live function across the boundary.
 *
 * The same expressiveness comes back as a return value, which serializes:
 *
 * - `undefined` — not handled; the shell tries the next candidate
 * - `{ handled: true }` — stop here, short-circuiting the rest
 * - `{ content }` — transformed; the next handler sees the new payload
 */
export type ContentResult =
  | void
  | { handled: true }
  | { content: Content };

export type ContentHandler = (content: Content) => ContentResult | Promise<ContentResult>;

/**
 * A deliberately small subset of JSON Schema — enough to describe a command's
 * arguments, prompt for them in the palette, and hand them to a model later.
 * It is not a validator; the shell checks `required` and `type` and no more.
 */
export interface CommandArgSchema {
  type: 'object';
  properties: Record<string, {
    type: 'string' | 'number' | 'boolean';
    description?: string;
    enum?: string[];
    default?: string | number | boolean;
  }>;
  required?: string[];
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
