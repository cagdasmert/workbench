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
    settings?: SettingsSchema;
    /**
     * Default chords only. User rebinds are stored separately by the shell and
     * always win, so shipping a new default in a plugin update never clobbers
     * one — see `keybindings.json` in architecture §7.
     */
    keybindings?: KeybindingContribution[];
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
     * Grants read access to the chosen directory and everything inside it, for
     * this session. Picking a folder is a broader grant than picking a file, and
     * deliberately so — a folder browser is unusable otherwise.
     */
    pickDirectory(): Promise<string | undefined>;
    /** One level only. Recursion is the plugin's decision, not the host's. */
    readDir(path: string): Promise<DirEntry[]>;
    /**
     * Backed by a plain `ArrayBuffer`, never a `SharedArrayBuffer`. Stating that
     * in the type is what lets a plugin pass the result straight to `Blob`,
     * `createImageBitmap` or a `DataView` without a cast or a defensive copy.
     */
    readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;

    /**
     * Grants write access to the chosen directory for this session. Deliberately
     * separate from `pickDirectory`: browsing a folder must never make it
     * writable, so the two grant sets never mix.
     *
     * `defaultPath` only positions the dialog. It is a convenience for offering
     * recent destinations and confers nothing on its own — the grant is still
     * the user confirming the dialog.
     */
    pickDirectoryForWrite(defaultPath?: string): Promise<string | undefined>;

    /**
     * Copies one file into a directory granted by `pickDirectoryForWrite`.
     *
     * Never overwrites. On a name collision the copy lands as `name-1.ext`,
     * `name-2.ext`, and the name actually written comes back in the result.
     * That is not politeness about user data: the copy is exclusive-create, and
     * refusing an existing destination is what stops a symlink planted at the
     * destination filename from redirecting the write outside the grant.
     *
     * One file per call. The plugin loops and owns its own concurrency, for the
     * same reason `readDir` does not recurse.
     */
    copyFile(sourcePath: string, destDir: string): Promise<CopyResult>;
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
   * Values for whatever this plugin declared in `contributes.settings`, with
   * declared defaults applied. Read-only by design: the shell owns the settings
   * UI and is the only writer, so there is exactly one path a value can change
   * by and `onChange` can be trusted.
   */
  settings: {
    get<T extends JsonValue>(key: string): Promise<T | undefined>;
    onChange(cb: (key: string, value: JsonValue) => void): Disposable;
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
export interface PropertySchema {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  enum?: string[];
  default?: string | number | boolean;
}

export interface CommandArgSchema {
  type: 'object';
  properties: Record<string, PropertySchema>;
  required?: string[];
}

/**
 * What a plugin declares in `contributes.settings`. The shell renders the form
 * from this — a plugin never builds one, and never writes a setting: the shell
 * is the single writer, plugins read and observe.
 */
export type SettingsSchema = Record<string, PropertySchema>;

/** Anything that survives a JSON round trip, and nothing that doesn't. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * `key` is a normalized chord: lowercase, modifiers first in the fixed order
 * `cmd alt ctrl shift`, joined by `+` — e.g. `cmd+k`, `cmd+shift+f`, `alt+enter`.
 * `cmd` means Command on macOS and Control elsewhere.
 */
export interface KeybindingContribution {
  command: string;
  key: string;
}

export interface DirEntry {
  name: string;
  /** Absolute, and already symlink-resolved by the host. */
  path: string;
  isDirectory: boolean;
  size: number;
  /** Epoch millis, so a plugin can sort by date without another round trip. */
  modified: number;
}

export interface CopyResult {
  /** Basename actually written. Differs from the source on a collision. */
  name: string;
  renamed: boolean;
}

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
