# M0 Build Guide — Workbench Shell

**Target:** [[architecture|architecture.md]] M0 — shell + `hello` plugin + hot reload
**Audience:** you, driving a Claude Code session
**Assumes:** macOS, Node 20+, no prior Electron experience
**Decisions applied:** `mount(el, ctx)` panel API returning a teardown, with a React helper ([[architecture#11-decision-log|D8]]) · SDK freezes at M1, not M0 (D8) · name `Workbench` · npm workspaces
**Revised:** 2026-08-19 — corrected the `plugin://` CORS/MIME handling, split the dev-mode CSP, moved plugin builds out of the main process, and made `scripts/dev.mjs` its own step

---

## 0. How to Use This Guide

This is written to be handed to a Claude Code session in pieces. Each **Step** is one
commit-sized unit with a **Gate** — a concrete check that must pass before moving on. Do not
let the session run ahead of the gates; the value of M0 is proving the contract works, and a
gate that never ran is a contract that was never proven.

Suggested working pattern:

```
Step N → let Claude Code implement → run the Gate yourself → commit → next step
```

Drop [[claude-md-for-repo|CLAUDE.md]] into the repo root before you start. It carries the
architecture invariants so the session doesn't quietly violate them at 2am.

### Reading this as a Spring developer

A rough dictionary, since the mental models line up better than the syntax suggests:

| Electron/TS here | Spring equivalent |
|---|---|
| `PluginContext` | `ApplicationContext` |
| Plugin `activate(ctx)` | `@PostConstruct` on a bean |
| `Disposable` returned by every register call | `@PreDestroy`, but composable and enforced |
| `activationEvents` in the manifest | `@ConditionalOnProperty` / lazy bean init |
| Main ↔ renderer IPC | a local RPC boundary — treat it exactly as untrusted |
| npm workspace package | Maven module |

The one idea with no Spring analogue is the **renderer/main split**: the UI process is
untrusted and cannot touch the filesystem. Everything privileged is a message to main. That
constraint is the whole security model, and fighting it is the most common way people break
an Electron app.

---

## 1. Prerequisites

```bash
node --version    # want v20.x or v22.x
npm --version     # want 10+
git --version
```

If Node is missing or old, install via `nvm` rather than Homebrew — you'll want to pin it
per project later.

Pick a repo location **outside the Obsidian vault**. A `node_modules` tree inside a vault
makes Obsidian's indexer miserable.

```bash
mkdir -p ~/Developer/workbench && cd ~/Developer/workbench
git init
```

---

## 2. What M0 Delivers

**Definition of done** — all five must be true:

1. `npm run dev` opens a window
2. The macOS menu bar shows an entry contributed by the `hello` plugin's manifest
3. Clicking it mounts the plugin's panel into the window
4. Editing the plugin's source reloads it in place — no app restart, no window flash
5. The plugin's panel is unmounted and its registrations disposed on reload, with no leaks

**Explicitly NOT in M0** — resist all of these, they belong to M1+:

command palette · tabs/splits · settings UI · theming beyond a stylesheet · the content bus ·
permissions enforcement · real viewers · packaging · session restore

M0 is a contract test wearing an application costume.

---

## 3. Target Layout

```
workbench/
├── package.json                  # workspace root
├── tsconfig.base.json
├── CLAUDE.md
├── packages/
│   ├── plugin-sdk/               # types only — the contract
│   ├── main/                     # Electron main process
│   ├── preload/                  # contextBridge surface
│   ├── plugin-host/              # registry, loader, disposal
│   └── shell/                    # React UI
├── plugins/
│   └── hello/
│       ├── plugin.json
│       └── src/index.ts
└── scripts/
    ├── dev.mjs                   # orchestrates the dev processes (Step 8)
    └── build-plugins.mjs         # one-shot plugin build, shares dev.mjs's config
```

Five packages feels like a lot for a hello-world. It isn't ceremony: `plugin-sdk` must not
depend on anything, and `plugin-host` must not depend on Electron — those two constraints are
what keep the iframe migration (D2) open, and they're only enforceable at package boundaries.

---

## 4. Step 1 — Workspace Skeleton

```bash
npm init -y
npm pkg set name=workbench private=true
npm pkg set workspaces[0]='packages/*' workspaces[1]='plugins/*'
npm pkg set type=module
```

Root `package.json` scripts (fill in as steps land):

```json
{
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "typecheck": "tsc -b",
    "test": "vitest run",
    "build:plugins": "node scripts/build-plugins.mjs"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true
  }
}
```

`strict: true` is not optional. The SDK types *are* the plugin contract — a loose compiler
means contract violations surface at runtime in a plugin instead of at build time in your
editor, which defeats the point of §4.3 of the architecture.

Install the toolchain:

```bash
npm i -D typescript electron vite @vitejs/plugin-react esbuild chokidar vitest
npm i -D @types/react @types/react-dom @types/node
npm i react react-dom
```

`vitest` is not optional. Gate 5 demands a unit test and there is otherwise nothing to run
one with — it is the single easiest gate to skip by accident. `electron-builder` is
deliberately absent: it belongs to M4 and installing it now just slows every `npm i` for
four milestones.

> **Gate 1:** `npm run typecheck` exits 0 (trivially — there's no code yet). `npx electron --version` prints a version.

---

## 5. Step 2 — The SDK (`packages/plugin-sdk`)

**This is the most important file in the project.** Everything downstream is replaceable;
this is the thing that, if wrong, forces the rewrite. Write it first, deliberately, before
any UI exists.

Types only — no runtime imports, no Electron, no React in the core file.

`packages/plugin-sdk/src/index.ts`:

```typescript
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
```

**Three invariants to enforce here, forever:**

1. **Every method returning data is `async`.** `openPanel` and `notify` return `Promise<void>`
   even though M0 could answer synchronously. That is deliberate — the moment one method is
   sync, the iframe migration (D2) becomes a rewrite of every plugin instead of a host change.
   This is the single easiest thing to get wrong and the most expensive to fix.
2. **Nothing non-serializable crosses.** No class instances, no DOM nodes, no functions in
   arguments — with the deliberate exception of `mount(el, ...)`, which receives a real
   element because it must. When isolation arrives, `mount` is the *only* thing that needs a
   different implementation. That's the point of confining it to one method.
3. **A panel definition holds no per-mount state.** `mount` returns its own teardown rather
   than the definition carrying an `unmount()` over closure state. One definition has to be
   mountable twice — M1 wants two `.mmd` files open at once — and a shared `let root` makes
   that structurally impossible *and* orphans the first React root, a leak that looks exactly
   like a hot-reload bug. The teardown crosses the same seam `mount(el, …)` already does, so
   invariant 2 is untouched: under isolation the host proxies the returned teardown exactly
   as it would have proxied `unmount()`.

Now the React convenience layer, in a **separate entry point** so the core stays framework-free:

`packages/plugin-sdk/src/react.ts`:

```typescript
import { createRoot } from 'react-dom/client';
import {
  Component as ReactComponent, createElement,
  type ComponentType, type ReactNode,
} from 'react';
import type { PanelDefinition, PanelContext } from './index.js';

/**
 * Architecture invariant 7 ("panels render inside error boundaries") lives here,
 * not in the shell. A plugin's React tree is its own createRoot, so a boundary in
 * the shell's tree cannot see into it — it has to be inside definePanel.
 */
class PanelErrorBoundary extends ReactComponent<
  { children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override render() {
    if (!this.state.error) return this.props.children;
    return createElement(
      'pre',
      { className: 'panel-error' },
      `${this.state.error.message}\n\n${this.state.error.stack ?? ''}`,
    );
  }
}

export function definePanel(
  Component: ComponentType<{ ctx: PanelContext }>,
): PanelDefinition {
  return {
    mount(el, ctx) {
      const root = createRoot(el);
      root.render(createElement(PanelErrorBoundary, null,
        createElement(Component, { ctx })));
      return () => root.unmount();     // per-mount state — no shared closure
    },
  };
}
```

Export both from `package.json`:

```json
{
  "name": "@workbench/plugin-sdk",
  "type": "module",
  "exports": {
    ".":       "./dist/index.js",
    "./react": "./dist/react.js"
  }
}
```

A plugin that wants React imports `@workbench/plugin-sdk/react`. A plugin that wants a canvas,
a vanilla DOM tree, or D3 imports only the core and never pulls React in. That separation is
the entire reason for choosing this panel API over React components.

> **Gate 2:** `npm run typecheck` passes. `packages/plugin-sdk/src/index.ts` imports nothing.

---

## 6. Step 3 — Main Process (`packages/main`)

Three jobs: create the window, scan plugin manifests, serve plugin code over a custom protocol.

### 6.1 Window

```typescript
import { app, BrowserWindow, protocol, session } from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    titleBarStyle: 'default',           // see note below
    webPreferences: {
      preload: path.join(__dirname, '../../preload/dist/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../../shell/dist/index.html'));
  }
  return win;
}
```

`titleBarStyle: 'hiddenInset'` is tempting and wrong for M0: it insets the traffic lights
over your content and leaves the window with no draggable region until you build a custom
titlebar with `-webkit-app-region: drag`. That's chrome work, and chrome work is not M0.
Take `'default'` now and revisit at M4.

Those three `webPreferences` flags are non-negotiable per §9 of the architecture. `sandbox:
true` restricts what the preload script may import — it gets `electron` and little else,
which is all it should need. If you ever find yourself wanting to turn one of these off,
the design is wrong somewhere else.

### 6.2 Plugin discovery

Scan directories, parse `plugin.json`, **never execute plugin code here**. Main is the
privileged process; running plugin code in it would collapse the security model.

```typescript
import { readdir, readFile } from 'node:fs/promises';

export async function scanPlugins(dir: string): Promise<PluginManifest[]> {
  const out: PluginManifest[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;                       // directory absent is not an error
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const raw = await readFile(path.join(dir, e.name, 'plugin.json'), 'utf8');
      out.push(validateManifest(JSON.parse(raw)));
    } catch (err) {
      console.error(`[plugin] bad manifest in ${e.name}:`, err);
      // keep going — one broken plugin must not stop discovery
    }
  }
  return out;
}
```

`validateManifest` should check required fields and that `apiVersion` is in the supported
range, throwing with a useful message otherwise. A hand-written check is fine for M0; a
schema validator is M3.

### 6.3 Serving plugin code

The renderer needs to `import()` plugin bundles, but it can't read the filesystem. Register a
custom protocol so plugin code has a URL:

```typescript
// before app.whenReady()
protocol.registerSchemesAsPrivileged([
  { scheme: 'plugin', privileges: {
      standard: true, secure: true, supportFetchAPI: true,
      corsEnabled: true,                 // ← see the CORS note below
  }},
]);

// after app.whenReady()
protocol.handle('plugin', async (request) => {
  const url  = new URL(request.url);         // plugin://hello/index.js
  const root = pluginRoots.get(url.hostname);
  if (!root) return new Response('not found', { status: 404 });

  const distRoot = path.join(root, 'dist');
  const filePath = path.resolve(distRoot, '.' + decodeURIComponent(url.pathname));
  const rel      = path.relative(distRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return new Response('forbidden', { status: 403 });   // path traversal guard
  }

  try {
    return new Response(await readFile(filePath), { headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',       // hot reload must never hit a cache
    }});
  } catch {
    return new Response('not found', { status: 404 });
  }
});
```

**The three response headers are load-bearing, and this is the single most likely thing in
M0 to cost you an evening.** In dev the renderer's origin is `http://localhost:5173`, so
`import('plugin://hello/index.js')` is a *cross-origin* request — and module scripts are
always fetched in CORS mode. Which means:

- the scheme must be registered `corsEnabled: true`, or Chromium won't do CORS on it at all;
- the response needs `Access-Control-Allow-Origin`, which `net.fetch()` on a `file://` URL
  does not send;
- the response needs a JavaScript MIME type, or you get *"Expected a JavaScript module
  script but the server responded with a MIME type of …"* and nothing loads.

The failure surfaces as a CORS or MIME error on a dynamic import, which reads like a bundler
problem and sends you hunting through Vite config. It isn't. It's this.

Two details in the guard are also deliberate:

- **`path.relative`, not `startsWith`.** `filePath.startsWith(distRoot)` happily accepts a
  sibling directory named `dist-evil`.
- **`decodeURIComponent` before the check.** Without it, percent-encoded traversal
  (`%2e%2e%2f`) sails past the guard and reaches the filesystem call.

Keep the guard. It is five lines and it is the difference between a plugin URL handler and
an arbitrary-file-read primitive.

### 6.4 Content Security Policy

The CSP has to differ between dev and prod — Vite's React Fast Refresh injects inline
scripts and opens an HMR websocket, both of which a production-strict policy blocks, leaving
you with a blank window. A hardcoded `<meta>` tag cannot express that difference, so set the
header from main instead, in one place:

```typescript
// inside app.whenReady(), before the window is created
session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
  const csp = DEV
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' plugin:; " +
      "style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:5173;"
    : "default-src 'self'; script-src 'self' plugin:; " +
      "style-src 'self' 'unsafe-inline'; connect-src 'self';";
  cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
});
```

Architecture §9 still holds: the shipped policy is the strict one, and `'unsafe-inline'` is
scoped to the dev server alone. Note `plugin:` appears in **both** — omit it and the module
import from §6.3 is blocked silently.

### 6.5 Native menu

Build the macOS menu from the collected manifests. A click sends the command id to the
renderer — main never invokes plugin code directly.

```typescript
import { Menu } from 'electron';

function buildMenu(manifests: PluginManifest[], win: BrowserWindow) {
  const pluginItems = manifests.flatMap((m) =>
    (m.contributes.menu ?? []).map((item) => ({
      label: item.label,
      click: () => win.webContents.send('command:invoke', item.command),
    })),
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Plugins', submenu: pluginItems },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}
```

> **Gate 3:** `npx electron packages/main/dist/index.js` opens an empty window with a **Plugins** menu. `console.log` in `scanPlugins` shows the manifest once `hello` exists.

---

## 7. Step 4 — Preload (`packages/preload`)

The only surface the renderer sees. Small on purpose — every line here is attack surface.

Note it must be built as **CommonJS** (`.cjs`); Electron does not load ESM preload scripts
under `sandbox: true`. The extension is doing real work here, not following a convention:
the workspace root sets `"type": "module"`, so a preload emitted as `index.js` would be
parsed as ESM and fail to load. `.cjs` is what overrides that per-file. When
`window.workbenchHost` comes back `undefined`, this is the first thing to check — and the
error appears in the **main** process console, not DevTools.

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('workbenchHost', {
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  notify: (msg: string, level = 'info') => ipcRenderer.invoke('ui:notify', msg, level),

  onCommand: (cb: (commandId: string) => void) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('command:invoke', listener);
    return () => ipcRenderer.off('command:invoke', listener);
  },
  onPluginChanged: (cb: (pluginId: string) => void) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('plugin:changed', listener);
    return () => ipcRenderer.off('plugin:changed', listener);
  },
});
```

Every subscription returns its own unsubscribe function. Not a convenience — hot reload will
re-register listeners on every plugin edit, and without disposal you get duplicate handlers
that are maddening to diagnose because everything *works*, just twice.

> **Gate 4:** in DevTools console, `window.workbenchHost` is an object; `await window.workbenchHost.listPlugins()` returns `[]` or the hello manifest.

---

## 8. Step 5 — Plugin Host (`packages/plugin-host`)

Runs in the renderer. **Must not import Electron.** It talks to `window.workbenchHost` and
nothing else — that constraint is what lets it move into an iframe or worker later untouched.

### 8.1 Registry

```typescript
type PluginState = 'discovered' | 'activating' | 'active' | 'failed' | 'disposed';

interface PluginRecord {
  manifest: PluginManifest;
  state: PluginState;
  instance?: Plugin;
  disposables: Disposable[];
  error?: Error;
}
```

### 8.2 Activation

```typescript
async function activate(rec: PluginRecord): Promise<void> {
  if (rec.state === 'active' || rec.state === 'activating') return;
  rec.state = 'activating';
  try {
    const url = `plugin://${rec.manifest.id}/index.js?v=${rec.manifest.version}-${reloadCounter}`;
    const mod = await import(/* @vite-ignore */ url);
    const instance: Plugin = mod.plugin ?? mod.default;
    if (!instance?.activate) throw new Error('plugin exports no activate()');

    const ctx = createContext(rec);          // every register() pushes to rec.disposables
    await instance.activate(ctx);

    rec.instance = instance;
    rec.state = 'active';
  } catch (err) {
    rec.state = 'failed';
    rec.error = err as Error;
    await unwind(rec);           // ← partial activation left partial registrations
    console.error(`[plugin:${rec.manifest.id}] activation failed`, err);
    // deliberately swallowed — a failed plugin must never break the shell
  }
}
```

`/* @vite-ignore */` is required or Vite tries to resolve the dynamic import at build time
and fails on the custom scheme.

The `reloadCounter` in the query string is what makes hot reload possible: ES module URLs are
cache keys, so the same URL never re-fetches. Change the URL, get fresh code.

The `unwind(rec)` in the catch block is easy to leave out and expensive to leave out. A
plugin that registers a panel and *then* throws has a live panel sitting in the registry
pointing at a module that failed to load. `failed` has to mean "contributed nothing", or the
plugin manager in M3 will offer to reload something that is half-present.

### 8.3 Disposal — get this exactly right

```typescript
/** Unwind every registration. Idempotent, and safe after a failed activation. */
async function unwind(rec: PluginRecord): Promise<void> {
  // copy before reversing — Array.prototype.reverse() mutates in place
  for (const d of [...rec.disposables].reverse()) {
    try { await d.dispose(); } catch (err) { console.error('dispose failed', err); }
  }
  rec.disposables = [];
}

async function deactivate(rec: PluginRecord): Promise<void> {
  try {
    await rec.instance?.deactivate?.();
  } catch (err) {
    console.error(`[plugin:${rec.manifest.id}] deactivate threw`, err);
    // keep going — a throwing deactivate must not strand the registrations
  }
  await unwind(rec);
  rec.instance = undefined;
  rec.state = 'disposed';
}
```

Four properties that matter, all learned the hard way by everyone who has built this:

- **Reverse order** — later registrations may depend on earlier ones.
- **Copy before reversing** — `reverse()` mutates. Here the array is cleared immediately
  afterwards so it happens to be harmless, but this is the pattern every future disposer in
  the codebase gets copied from. Teach it correctly once.
- **Each disposal in its own try/catch** — one throwing disposer must not strand the rest,
  and neither must a throwing `deactivate()`.
- **Unwinding runs even if activation failed** — which is why `unwind` is extracted rather
  than living inside `deactivate`. §8.2's catch block calls it directly.

This is the `ctx.effect()` discipline from the Cordis analysis, hand-rolled. It's ~20 lines
and it's the reason hot reload will actually work instead of slowly leaking panels.

**One thing disposal does *not* fix:** every `?v=` bump leaves the previous module in the ES
module registry permanently. There is no unimport. This is normal — Vite's own HMR retains
modules the same way — but write it down, because someone auditing verification check #8
will find heap retention climbing across reloads and conclude the disposal logic is broken.
Check #8 is about **DOM subtrees**, not memory.

### 8.4 The disposal test

`plugin-host` imports no Electron (invariant 4), so it unit-tests under plain Vitest against
a stub `window.workbenchHost` — no Electron harness, no spectron, no window. That ease is a
direct payoff of the invariant, and it is worth noticing that the constraint bought you
something concrete rather than only costing you a package boundary.

Five cases, minimum:

1. two disposables run in **reverse** registration order
2. a **throwing** first disposer does not prevent the second from running
3. `deactivate` after a **failed activation** still unwinds partial registrations *(§8.2)*
4. `deactivate` is **idempotent** — calling it twice does not re-run disposers
5. a plugin whose **`deactivate()` throws** still has its disposables unwound

> **Gate 5:** `npm test` — all five cases green. This is the highest-value test in M0 and the easiest one to skip; every hot-reload bug you don't have in Step 9 was prevented here.

---

## 9. Step 6 — Shell (`packages/shell`)

Minimal. A container div, a panel mount point, and command routing.

```tsx
function PanelHost({ panel }: { panel: ActivePanel | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !panel) return;

    let disposed = false;
    let teardown: PanelTeardown | void;
    const run = () => {
      try { return teardown?.(); } catch (err) { console.error('teardown failed', err); }
    };

    const mounted = Promise.resolve(panel.definition.mount(el, panel.ctx))
      .then((t) => { teardown = t; if (disposed) return run(); })
      .catch((err) => renderErrorCard(el, err));   // invariant 7, non-React path

    return () => {
      disposed = true;
      void mounted.then(() => { run(); el.replaceChildren(); });
    };
  }, [panel]);

  return <div ref={ref} className="panel-host" />;
}
```

Three things are going on here, and the naive version gets all three wrong.

**`mount` is async, so the cleanup has to wait for it.** Fire-and-forget the mount promise
and a fast reload can run teardown before the teardown function even exists, or mount into an
element React has already detached. Chaining cleanup off `mounted` and re-checking `disposed`
inside the `.then` is what makes rapid saves safe. This is the bug that shows up as a ghost
panel after the eighth reload and is nearly impossible to attribute.

**The `.catch` is invariant 7's other half.** The `PanelErrorBoundary` inside `definePanel`
catches *render* errors in React plugins. It cannot catch a `mount` that throws before any
tree exists, and it does not exist at all for a plugin that draws to a canvas. `renderErrorCard`
is a plain-DOM fallback — a `<pre>` with the message and stack — and between the two, no
plugin failure reaches the shell.

**`el.replaceChildren()` after teardown is defensive.** The plugin owns that subtree and React
has no idea what's in it, so if a plugin's teardown is incomplete you'd otherwise get ghost
DOM stacking up across reloads — which looks exactly like a hot-reload bug and isn't.

Wire the command bridge once, at app level:

```typescript
useEffect(() => window.workbenchHost.onCommand((id) => host.invokeCommand(id)), []);
```

Note it returns the unsubscribe directly — that's why preload returns one.

> **Gate 6:** the window renders your shell chrome, DevTools shows no errors.

---

## 10. Step 7 — The `hello` Plugin

`plugins/hello/plugin.json`:

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "apiVersion": "1.0",
  "main": "./dist/index.js",
  "activationEvents": ["onCommand:hello.open"],
  "contributes": {
    "panels":   [{ "id": "hello.main", "title": "Hello" }],
    "menu":     [{ "command": "hello.open", "label": "Hello Panel" }],
    "commands": [{ "id": "hello.open", "title": "Open Hello Panel" }]
  }
}
```

