# Workbench — Agent Instructions

Local macOS desktop app hosting small utilities (mermaid viewer, image viewer, JSON tools) as
plugins. Electron + TypeScript + React, npm workspaces.

**The plugin contract is the product. The features are disposable.** Optimise every decision
for the contract staying stable, not for shipping a viewer faster.

## Current milestone: M0

Deliver exactly this, and nothing more:

1. `npm run dev` opens a window
2. macOS menu shows an entry contributed by the `hello` plugin's manifest
3. Clicking it mounts the plugin's panel
4. Editing plugin source reloads it in place — no app restart
5. Reload fully disposes the previous instance (one activate/deactivate pair per save)

**Do not build in M0:** command palette · tabs or splits · settings UI · theming beyond a
stylesheet · content bus · permission enforcement · real viewers · packaging · session
restore. If a task seems to need one of these, say so and stop — do not build it.

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
