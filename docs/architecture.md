# Local Desktop Util — Architectural Blueprint

**Version:** 0.1 (Design / Pre-M0)
**Status:** Architecture defined, not yet scaffolded
**Working codename:** Workbench *(name TBD)*
**Tech Stack:** Electron 3x, TypeScript, React, Vite, esbuild, macOS 14+

---

## 1. Project Definition

### 1.1 Vision

A single local macOS application that hosts an open-ended and growing set of small
utilities — mermaid diagram viewer, image viewer, JSON formatter, and whatever comes
next — behind one window, one command palette, and one consistent set of keybindings.

The app is not a bundle of features. It is a **host shell plus a plugin contract**.
The features are deliberately disposable; the contract is the asset.

### 1.2 Core Philosophy: Contract Over Content

Every plugin-based application either gets its extension contract right early or
rewrites itself around plugin number four. This design therefore front-loads all
effort into the contract — manifest, lifecycle, host API, typed content bus — and
treats the first three viewers as *tests of that contract* rather than as goals.

Second principle: **compose, don't accumulate**. Twelve unrelated tabs in one window
is a worse web browser. The typed content bus (§5) is what makes each added plugin
increase the value of every plugin already installed.

### 1.3 Non-Goals

- Not a distributed or multi-user product. Single user, single machine, no accounts.
- Not a marketplace. Plugins are authored by the vault owner, loaded from disk.
- Not cross-platform in v1. macOS only; avoid platform abstraction until a second
  platform is actually wanted.
- No App Store distribution. Ad-hoc signing is sufficient for personal use.

---

## 2. Requirements

### 2.1 Functional

- **Plugin discovery:** the shell scans a plugins directory at startup and builds a
  registry from manifests without executing plugin code.
- **Lazy activation:** plugin code loads only when an activation event fires
  (command invoked, matching file opened, explicit menu selection).
- **UI contribution:** each plugin contributes at least one menu entry and one main
  panel that the shell mounts into the workspace area.
- **Command registry:** every user-triggerable action — shell or plugin — is a
  registered command, addressable from the command palette and bindable to a key.
- **Typed content routing:** the shell can route a typed payload from one plugin to
  any other plugin that declares it accepts that type.
- **Scoped persistence:** each plugin gets isolated key-value storage and a settings
  schema rendered by the shell.
- **Developer hot reload:** editing a plugin's source reloads that plugin in place
  without restarting the app.

### 2.2 Non-Functional

- **Cold start under 1s** to an interactive shell with zero plugins activated.
- **Fault containment:** a plugin that throws during activation or render must
  degrade to an error panel, never take down the window.
- **API stability:** the host API is versioned; a plugin declares `apiVersion` and
  the shell refuses to activate an incompatible one.
- **Offline first:** no network dependency for core function. Plugins that need
  network must declare it as a permission.
- **Migration-ready isolation:** the in-process plugin model must be replaceable by
  iframe or worker isolation without changing plugin source code.

---

## 3. System Architecture

### 3.1 Process Model

Standard Electron three-layer split, with a hard rule about where plugins live.