`plugins/hello/src/index.ts`:

```typescript
import type { Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('hello activating');

    ctx.registerPanel('hello.main', definePanel(({ ctx: panelCtx }) => (
      <div style={{ padding: 24, fontFamily: 'system-ui' }}>
        <h1>Hello from {panelCtx.plugin.id}</h1>
        <p>Edit this file and watch it reload.</p>
      </div>
    )));

    ctx.registerCommand('hello.open', () => ctx.workspace.openPanel('hello.main'));
  },

  deactivate() {
    console.log('hello deactivating');
  },
};
```

Build each plugin with esbuild to a single ESM file, marking React external if you want to
share the shell's copy — or bundling it if you'd rather prove dependency independence. For
M0, bundle it: a fatter file, but it demonstrates that plugins are self-contained, which is
the property that matters when isolation arrives.

Put that invocation in `scripts/build-plugins.mjs` as an esbuild config object rather than a
shell string — Step 8 needs the identical config in watch mode, and the two drifting apart
produces a plugin that works in dev and not in prod.

```bash
esbuild plugins/hello/src/index.ts \
  --bundle --format=esm --jsx=automatic \
  --outfile=plugins/hello/dist/index.js
```

> **Gate 7:** `npm run build:plugins` produces `plugins/hello/dist/index.js`. Open it — it must be ESM (`export`, no `require`). Nothing runs it yet; Step 8 builds the thing that does.

