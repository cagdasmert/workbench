# Workbench — Agent Instructions

Local macOS desktop app hosting small utilities (mermaid viewer, image viewer, JSON tools) as
plugins. Electron + TypeScript + React, npm workspaces.

**The plugin contract is the product. The features are disposable.** Optimise every decision
for the contract staying stable, not for shipping a viewer faster.

## Current milestone: M4 — the last one

M0–M3 are **done**, plus `tools/create-plugin`. Six plugins, 29 tests. The SDK has held `1.0`'s
shape since M1 and is now `1.6` through six additive bumps — no line of the panel API,
lifecycle, `Disposable`, or the core manifest shape has changed in that time.

**The contract is open again, additively** (decided 2026-08-21, superseding the M1 freeze). The
freeze did its job: six plugins were built without one breaking change, which is the evidence
the shape is right. New capability may now be added as a **minor bump plus a change-log entry**.
What has *not* changed — existing signatures do not move, and altering or removing anything is
still a major bump and a decision-log entry. Additive is licence to grow the surface, not to
churn it, and every addition still answers to the invariants below.

M4 makes it a real application rather than a dev-server experiment:

1. **`app://` scheme for the shell.** In production the shell loads over `file://`, and
   `onHeadersReceived` never fires for `file://` — so **the strict CSP has never actually
   applied to a packaged build**. Serving the shell over a custom scheme is what makes
   architecture §9 true rather than aspirational. Do this first: everything else is packaged on
   top of it.
2. **Session restore.** Reopen the last panel and its plugin on launch.
3. **Packaging.** `.app` bundle, ad-hoc signed (`codesign -s -`), launches from
   `/Applications`. `electron-builder` gets installed here — it was deliberately left out of M0.
4. **Copy to folder (image viewer).** Multi-select images and copy them out, with a recent-
   folders list. This brings the **first write primitive** into the stack: SDK `1.7`,
   `pickDirectoryForWrite` + `copyFile`, an `fs:write:user-selected` scope, and a write-grant set
   kept strictly separate from the read one. Design:
   `docs/superpowers/specs/2026-08-21-image-viewer-copy-to-folder-design.md`.

Keep appending to `docs/m1-shell-change-log.md`.

### Watch for

- **Plugins are loaded from a dev path.** `PLUGIN_DEV_DIR` resolves relative to the source
  tree; a packaged app has to read from `~/Library/Application Support/Workbench/plugins/` and
  fall back to bundled ones. Getting this wrong means a `.app` that opens with no plugins.
- **The preload path** is resolved relative to `__dirname` and must survive `asar` packing.
- **`storage` is scoped, not isolated** — unchanged, and now shipping.
- **A write primitive can reach the plugin directory.** M4 loads plugins from
  `~/Library/Application Support/Workbench/plugins/`, so any `fs` write able to target it is an
  install path for code that runs on next launch, with no prompt. It is deny-listed in the
  broker; keep it that way.
- **`copyFile` must always pass `COPYFILE_EXCL`.** Not for tidiness. Without it, a symlink
  planted at the destination filename is followed and the write lands *outside* the grant —
  verified on this machine, not assumed. The auto-rename loop must never fall back to a
  non-exclusive copy.

## Invariants — never violate without asking

1. **Every `PluginContext` method is async.** Even where a sync answer is available. Plugins
   may later run in an iframe or worker; a single sync method turns that migration into a
   rewrite of every plugin.
2. **Nothing non-serializable crosses the plugin boundary.** No class instances, no DOM
   nodes, no callbacks-in-arguments. The sole exception is `PanelDefinition.mount(el, ctx)`,
   which receives a real element by necessity — confine element access to that one method.
3. **Plugins never import `fs`, `path`, `electron`, or any Node builtin.** Privileged
   operations go through the host API, which proxies to main over IPC.
4. **`packages/plugin-host` must not import Electron.** It speaks only to
   `window.workbenchHost`. This is what lets it move into an iframe untouched.
5. **`packages/plugin-sdk/src/index.ts` imports nothing.** Types only. React lives in the
   separate `./react` entry point.
6. **Electron security flags stay on:** `contextIsolation: true`, `nodeIntegration: false`,
   `sandbox: true`, plus a strict CSP. If code seems to require turning one off, the design
   is wrong elsewhere — raise it.
7. **A failing plugin never breaks the shell.** Activation errors are caught and recorded as
   `failed`; panels render inside error boundaries.
8. **Every registration returns a `Disposable`,** tracked by the host and unwound in reverse
   on deactivate, each in its own try/catch.
9. **Main never executes plugin code.** It reads manifests and serves files. Plugin code runs
   in the renderer only.

## Conventions

- TypeScript `strict: true`. No `any` — use `unknown` and narrow.
- ESM everywhere except the preload script, which must be CJS (`.cjs`) under `sandbox: true`.
- Plugin bundles: esbuild, `--format=esm`, one file per plugin.
- Plugin code is served over the custom `plugin://` scheme, never `file://`.
- Dynamic imports of plugin URLs need `/* @vite-ignore */`.
- Hot reload busts the ES module cache with a `?v=` query param — the URL must change or
  nothing reloads.

## Working style

- Implement one guide step at a time. Stop at its gate and explain how to verify.
- Prefer deleting code over adding an abstraction "for later". M0 has one plugin; generalise
  when there are three.
- When something is ambiguous, ask rather than picking — the contract decisions are the
  expensive ones to reverse.
- Write the disposal unit test. It is the highest-value test in M0.

## Key docs

Architecture, roadmap, and the full build guide live in the author's Obsidian vault at
`02_Projects/Local-Desktop-Util/` — `architecture.md`, `README.md`, `m0-build-guide.md`,
`ai-layer-options.md`. Ask for the relevant one if context is missing.

## Decided, do not relitigate

- Electron + TypeScript + React (not Tauri, not JavaFX, not SwiftUI)
- In-process plugins with an async-shaped API (iframe isolation is a later host-only change)
- `mount(el, ctx)` panel contract with a `definePanel` React helper in the SDK
- Typed content bus designed in from v1, **implemented at M2**
- Lazy activation via manifest `activationEvents`
- Permissions declared in manifests, not enforced yet
- No DeepSeek Harness, no Cordis. AI arrives at M2 as a thin `AiProvider` plugin against an
  OpenAI-compatible endpoint.
