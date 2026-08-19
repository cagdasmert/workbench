# Workbench — Agent Instructions

Local macOS desktop app hosting small utilities (mermaid viewer, image viewer, JSON tools) as
plugins. Electron + TypeScript + React, npm workspaces.

**The plugin contract is the product. The features are disposable.** Optimise every decision
for the contract staying stable, not for shipping a viewer faster.

## Current milestone: M3

M0, M1 and M2 are **done**. `@workbench/plugin-sdk` is frozen at `1.x` — tagged at `1.0`, now
`1.3` after three additive bumps (`CommandArgSchema`, `bus`/`Content`, `net`). No line of the
panel API, lifecycle, `Disposable`, or manifest schema has changed since the freeze.

**The contract is frozen. Treat `packages/plugin-sdk/src/index.ts` as closed.** Additive is a
minor bump and needs a caller that already exists. Changing or removing anything is a **major
bump plus a migration note in the decision log**.

M3 delivers the three things that make the app usable by someone who did not write it:

1. **Settings UI generated from each plugin's JSON Schema.** Plugins declare
   `contributes.settings` and read `ctx.settings`; they never build a form. `ai-provider`
   already declares `backend` and `model` and is the first consumer.
2. **Keybinding registry** with user overrides stored *separately* from defaults, so updating a
   plugin never clobbers a rebind.
3. **Plugin manager** — enable/disable/reload, and `failed` plugins visible with their stack
   traces. The M0 error card already promises a **Reload plugin** button; this is where it gets
   one.

Keep appending to `docs/m1-shell-change-log.md`. Shell work is expected in M3; an **SDK**
change is still a contract event and gets an entry.

**Do not build in M3:** packaging · session restore · tabs or splits. Those are M4.

### Known gaps carried forward

- **The production CSP is not enforced** — `onHeadersReceived` never fires for `file://`, so
  the strict policy protects dev but not a packaged build. Fix is an `app://` scheme (M4).
- **Menus are built once at startup** — editing a manifest label needs a restart. M3's plugin
  manager is the natural place to fix this.
- **`storage` is scoped, not isolated** — the preload bridge takes a `pluginId`, so under the
  in-process model any plugin can read another's data directly.
- **The async-restore trap has now bitten twice** (change log entries 6 and 13). It belongs in
  a `tools/create-plugin` template, which does not exist yet.

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