---

## 11. Step 8 — The Dev Orchestrator

`scripts/dev.mjs` is the fiddliest piece of M0 and it is what deliverable #1 — `npm run dev`
— actually *is*. It gets its own step because treating it as a filename in a directory tree
is how you end up debugging four build pipelines at once at midnight.

Responsibilities, in order:

1. esbuild watch context → `packages/preload`, format **cjs**, outfile `index.cjs`
2. esbuild watch context → `packages/main`, format esm
3. esbuild watch context per plugin → `plugins/*/dist/index.js`,
   `--format=esm --jsx=automatic --bundle` *(the same config object as `build-plugins.mjs`)*
4. start Vite, wait for it to report its URL — don't hardcode `5173`, it moves when taken
5. spawn Electron with `VITE_DEV_SERVER_URL` set from step 4
6. on a **main or preload** rebuild, kill and respawn Electron; on a **plugin** rebuild, do
   nothing — Step 9's watcher handles that, and restarting the app defeats the entire point
7. one `SIGINT`/`SIGTERM` handler that tears down Vite, every esbuild context, and Electron

Point 6 is the one to get right. Restarting Electron on a plugin change is easy, works, and
makes Step 9 look finished when it isn't — you'd have built a slow app restart and called it
hot reload. Keep the two paths visibly separate.