```
┌─────────────────────────────────────────────────────────┐
│ MAIN PROCESS (Node)                                     │
│  • window lifecycle, native menu bar, dock              │
│  • plugin discovery (manifest scan, no code execution)  │
│  • filesystem + permission broker                       │
│  • settings store, logging                              │
└───────────────────────┬─────────────────────────────────┘
                        │ typed IPC (contextBridge)
┌───────────────────────┴─────────────────────────────────┐
│ PRELOAD (isolated context)                              │
│  • the ONLY surface exposed to the renderer             │
│  • no Node globals leak past this line                  │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────┴─────────────────────────────────┐
│ RENDERER (React)                                        │
│  ┌───────────────────────────────────────────────────┐  │
│  │ SHELL: chrome, tabs, palette, settings, theming   │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ PLUGIN HOST: registry, activation, content bus    │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ PLUGINS (lazily imported ES modules)              │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Rule:** plugins run only in the renderer, and reach privileged capability only
through the host API, which proxies to main over IPC. No plugin ever imports `fs`.
This is what makes the later move to iframe isolation a host-only change.

### 3.2 Repository Layout

```
workbench/
├── packages/
│   ├── main/              # Electron main process
│   ├── preload/           # contextBridge surface
│   ├── shell/             # React app: chrome, palette, tabs, settings
│   ├── plugin-host/       # registry, loader, activation, content bus
│   └── plugin-sdk/        # public types + helpers, imported by plugins
├── plugins/
│   ├── hello/             # M0 contract test
│   ├── mermaid-viewer/
│   ├── image-viewer/
│   └── json-tools/
├── tools/
│   └── create-plugin/     # scaffolding CLI
└── package.json           # npm workspaces
```

`plugin-sdk` is the single package a plugin depends on. It contains types and thin
helpers only — no runtime coupling to the shell — so the SDK's shape *is* the
contract, enforced by the compiler.

---

## 4. The Plugin Contract

### 4.1 Anatomy

A plugin is a directory containing `plugin.json` and a built ES module entry point.

```json
{
  "id": "mermaid-viewer",
  "name": "Mermaid Viewer",
  "version": "1.0.0",
  "apiVersion": "1.0",
  "main": "./dist/index.js",
  "icon": "diagram",
  "activationEvents": [
    "onCommand:mermaid.open",
    "onFileType:.mmd",
    "onFileType:.mermaid",
    "onContentType:text/vnd.mermaid"
  ],
  "contributes": {
    "panels": [
      { "id": "mermaid.main", "title": "Mermaid", "icon": "diagram" }
    ],
    "menu": [
      { "command": "mermaid.open", "label": "Mermaid Viewer", "group": "viewers" }
    ],
    "commands": [
      { "id": "mermaid.open",   "title": "Open Mermaid Viewer" },
      { "id": "mermaid.export", "title": "Export Diagram as SVG" }
    ],
    "settings": {
      "theme":     { "type": "string",  "enum": ["default", "dark", "forest"], "default": "default" },
      "autoRender":{ "type": "boolean", "default": true }
    },
    "accepts": ["text/vnd.mermaid", "text/plain"],
    "emits":   ["image/svg+xml", "image/png"]
  },
  "permissions": ["fs:read:user-selected", "clipboard:write"]
}
```

Manifests are **declarative and executable-free**. The shell reads every manifest at
startup to build menus, the command palette, and the content-type routing table —
all without loading a single line of plugin code. That is what makes lazy activation
possible, and it means a broken plugin still shows up in the UI as a broken plugin
rather than vanishing.

### 4.2 Lifecycle

```typescript
// plugins/mermaid-viewer/src/index.ts
import type { Plugin, PluginContext } from '@workbench/plugin-sdk';

export const plugin: Plugin = {
  async activate(ctx: PluginContext) {
    ctx.registerPanel('mermaid.main', MermaidPanel);

    ctx.registerCommand('mermaid.open', async () => {
      await ctx.workspace.openPanel('mermaid.main');
    });

    ctx.registerCommand('mermaid.export', async () => {
      const svg = await renderCurrent();
      await ctx.bus.emit({ type: 'image/svg+xml', data: svg });
    });
  },

  async deactivate() {
    // release timers, watchers, workers
  },
};
```

States: `discovered` → `activating` → `active` → `deactivating` → `disposed`, plus a
terminal `failed` carrying the error for display in the plugin manager.

Everything registered through `ctx` is tracked by the host and torn down
automatically on deactivate. Plugins should not need cleanup discipline for
contributions — only for resources they created themselves.

### 4.3 Host API Surface (v1.0)

```typescript
export interface PluginContext {
  readonly id: string;
  readonly apiVersion: string;

  // ── contributions ──────────────────────────────────────────
  registerPanel(id: string, component: PanelComponent): Disposable;
  registerCommand(id: string, handler: CommandHandler): Disposable;
  registerContentHandler(type: ContentType, h: ContentHandler): Disposable;

