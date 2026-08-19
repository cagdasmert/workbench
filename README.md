# Workbench

A single local macOS app that hosts a growing set of small utilities — mermaid viewer, image
viewer, JSON tools — behind one window and one set of keybindings.

**Status:** M1 complete · plugin SDK frozen at `1.0` · Electron + TypeScript + React · macOS only

---

## The idea

This is not an app with features. It is a **host shell plus a plugin contract**.

Each plugin ships a declarative `plugin.json` and one bundled ES module. The shell reads every
manifest at startup to build menus and routing *without executing a line of plugin code*, then
loads a plugin lazily when one of its activation events fires.

The viewers are deliberately disposable. The contract is the asset — so every decision here is
optimised for the contract staying stable, not for shipping a viewer faster.

## Quick start

Requires Node 20+ (developed on 22) and macOS.

```bash
npm install
npm run dev
```

A window opens. The **Plugins** menu carries an entry per plugin — try **Mermaid Viewer**,
**Image Viewer**, or **JSON Tools**. Edit
`plugins/hello/src/index.tsx` and save — the panel swaps in place in ~250 ms, with no app
restart and exactly one activate/deactivate pair per save.

| Script | Does |
|---|---|
| `npm run dev` | Vite + esbuild watchers + Electron, with plugin hot reload |
| `npm run typecheck` | `tsc -b` across every package |
| `npm test` | Vitest — the plugin-host disposal suite |
| `npm run build:app` | Bundle main (ESM) and preload (CJS) |
| `npm run build:plugins` | Bundle every plugin to `plugins/*/dist/index.js` |
| `npm run build:shell` | Vite production build of the renderer |

## What a plugin looks like

```jsonc
// plugins/hello/plugin.json — read at startup, never executed
{
  "id": "hello",
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

```tsx
// plugins/hello/src/index.tsx
import type { Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';

export const plugin: Plugin = {
  activate(ctx) {
    ctx.registerPanel('hello.main', definePanel(({ ctx: panelCtx }) => (
      <h1>Hello from {panelCtx.plugin.id}</h1>
    )));
    ctx.registerCommand('hello.open', () => ctx.workspace.openPanel('hello.main'));
  },
};
```

Panels use a framework-agnostic `mount(el, ctx)` that returns a teardown, so a plugin can use
React, a canvas, or plain DOM. `definePanel` is a thin React helper in a **separate entry
point** — a plugin that imports only `@workbench/plugin-sdk` pulls in zero runtime code.

## Layout

```
packages/
  plugin-sdk/     types only — the contract. Imports nothing.
  main/           Electron main: window, manifest discovery, plugin:// protocol, menu
  preload/        the contextBridge surface (CJS — required under sandbox)
  plugin-host/    registry, activation, disposal. Imports no Electron.
  shell/          React UI: chrome, panel mounting, command routing
plugins/
  hello/          M0 contract test
  mermaid-viewer/ live diagram preview — panel contract only
  image-viewer/   ctx.fs: pickFile + readFile over the broker
  json-tools/     ctx.storage: tree view with persistent state
scripts/          dev orchestrator + esbuild configs
```

## Invariants

These are load-bearing, not style preferences:

1. **Every `PluginContext` method is async**, even where a sync answer exists — so plugins can
   later move into an iframe or worker without being rewritten.
2. **Nothing non-serializable crosses the plugin boundary**, except `mount(el, ctx)` and the
   teardown it returns.
3. **Plugins never import `fs`, `path`, or `electron`.** Privileged work goes through the host
   API, which proxies to main over IPC.
4. **`plugin-host` must not import Electron** — it speaks only to `window.workbenchHost`.
5. **Security flags stay on:** `contextIsolation`, `sandbox`, `nodeIntegration: false`, strict CSP.
6. **A failing plugin never breaks the shell** — activation errors are caught and recorded;
   panels render inside error boundaries.
7. **Every registration returns a `Disposable`**, unwound in reverse on deactivate, each in its
   own try/catch.
8. **Main never executes plugin code.** It reads manifests and serves files.

## Roadmap

| | Deliverable | Status |
|---|---|---|
| **M0** | Shell + `hello` plugin + hot reload | ✅ done |
| **M1** | Plugin API v1 + mermaid / image / JSON viewers | ✅ done — SDK frozen at `1.0` |
| **M2** | Command palette + typed content bus | |
| **M3** | Settings, keybindings, plugin manager | |
| **M4** | Packaging, ad-hoc signing, session restore | |

**M1 was the real test, and the contract held.** All three viewers were built without a single
change to `packages/shell`, so `@workbench/plugin-sdk` is frozen at `1.0`. The SDK gained `fs`
and `storage` — both additive; no line of the panel API, lifecycle, or manifest schema changed.
The six things that came up along the way are in the
[M1 shell change log](docs/m1-shell-change-log.md), none of them a contract defect.

### Known gaps

- The production CSP is not enforced: `onHeadersReceived` never fires for `file://`, so the
  strict policy protects dev but not a packaged build. Fix is an `app://` scheme — M4.
- Menus are built once at startup; editing a manifest label needs a restart.

## Docs

| | |
|---|---|
| [Architecture](docs/architecture.md) | Process model, plugin contract, content bus, decision log |
| [M0 build guide](docs/m0-build-guide.md) | Step-by-step with gates — revised after actually building it |
| [Project overview](docs/README.md) | Plugin backlog and priorities |
| [M1 shell change log](docs/m1-shell-change-log.md) | What each viewer wanted from the shell, and what happened instead |
| [AI layer options](docs/ai-layer-options.md) | Why neither DeepSeek Harness nor Cordis was adopted |
| [CLAUDE.md](CLAUDE.md) | Agent instructions for this repo |

## License

[MIT](LICENSE)