Point 7 is not politeness. Without it `^C` strands an Electron process holding the port, and
the next `npm run dev` fails with an error that has nothing to do with what you changed.

> **Gate 8 (DoD 1–3):** `npm run dev` → window opens → **Plugins → Hello Panel** → the panel appears. `^C` leaves no stray processes (`pgrep -f electron` is empty). Three of five done.

---

## 12. Step 9 — Hot Reload

The feature that decides whether plugin #7 gets written.

**Main** watches build *output* and notifies — it does not build:

```typescript
import chokidar from 'chokidar';

chokidar
  .watch(path.join(PLUGIN_DEV_DIR, '*/dist/index.js'), { ignoreInitial: true })
  .on('change', debounce(100, (file) => {
    const pluginId = pluginIdFromDistPath(file);
    win.webContents.send('plugin:changed', pluginId);
  }));
```

Note what main is *not* doing: it does not import esbuild and it does not compile anything.
The watch contexts from Step 8 own that. This matters for two reasons.

The architectural one: keeping build tooling out of the privileged process keeps main's job
the three things §6 says it is — window, manifests, files. Invariant 9 says main never
executes plugin code, and running a bundler over plugin source with plugin-supplied config
sits closer to that line than it needs to.

The practical one is a race. If main watches `src/` and triggers its own build, chokidar can
fire while the editor is still writing, and `plugin:changed` can be sent before the bundle is
coherent — an intermittent "reload did nothing" that shows up maybe one save in twenty.
Watching `dist/` makes "build finished" *causally* precede "notify renderer" instead of
merely usually preceding it.

