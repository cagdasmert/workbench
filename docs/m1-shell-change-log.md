# M1 — Shell Change Log

Every time building a viewer makes me *want* to reach into the shell or main process, it goes
here: what I wanted, why, and what happened.

**A shell change made to accommodate a viewer is a contract defect.** An empty log at the end
of M1 is what earns the `plugin-sdk@1.0` freeze (decision D8). A non-empty one is the most
valuable output of this milestone — each entry is either a contract gap found early, or a
place the contract held and the plugin adapted instead.

Verdict key: **CONTRACT GAP** (host was wrong, fixed) · **PLUGIN ADAPTED** (host was right) ·
**DEFERRED** (real, but belongs to a later milestone).

---

## 1 · `plugin://` served every file as `text/javascript`

**Viewer:** mermaid · **Verdict:** CONTRACT GAP — host fixed

**What I wanted.** Mermaid bundles to 8.4 MB of code. With `sourcemap: 'inline'` that becomes
**27 MB**, and hot reload measured **2520 ms** — over the ~1 s target M0 set. Switching to
linked sourcemaps keeps `index.js` at 8.4 MB and defers the map until DevTools asks for it.
That needs the `plugin://` handler to serve `index.js.map` as JSON.

**Why this is the host's fault, not mermaid's.** The Step 3 handler hardcodes
`content-type: text/javascript` for *any* path under a plugin's `dist/`. That was only ever
correct because `hello` shipped exactly one file. Every viewer on the backlog serves more than
JS — the image viewer will serve images, a future wasm-backed plugin will serve `.wasm`, and
any plugin with a stylesheet serves CSS. A browser given `text/javascript` for a PNG will
refuse it.

So this is a latent defect the first real plugin surfaced, not an accommodation. It would have
had to be fixed for the image viewer two weeks later, with less context.

**Fix.** Extension → MIME lookup in `packages/main/src/protocol.ts`, defaulting to
`application/octet-stream` rather than to a script type. Plugin sourcemaps switched to
`linked` in `scripts/esbuild-config.mjs`.

**Outcome, measured.** `plugin://mermaid-viewer/index.js.map` now returns
`200 application/json; charset=utf-8`, and `index.js` dropped 27 MB → 8.2 MB.

| | before | after |
|---|---|---|
| reload, steady state | 2520 ms | **672 ms** |
| reload, first after startup | — | 2848 ms |

672 ms is inside the target (and ~250 ms of it is the viewer's own render debounce, not the
host). The first reload after startup is still slow — esbuild's incremental cache is cold and
V8 is parsing 8 MB for the first time. Two data points only; worth re-checking with the image
viewer before treating it as a rule.

**Contract impact:** none. No change to `PluginContext`, the manifest, or the panel API. No
plugin source changes.
