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

---

## 2 · `ctx.fs` — scoping what `fs:read:user-selected` actually means

**Viewer:** image · **Verdict:** planned growth, but with one decision worth recording

Adding `fs` to the SDK is expected M1 work, not a defect — the image viewer is the reason it
exists. Two choices inside it are not obvious, though.

**Only `pickFile` and `readFile` shipped.** Architecture §4.3 also lists `writeFile` and
`watch`. The image viewer needs neither, so neither exists. Guessing at the shape of a method
nothing calls is how contracts rot before they are used.

**`readFile` serves only paths granted by `pickFile` in the current session.** Decision D5
says permissions are declared, not enforced — and this is not a general permission engine, so
it doesn't contradict that. It is narrower and more specific: without it, `fs:readFile` over
the bridge is an arbitrary-file-read primitive handed to the renderer, which architecture §9
says must never cross. The dialog *is* the grant. Nothing is persisted; a restart starts from
zero.

Verified live: `readFile('/etc/passwd')` → `fs:read denied — … was not granted by pickFile in
this session`, and `readFile(42)` → `fs:readFile expects a path string`.

The cost is real and deliberate: a plugin cannot read a path it merely knows about. A config
reader or a folder watcher will need a wider scope, which should arrive as a *new* permission
string and a decision-log entry — not by quietly loosening this one.

**Contract impact:** additive. `PluginContext` gains `fs`; nothing existing changed.

---

## 3 · `readFile` returned a `Uint8Array` too loose to use

**Viewer:** image · **Verdict:** CONTRACT GAP — SDK fixed

**What happened.** `new Blob([bytes])` did not compile. Modern TypeScript types bare
`Uint8Array` as `Uint8Array<ArrayBufferLike>`, which includes `SharedArrayBuffer`, and `Blob`
will not accept that. Every plugin touching binary data would have hit it.

The workarounds are all bad: a cast (lying about a type we actually control), or a defensive
copy of the whole file (wasting a full image's worth of memory on every open).

**Fix.** The SDK now declares `Promise<Uint8Array<ArrayBuffer>>`. That is simply *true* — the
bytes come from `node:fs` over structured clone and are never shared — and stating it lets
plugins pass the result straight to `Blob`, `createImageBitmap`, or a `DataView` with no cast
and no copy.

Exactly the kind of thing M1 is for: the imprecision was invisible until a real plugin
consumed the API.

**Contract impact:** a narrowing of an as-yet-unreleased method. No plugin source changed.

---

## 4 · CSP blocked `blob:` image sources

**Viewer:** image · **Verdict:** CONTRACT GAP — host fixed

`img-src 'self' data: plugin:` — set during M0 step 10 — has no `blob:`, so the object URL the
viewer builds from the bytes it just read would have been blocked. Added `blob:` to `img-src`
in both the dev and production policies.

Second time the CSP has been the thing standing between a plugin and working (after
`connect-src` in entry 1). The pattern is consistent: **CSP failures are silent**, and they
present as "my plugin is broken" rather than as a policy error. Worth checking the policy
first whenever a plugin can load its code but not its content.

**Contract impact:** none.

---

## 5 · `ctx.storage` — who names the plugin?

**Viewer:** json · **Verdict:** planned growth, three decisions recorded

**`get`/`set` only.** Architecture §4.3 also lists `delete`. Nothing needs it, so it doesn't
exist. Same discipline as `fs`: `writeFile` and `watch` are still absent.

**Values are constrained to `JsonValue`, not `T`.** The architecture sketch says `get<T>`,
which is a lie the moment someone stores a `Map` and reads back `{}`. `T extends JsonValue`
makes that a compile error at the call site instead of a silent data loss at runtime.

**The plugin never names itself.** `ctx.storage.get('session')` — no plugin id anywhere in the
plugin-facing signature. The host supplies it from the record, so a plugin cannot read another
plugin's data by asking nicely. Verified by test: the plugin calls `set('doc', …)` and the
bridge receives `test/doc`.

That said — this is *scoping*, not *isolation*. The preload bridge takes a `pluginId`
argument, and under the in-process model (D2) any plugin can call
`window.workbenchHost.storageGet('other-plugin', …)` directly. Plugins already share a realm,
so this is not a new hole; it is the same seam iframe isolation would close, and it is worth
knowing it sits here.

**Plugin ids become filenames**, so `storage-broker.ts` rejects anything outside
`[A-Za-z0-9._-]` and anything leading with a dot. Manifest validation only checks that an id
is a non-empty string, so `../../config` would otherwise write straight out of `plugin-data/`.
Verified: `../../etc/x`, `..`, `.hidden`, `a/b` all rejected; `ok-id_1.2` accepted.

Writes are debounced 250 ms and go through a temp file plus `rename`, so a crash mid-write
cannot truncate an existing store.

**Contract impact:** additive. `PluginContext` gains `storage`.

---

## 6 · Async storage invites a plugin to erase its own saved state

**Viewer:** json · **Verdict:** PLUGIN ADAPTED — host is right

**What happened.** The obvious way to write this panel is: initialise state to a default, load
saved state in an effect, and save on every change. That destroys the saved state on first
mount — the save effect fires with the *default* value before the async restore resolves, and
overwrites the file.

The fix is entirely inside the plugin: a `restored` flag gates saving until the initial read
has completed.

**Why the host stays as it is.** Every `PluginContext` method is async by invariant 1, and
that is deliberate — a synchronous `storage.get` would make the iframe migration a rewrite of
every plugin. So the race is inherent to the contract, not a defect in it.

But it will catch every plugin that persists state, which is most of the backlog. It belongs
in the plugin scaffolding template (`tools/create-plugin`, still unbuilt) rather than being
rediscovered per plugin. Logged so that template starts life with the right shape.

**Contract impact:** none.