Debounce ~100ms regardless: esbuild writes and a single editor save can still fire twice.

**Renderer** performs the swap:

```typescript
window.workbenchHost.onPluginChanged(async (pluginId) => {
  const rec = registry.get(pluginId);
  if (!rec) return;
  const wasActive = rec.state === 'active';
  const openPanels = getOpenPanelIds(pluginId);

  await deactivate(rec);        // §8.3 — unwinds everything
  reloadCounter++;              // new URL ⇒ fresh module
  if (wasActive) {
    await activate(rec);
    for (const id of openPanels) await reopenPanel(id);
  }
});
```

Order matters and is easy to get subtly wrong: **capture open panel state → deactivate fully →
bump the counter → reactivate → restore panels.** Bumping the counter before deactivating
means the old module's disposers may be looked up against the new module. Reopening before
reactivation means mounting a panel whose definition no longer exists.

> **Gate 9 (DoD 4–5):** with the panel open, change the `<h1>` text and save. The panel updates within ~1s, no window flash, no app restart. DevTools console shows exactly one "hello deactivating" and one "hello activating" per save — not two, not zero.

That console check is the real test. Duplicates mean disposal is leaking; zero means you
reloaded the whole window instead of the plugin.

---

## 13. Verification Checklist

Run all of these before calling M0 done. Each maps to a design property that M1 will lean on.