  // ── scoped state ───────────────────────────────────────────
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  };
  settings: {
    get<T>(key: string): Promise<T>;
    onChange(cb: (key: string, value: unknown) => void): Disposable;
  };

  // ── brokered capability (permission-gated) ─────────────────
  fs: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    pickFile(filters?: FileFilter[]): Promise<string | undefined>;
    watch(path: string, cb: (event: FsEvent) => void): Promise<Disposable>;
  };

  // ── shell services ─────────────────────────────────────────
  workspace: {
    openPanel(panelId: string, payload?: Content): Promise<void>;
    closePanel(panelId: string): Promise<void>;
    activePanel(): Promise<string | undefined>;
  };
  bus: {
    emit(content: Content): Promise<void>;
    onReceive(cb: (content: Content) => void): Disposable;
  };
  ui: {
    notify(msg: string, level?: 'info' | 'warn' | 'error'): Promise<void>;
    confirm(msg: string): Promise<boolean>;
    theme(): Promise<Theme>;
    onThemeChange(cb: (t: Theme) => void): Disposable;
  };
  log: Logger;
}
```

**Every method is async and every method is serialization-safe.** No plugin receives
a host DOM node, a class instance, or a live object reference. This costs almost
nothing today and is the entire reason the isolation model (§4.4) can change later
without touching plugin source.

### 4.4 Isolation: In-Process Now, Sandboxed Later

**Decision:** plugins load as in-process ES modules via dynamic `import()`.

| | In-process (chosen) | Iframe per plugin | Worker + OS process |
|---|---|---|---|
| Startup cost | negligible | ~15ms each | ~30ms each |
| Crash containment | error boundary only | full | full |
| Dependency conflicts | shared realm | isolated | isolated |
| Rendering | direct React | postMessage bridge | postMessage bridge |
| Build effort | low | medium | high |

Rationale: single-author, single-user, all plugins trusted. Iframe isolation buys
crash safety that a React error boundary approximates well enough, at the cost of a
message-passing bridge for every interaction.

The mitigation is the async-only API shape above plus:

- every panel wrapped in an error boundary that renders a failure card with the
  stack trace and a **Reload plugin** button;
- activation wrapped in try/catch — failure marks the plugin `failed`, never
  propagates;
- a per-plugin `Disposable` registry so a failed plugin's contributions are
  guaranteed removable.

Migration trigger: if a plugin ever needs a conflicting dependency version, or a
third-party plugin is ever installed, move to iframes. Plugin source is unaffected.

### 4.5 Versioning

`apiVersion` follows semver. The host advertises a supported range; a plugin
declaring a major version outside it is listed as `incompatible` and not activated.
Breaking changes to `PluginContext` require a major bump and a documented migration
note in this file's decision log (§10).

---

## 5. The Typed Content Bus

The mechanism that turns a collection of utilities into an application.

### 5.1 Model

```typescript
export interface Content {
  type: ContentType;         // MIME-ish string
  data: Uint8Array | string | object;
  meta?: {
    filename?: string;
    sourcePluginId?: string;
    [k: string]: unknown;
  };
}
```

Every plugin declares `accepts` and `emits` in its manifest. The shell builds a
routing table from those declarations at startup, so when any plugin emits content
the shell knows — without loading anything — which plugins could receive it.

### 5.2 Flow

1. Plugin A calls `ctx.bus.emit({ type, data })`.
2. Shell looks up all plugins declaring that type in `accepts`.
3. Exactly one match → route directly. Multiple → show a **Send to…** picker.
   None → toast "no handler for `type`".
4. Target plugin activates if not already active, then receives the payload via
   `openPanel(panelId, content)` or its `onReceive` handler.

### 5.3 What This Buys

- JSON tools → *open as table* → CSV/table viewer
- Any text selection → *render as diagram* → mermaid viewer
- Mermaid viewer → *export* → image viewer → annotate → clipboard
- A future Ollama plugin → *text → mermaid* → straight into the mermaid viewer

Each new plugin multiplies rather than adds. The cost is one manifest field and one
routing table.

### 5.4 Type Registry

Standard MIME types where they exist (`image/png`, `application/json`, `text/csv`),
`text/vnd.*` for the rest (`text/vnd.mermaid`, `text/vnd.graphviz`). A plugin may
declare `"accepts": ["*"]` for universal sinks such as a clipboard or scratchpad.

---

## 6. Shell Services

Built once in the shell, available to every plugin. This list is roughly the
definition of "the shell is done".

| Service | Notes |
|---|---|
| **Command palette** (`⌘K`) | Fuzzy search over the command registry. Every action is a command — no exceptions, including shell actions. |
| **Panel/tab manager** | Tabs, split view, per-panel state persisted across restart. |
| **Menu bar** | Native macOS menu assembled from `contributes.menu`. |
| **Open-with routing** | Extension → plugin mapping. Drag-drop onto the window, plus `Open With` from Finder. |
| **Settings UI** | Generated from each plugin's JSON Schema — plugins never build settings forms. |
| **Keybinding registry** | User overrides stored separately from defaults so plugin updates never clobber them. |
| **Theming** | Follows macOS light/dark; exposes CSS custom properties consumed by plugins. |
| **Notifications** | Toasts + a log pane. |
| **Plugin manager** | Enable/disable/reload; shows `failed` plugins with stack traces. |
| **Session restore** | Reopen last panels and their state on launch. |

---

## 7. Storage & Filesystem Layout

Following macOS conventions:

```
~/Library/Application Support/Workbench/
├── settings.json          # shell settings
├── keybindings.json       # user overrides only
├── plugins/               # installed plugins, one dir each
├── plugin-data/<id>/      # per-plugin scoped storage
├── sessions/              # window/panel restore state
└── logs/