| # | Check | Proves |
|---|---|---|
| 1 | Window opens via `npm run dev` | build pipeline works |
| 2 | Menu entry appears from the manifest | declarative contribution works |
| 3 | Panel mounts on click | the panel contract works |
| 4 | Edit → reload, no restart | HMR loop works |
| 5 | One activate/deactivate pair per save | disposal is correct |
| 6 | Break `plugin.json` (invalid JSON) → app still starts, error logged | discovery is fault-tolerant |
| 7 | Throw inside `activate()` → app still runs, plugin marked failed, **and its already-registered panel is gone from the registry** | activation is contained *and* unwound |
| 8 | Open panel, reload 10×, DevTools → Elements shows one panel subtree | no DOM leak |
| 9 | `window.require` is `undefined` in DevTools | contextIsolation holds |
| 10 | `fetch('plugin://hello/%2e%2e%2f%2e%2e%2fetc/passwd')` returns **403** | traversal guard holds |
| 11 | `fetch('plugin://not-a-plugin/index.js')` returns **404** | unknown plugin ids are rejected |

Check 10 is percent-encoded on purpose. The obvious version,
`plugin://hello/../../etc/passwd`, is normalized by the URL parser *before* your handler ever
sees it — that is what `standard: true` buys — so `pathname` arrives as `/etc/passwd`, the
join stays inside `dist/`, and you get a 404. The guard is fine; the test simply never
reached it, and a green 404 would have told you nothing. `%2e%2e%2f` survives parsing, and is
exactly what the `decodeURIComponent` in §6.3 exists to catch.

Checks 6–8 are the ones people skip and then pay for during M1, when three plugins are
loading at once and a leak is no longer traceable to a single cause.

---

## 14. Common Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| Blank window in dev, CSP error in console | production-strict CSP blocking React Fast Refresh + the HMR websocket | use the mode-aware CSP in §6.4, not one fixed `<meta>` tag |
| CSP error naming `plugin:` specifically | scheme missing from `script-src` | `plugin:` must appear in **both** branches of §6.4 |
| CORS error on the dynamic import | scheme not `corsEnabled`, or no `Access-Control-Allow-Origin` on the response | §6.3 — the renderer origin and `plugin://` are cross-origin, and module scripts always fetch in CORS mode |
| `Expected a JavaScript module script but the server responded with a MIME type of ""` | `net.fetch()` on a `file://` URL sends no content-type | return the file yourself with `content-type: text/javascript` (§6.3) |
| `Failed to resolve module specifier "plugin://..."` | Vite pre-bundling the dynamic import | add `/* @vite-ignore */` |
| Preload script fails to load | built as ESM | build as CJS, extension `.cjs` |
| `window.workbenchHost` undefined | preload path wrong, or it threw | check the **main** process console, not DevTools |
| Reload does nothing | module URL unchanged | confirm `reloadCounter` is in the query string |
| Reload works, but ~1 save in 20 does nothing | main is watching `src/` and racing its own build | watch `dist/` instead (§12) |
| Whole window flashes on plugin save | `dev.mjs` respawning Electron on plugin rebuilds | §11 point 6 — plugin rebuilds must not restart the app |
| Two panels after each reload | disposal not unwinding | check `rec.disposables` is emptied |
| Ghost panel after several rapid saves | teardown ran before the async `mount` resolved | chain cleanup off the mount promise (§9) |
| Plugin marked `failed` but its menu entry still works | `unwind()` not called in the activation catch | §8.2 |
| Heap grows on every reload | old ES modules are retained forever — expected | not a leak; see §8.3 |
| Menu doesn't update after manifest edit | menus are built once at startup | rescan + rebuild on manifest change (or restart — acceptable for M0) |
| `require is not defined` inside a plugin | plugin bundled as CJS | esbuild `--format=esm` |