~/Library/Caches/Workbench/    # regenerable: thumbnails, renders
~/Developer/workbench-plugins/ # dev plugins, symlinked, hot-reloaded
```

Dev plugins load from a separate directory with file watching enabled, so the
authoring loop never touches installed state.

---

## 8. Developer Experience

The single factor that determines whether plugin #7 gets written.

- **Scaffolding:** `npm run create-plugin <name>` emits manifest, entry point, a
  panel component, and a build script — a working plugin in one command.
- **Hot reload:** the dev plugin directory is watched; on change the host calls
  `deactivate()`, disposes all contributions, re-imports the module with a cache-
  busting query string, and calls `activate()`. Panel state is preserved through
  the reload where the plugin opts in.
- **Type safety as contract:** `@workbench/plugin-sdk` types mean a contract
  violation is a compile error, not a runtime surprise.
- **Build:** esbuild per plugin (sub-second), Vite for the shell.
- **Plugin console:** a shell panel showing each plugin's log output, activation
  timing, and last error.

---

## 9. Security & Permissions

Enforcement is deferred; **declaration is not**. Manifests carry `permissions` from
day one because it documents the plugin's reach and marks the exact seam where
enforcement goes if this ever leaves one machine.

Permission grammar: `<capability>:<action>:<scope>` — e.g. `fs:read:user-selected`,
`fs:write:plugin-data`, `net:fetch:api.github.com`, `clipboard:write`, `shell:exec`.

Non-negotiable from the start, because these are not retrofittable:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- a strict CSP on the renderer
- all privileged operations brokered through main over typed IPC — never a raw
  `fs` handle across the bridge

macOS distribution: ad-hoc signing (`codesign -s -`) is sufficient for a locally
built personal app. No Developer ID or notarization needed unless the app is ever
moved to another machine.

---

## 10. Roadmap

| Milestone | Deliverable | Definition of Done |
|---|---|---|
| **M0** | Shell + `hello` plugin + hot reload | Window opens, menu shows a contributed entry, panel mounts, editing plugin source reloads it in place without app restart |
| **M1** | Plugin API v1 + first three viewers | Mermaid, image, and JSON plugins all built against the `0.x` SDK with zero shell changes required — which is what earns the `1.0` freeze (D8) |
| **M2** | Command palette + content bus | `⌘K` reaches every command; JSON → table and mermaid → SVG routing both work end to end |
| **M3** | Settings, keybindings, plugin manager | Settings UI generated from schema; failed plugins are visible and reloadable |
| **M4** | Packaging | `.app` bundle, ad-hoc signed, launches from `/Applications`, session restore works |

**M1 is the real test.** If any of the three viewers requires a change to the shell,
the contract is wrong and it is worth fixing before M2 rather than after.

---

## 11. Decision Log

| # | Decision | Rationale | Revisit when |
|---|---|---|---|
| D1 | Electron + TypeScript over Tauri / JavaFX / SwiftUI | Every target plugin is a rendering problem, and the rendering libraries (mermaid.js, monaco, exifr, pdf.js) live in JS | Bundle size or native integration becomes a real complaint |
| D2 | In-process plugins with an async-only API | Single trusted author; isolation is buyable later precisely because the API is serialization-safe | A dependency conflict appears, or a third-party plugin is installed |
| D3 | Typed content bus in v1 | Composition is the difference between an app and a tab bar; retrofitting it means rewriting every manifest | — |
| D4 | Lazy activation via manifest events | Impossible to retrofit once plugins assume eager startup | — |
| D5 | Permissions declared, not enforced | Documents reach and marks the enforcement seam at near-zero cost | The app ever runs someone else's plugin |
| D6 | macOS only, no platform abstraction | Premature abstraction for a single-user app | A second platform is genuinely wanted |
| D7 | No DeepSeek Harness, no Cordis — 2026-08-19 | Cordis is the plugin kernel DSH is built on, and its API is explicitly unstable; adopting it as *the kernel* is the exact risk this contract exists to avoid. DSH is a full agent harness for a need that is one-shot completions. Both rejected; see [[ai-layer-options]] | A plugin genuinely requires tool use, MCP, or sandboxed execution |
| D8 | Panels use `mount(el, ctx)` returning a teardown, and the SDK freezes at **M1**, not M0 — 2026-08-19 | Resolves §12's open question. A framework-agnostic `mount` keeps non-React plugins viable (canvas, D3, vanilla DOM) while `definePanel` in the `./react` entry point restores React ergonomics for those that want them. `mount` **returns** its teardown rather than the definition carrying `unmount()`: closure state on the definition allows only one live instance, which blocks two `.mmd` files or two images open at once and orphans the first React root. On the freeze point — the M0 SDK deliberately omits `storage`, `settings`, `fs`, and `bus`, so tagging it 1.0 would force 2.0 before the third plugin exists. 1.0 is declared when M1's three viewers have been built without a shell change | A plugin needs a panel API richer than mount/teardown, or M1 completes with the shell-change log non-empty |
| D9 | `@workbench/plugin-sdk` frozen at **1.0** — 2026-08-19 | M1's three viewers (mermaid, image, JSON) were all built without a single change to `packages/shell`, which is the test D8 set for the freeze. The SDK grew by `fs` and `storage` — both additive, neither touching `PanelDefinition`, `mount`, the lifecycle, `Disposable`, or the manifest. Six entries in [[m1-shell-change-log]], none a contract defect: four host-side bugs the first real plugins surfaced, one pre-release type narrowing, one plugin adapting to an inherent async race | A breaking change to `PluginContext` is genuinely unavoidable — which is now a major bump and a migration note, not an edit |

---

## 12. Open Questions

- **App name.** "Workbench" is a placeholder.
- **Multi-window.** One window with tabs, or detachable panels? Affects session
  restore design; probably defer to post-M4.
- **Large file handling.** Should `ctx.fs` stream for files above some threshold, or
  do plugins that need streaming get a separate capability?
- **Vault integration.** An Obsidian plugin (quick-search, append-to-daily-note)
  would make this app a daily driver rather than an occasional utility — worth
  promoting into M2?

---

*Related: [[project description]] · [[../_Project-Index|Project Index]]*