---

## 15. Suggested Claude Code Session Plan

Roughly one session per line, each ending at its gate:

1. **Steps 1–2** — workspace + SDK. Review the SDK types yourself before moving on; this is
   the one place where reading every line is worth your time.
2. **Steps 3–4** — main + preload. Gate 3 and 4 are quick and catch Electron config errors
   early, while there's almost no code to bisect. The protocol handler in §6.3 and the CSP in
   §6.4 are where the evening-losing bugs live — get those right the first time.
3. **Step 5** — plugin host. Ask for the five disposal tests in §8.4 by name; it's the
   highest-value test in M0 and the easiest one to skip.
4. **Steps 6–7** — shell + hello plugin. Nothing runs yet, which feels wrong and isn't.
5. **Step 8** — the dev orchestrator. First visible payoff; DoD 1–3 land here.
6. **Step 9** — hot reload. Budget real time; the ordering in §12 is where the bugs live.
7. **Verification** — walk §13 manually, including the deliberate-breakage checks.

A prompt that works well to open a session:

> Read CLAUDE.md and `m0-build-guide.md`. Implement Step N only. Stop at the gate and tell me
> how to verify it. Do not implement anything from later steps, and do not add features from
> the "NOT in M0" list.

The scope fence matters more than it sounds. The natural failure mode of a capable coding
session on this project is to helpfully build the command palette while you weren't looking.

---

## 16. When M0 Is Done

Tag `@workbench/plugin-sdk@0.1`. **Do not declare 1.0 yet** — this is a deliberate change
from earlier drafts of this guide.

The M0 SDK omits `storage`, `settings`, `fs`, and `bus`. All four are in architecture §4.3
and all four are wanted by M1's viewers. Freezing the M0 subset as 1.0 means shipping 2.0
before the third plugin exists — honest semver, meaningless freeze. The label stops meaning
"this survived contact with real plugins" and starts meaning "this is what we had on a
Tuesday."

So: **M0 tags `0.1`. M1 grows the surface across `0.x`. `1.0` is declared once three viewers
exist and none of them forced a change to the shell** — which is the test this project
already says M1 exists to run. A frozen contract should be one that passed something. From
the 1.0 tag onward, every change to `PluginContext` is a deliberate versioned decision rather
than a drive-by edit, which is the discipline the whole architecture is betting on.

Then M1: mermaid, image, JSON, in that order — each stresses a different part of the
contract. Mermaid is pure render and proves the panel API alone. Image forces `ctx.fs` and
binary payloads through the permission-declared broker, the first real IPC round trip. JSON
forces `ctx.storage`, with large text and persistent view state.

Keep a running log of every moment you *want* to reach into the shell. **A shell change made
to accommodate a viewer is a contract defect — stop and fix the contract before starting the
next viewer.** That log is as much the deliverable of M1 as the three plugins are, and an
empty one is what earns the 1.0 tag.

---

*Related: [[architecture|Architecture Blueprint]] · [[README|Project README]] · [[ai-layer-options|AI Layer Options]]*
