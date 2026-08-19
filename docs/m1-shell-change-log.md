# M1 / M2 — Shell & Contract Change Log

Every time building a viewer makes me *want* to reach into the shell or main process, it goes
here: what I wanted, why, and what happened.

**M2 note:** shell changes are now *expected* — the command palette is shell work by
definition. The bar moves to the **SDK**: since `plugin-sdk@1.0`, any change to
`packages/plugin-sdk/src/index.ts` is a contract event and gets an entry, additive or not.

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

---

## Verdict — M1 closed, `plugin-sdk` frozen at 1.0

Measured against the M0 commit (`ab237a2`):

| package | change since M0 |
|---|---|
| **`packages/shell`** | **unchanged** |
| `packages/plugin-sdk` | +47 / −1 — `fs`, `storage`, `JsonValue`, `FileFilter` |
| `packages/plugin-host` | +88 / −1 — proxy the two new capabilities |
| `packages/preload` | +8 — four new bridge methods |
| `packages/main` | +178 / −3 — fs broker, storage broker, MIME table, CSP |

**The shell was never touched.** Three viewers — a diagram renderer, a binary file reader, and
an interactive tree with persistent view state — and the renderer needed nothing. That was the
test D8 set, and it passed.

The SDK diff touches **no line** of `PanelDefinition`, `mount`, `PanelTeardown`, `Plugin`,
`Disposable`, `registerPanel`, `registerCommand`, or `PluginManifest`. Everything added was
new surface alongside the existing contract, never a change to it.

**Six entries, no contract defects:**

| # | Entry | Verdict |
|---|---|---|
| 1 | `plugin://` served every file as `text/javascript` | host defect, pre-existing |
| 2 | `ctx.fs` scope | planned growth |
| 3 | `readFile` returned an unusable `Uint8Array` | pre-release narrowing |
| 4 | CSP missing `blob:` | host defect |
| 5 | `ctx.storage` scope | planned growth |
| 6 | async storage races a naive plugin | plugin adapted; host correct |

Entries 1 and 4 were latent host bugs the first real plugins surfaced — `hello` shipped one
`.js` file and loaded no content, so neither could have appeared in M0. Entry 3 is the clearest
argument for building viewers before freezing: a bare `Uint8Array` is `ArrayBufferLike`, which
`Blob` rejects, so every binary plugin would have carried a cast or a defensive copy forever.
It was invisible until something consumed the API.

**Two things left deliberately open**, both cheap to widen and expensive to narrow:

- `fs.readFile` serves only `pickFile`-granted paths from this session. A config reader or
  folder watcher needs a wider scope — that should arrive as a *new* permission string and a
  decision-log entry, not by loosening this one.
- `fs.writeFile`, `fs.watch`, and `storage.delete` do not exist. Adding methods post-1.0 is a
  minor bump, so waiting for a caller costs nothing.

---

# M2

## 7 · Command argument schemas go in the manifest, not `registerCommand`

**Feature:** command palette · **Verdict:** SDK 1.0 → 1.1, additive

`ai-layer-options.md` §5 asks for a JSON-schema argument signature on every command from its
first commit, because a mature command registry is mechanically an agent tool manifest and
retrofitting schemas onto sixty commands is what kills that idea.

The obvious place is a third parameter on `registerCommand`. **That would not work.**
`registerCommand` only runs *after* a plugin activates, and the palette's whole job is to list
commands from plugins that have not activated — that is lazy activation (D4). A schema that
only exists post-activation is a schema the palette can never show.

So it goes in `contributes.commands[].args`, read from the manifest without executing plugin
code (§4.1). Verified: with all four plugins in state `discovered`, the palette listed all
eight commands and correctly flagged the two carrying schemas.

**Contract impact:** additive — a new optional field and a new exported `CommandArgSchema`
type. Existing manifests and plugins compile untouched. First minor bump of the frozen SDK.

---

## 8 · Declared commands that could never run

**Feature:** command palette · **Verdict:** CONTRACT GAP — host fixed

**What happened.** The palette listed `json.format`, Enter ran it, the palette closed — and
nothing happened. `json-tools` stayed `discovered`.

`invokeCommand` activated a plugin only when its manifest listed `onCommand:<id>` in
`activationEvents`. `json.format` was declared in `contributes.commands` but had no matching
activation event, so no plugin was ever activated, no handler was found, and the command
silently did nothing.

This was harmless while commands were only reachable from the menu — every menu entry happened
to have an activation event. The palette exposes **every declared command**, so it turned a
latent inconsistency into dead UI.

**Worse, it fails invisibly.** The palette closes whether or not the command ran, so a dead
entry looks exactly like a slow one.

**Fix.** `invokeCommand` now falls back from the explicit `onCommand:` event to any plugin that
*declares* the command in `contributes.commands`. Declaring a command is a statement that it
should work; requiring a second, redundant declaration to make it actually work is a footgun
with no upside. Two tests cover it.

**Contract impact:** none — host behaviour only. Manifests get *more* permissive, never less.

---

## 9 · Waterfall middleware cannot take a `next` callback

**Feature:** content bus · **Verdict:** SDK 1.1 → 1.2, additive — with a deliberate deviation
from the architecture doc

Architecture §5 and the Cordis analysis §3 both call for waterfall middleware with a
`(payload, next)` signature: short-circuit by not calling `next()`.

**That signature is unimplementable here.** `next` is a callback passed *into* the plugin's
handler, and invariant 2 forbids callbacks-in-arguments across the plugin boundary — under
iframe isolation there is no way to hand a live function across. Shipping it would have made
the bus the one thing blocking the migration D2 exists to keep open.

The expressiveness comes back as a **return value**, which serializes cleanly:

| return | meaning |
|---|---|
| `undefined` | not handled — try the next handler |
| `{ handled: true }` | stop, short-circuiting the rest |
| `{ content }` | transformed — the next handler sees the new payload |

Transform, delegate, and short-circuit all survive; only the calling convention changed. A
test asserts the full waterfall: handler one transforms, handler two short-circuits, handler
three never runs.

**`architecture.md` §5 should be corrected** — it currently specifies a signature that
violates invariant 2, and the next person to read it will implement the wrong thing.

**Contract impact:** additive — `Content`, `ContentResult`, `ContentHandler`, `ctx.bus`, and an
optional `payload` argument on `openPanel`. `PanelContext.payload` was reserved in M0 for
exactly this and needed no change.

---

## 10 · The routing table needed no manifest changes

**Feature:** content bus · **Verdict:** the contract worked

Worth recording as a success rather than a defect. The `accepts`/`emits` fields were added to
`PluginManifest` in M0 as parsed-and-ignored forward compatibility, and filled in during M1 by
viewers that had no bus to talk to.

When the bus arrived, `mermaid-viewer` declaring `emits: ["image/svg+xml"]` and `image-viewer`
declaring `accepts: [… "image/svg+xml"]` routed to each other with **no manifest edits and no
plugin knowing the other exists**. Verified end to end: `mermaid.export` took the image viewer
from `discovered` to `active` with the diagram rendered from a `blob:` URL.

Three routing rules also verified live: exactly one match routes directly; several raise a
"Send to…" picker (`text/plain` → JSON Tools + Mermaid Viewer); none produces a notice
(`No plugin accepts video/mp4`). A payload is never routed back to its emitter.

That is decision D3 paying off — the field cost one line per manifest and was worth it.

---

## 11 · AI needed network, and CSP is the wrong place to grant it

**Feature:** ai-provider · **Verdict:** SDK 1.2 → 1.3, additive

The plugin has to reach an OpenAI-compatible endpoint on `localhost:11434`. The renderer's
`connect-src` does not allow it, and the tempting fix — adding the host to the shell's CSP — is
a contract defect: it puts **one plugin's configuration in the shell**, and every future plugin
wanting a different endpoint would need the shell edited again. That is precisely the shell
change M1 taught us to refuse.

So network joins `fs` and `storage` as a brokered capability: `ctx.net.fetch`, proxied to main,
with the host allowlist built from the manifest's declared `net:fetch:<host>` permissions —
the grammar architecture §9 already specified. **The declaration is the grant.**

Verified live, all four:

| attempt | result |
|---|---|
| `ai-provider` → `evil.example` | `denied — may not reach evil.example (declared: localhost:11434)` |
| `json-tools` → `localhost:11434` | `denied — json-tools declares no net:fetch permission` |
| `ai-provider` → `file:///etc/passwd` | `unsupported protocol file:` |
| `ai-provider` → `localhost:11434` | allowed through to the network layer |

D5 says permissions are declared, not enforced. This is the same narrow exception argued for
`fs` in entry 2: without it, a brokered fetch is an open proxy handed to the renderer.

Two smaller things fixed on the way. Node's `fetch` reports every transport failure as a bare
`fetch failed`, so the broker now names the unreachable host. And Electron prefixes every
rejected `invoke` with `Error invoking remote method 'x':` — a bridge implementation detail
that plugins should not have to parse, now stripped in the host.

**Contract impact:** additive — `ctx.net`, `NetRequestInit`, `NetResponse`.

---

## 12 · `AiProvider` stays out of the SDK

**Feature:** ai-provider · **Verdict:** the contract worked — no change

`ai-layer-options.md` §4 calls the `AiProvider` interface the load-bearing part of the whole AI
decision: if every AI-consuming plugin talks only to it, then Ollama-direct, a DSH sidecar, or
a cloud API are interchangeable. That makes it tempting to put in the SDK where everything can
see it.

It stays inside `plugins/ai-provider/`. Two constraints from §4, both cheap now and expensive
later: the moment the **shell** exposes AI, the app stops working offline and every plugin can
reach a model implicitly; and AI must arrive **through the content bus**, not a special path.

So `ai-provider` is an ordinary plugin — it declares `accepts: ["text/plain"]` and
`emits: ["text/vnd.mermaid"]`, and reaches other plugins the same way any plugin does. The
`AgentProvider` extension point for a future DSH sidecar is written down but unimplemented, so
the seam is visible rather than invented under pressure later.

`stream()` from the §4 sketch is **deliberately absent**: streaming across the IPC broker needs
an event-channel design, and the backlog's AI features (text→mermaid, explain-this-JSON) are
one-shot completions. Same discipline as `fs.writeFile` and `storage.delete`.

**Verified:** emitting `text/vnd.mermaid` took `mermaid-viewer` from `discovered` to `active`
with the diagram rendered — nodes `AI`, `Bus`, `Viewer`. Neither plugin references the other.

**Verified end to end against a live model** (LM Studio, `liquid/lfm2.5-1.2b`): prose →
completion → `stripFences` → `bus.emit('text/vnd.mermaid')` → `mermaid-viewer` from
`discovered` to `active` with the diagram rendered — nodes `User Opens File`,
`Shell Reads Manifest`, `Activates Matching Plugin`, `Mounts Panel`, `Plugin Renders File`.
Zero renderer errors, no error boundary triggered.

`stripFences` earned its place immediately: the model wrapped its output in a ```mermaid fence
on the first try despite the system prompt saying not to.

---

## 13 · Two local backends, and neither is hardcoded

**Feature:** ai-provider · **Verdict:** plugin-internal — no contract change

LM Studio joined Ollama as a target, and became the default. Both speak the OpenAI
chat-completions API, so the difference is one row in a `BACKENDS` table — an endpoint, a
default model, and a hint for when the server is down. A third (vLLM, llama.cpp, a cloud
endpoint) is data, not code.

**Nothing about this reached the shell.** The manifest declares both hosts —
`net:fetch:localhost:1234` and `net:fetch:localhost:11434` — and the broker's allowlist is
built from that. Adding a backend means editing one plugin's manifest and one table; the shell,
the SDK, and the other four plugins are untouched. That is the property the whole contract
exists for, and it is the first time a *configuration* change has been tested against it rather
than a capability change.

The model list comes from the backend's own `/v1/models`, so the picker shows what is actually
loaded rather than a hardcoded guess — verified showing 6 models from LM Studio.

The selection persists through `ctx.storage`, which meant hitting the async-restore trap from
entry 6 a second time, in a different plugin. That is now twice; it belongs in the plugin
template rather than in each plugin's memory.

`contributes.settings` is declared for `backend` and `model` so the M3 settings UI can render
them without this plugin needing changes — the same forward-compatible move that made the
content bus free in entry 10.

---

# M3

## 14 · Settings are read-only to plugins

**Feature:** settings UI · **Verdict:** SDK 1.3 → 1.4, additive

`ctx.settings` has `get` and `onChange` but **no `set`**, matching architecture §4.3. That is
not an oversight to fix later.

The shell owns the settings form and is the only writer. One writer means `onChange` can be
trusted: a value changes by exactly one path, so there is no race between a plugin writing its
own setting and the sheet writing the same key. `ai-provider` previously persisted its backend
choice through `ctx.storage`; it now reads `ctx.settings` and its in-panel picker is explicitly
session-scoped, with the sheet as the persistent path.

**Validation lives in main, not the form.** A renderer-side check is a UI affordance, not a
guarantee — the bridge is reachable directly. Verified: a value outside the declared `enum`, a
wrong type, and an undeclared key are all rejected at the broker.

Stored values are also re-checked against the schema **on read**. If a plugin update narrows an
enum or changes a type, the stale stored value is discarded in favour of the declared default
rather than handed to a plugin that can no longer handle it.

**Contract impact:** additive — `ctx.settings`, `SettingsSchema`, `PropertySchema`.
`contributes.settings` was `Record<string, unknown>` since M0 and is now properly typed; the
compiler immediately caught that manifest validation had been rubber-stamping it.

---

## 15 · `Disposable` vs. what `useEffect` wants

**Feature:** settings UI · **Verdict:** PLUGIN ADAPTED — host is right

`ctx.settings.onChange` returns a `Disposable` per invariant 8, so this does not compile:

```tsx
useEffect(() => ctx.plugin.settings.onChange(handler), [ctx]);   // ✗
```

React wants a plain `() => void`. The preload's own subscriptions (`onCommand`,
`onPluginChanged`) *do* return bare functions, which makes the SDK's shape look inconsistent
next to them.

**The SDK is right and should not change.** Invariant 8 exists because the host tracks every
registration and unwinds it on deactivate — a bare function cannot be tracked. The preload is
the odd one out, and it is not part of the plugin contract.

The adaptation is three lines and belongs in the plugin template alongside the async-restore
trap from entries 6 and 13:

```tsx
useEffect(() => {
  const sub = ctx.plugin.settings.onChange(handler);
  return () => { void sub.dispose(); };
}, [ctx]);
```

That is now **three** distinct papercuts every stateful plugin hits. `tools/create-plugin` has
gone from a nice-to-have to the thing that stops the same three bugs being rediscovered.

**Contract impact:** none.

---

## 16 · Disabling a plugin has to be enforced twice

**Feature:** plugin manager · **Verdict:** shell/main work — no contract change

"Disabled" lives in two places at once, and both are load-bearing:

- **main** persists the list, filters the native menu, and rebuilds it;
- **the host** refuses activation, hides the plugin's commands from the palette, drops it from
  the content-bus routing table, and tears it down if it was already active.

Neither alone is enough. Main-only leaves a disabled plugin reachable from the palette and the
bus. Host-only leaves its entry in the macOS menu, where clicking does nothing. The manager
writes both, in that order, and the two must not drift.

Verified across a full cycle: disabling `image-viewer` removed it from the native menu, emptied
its commands, and made `image/svg+xml` produce *"No plugin accepts image/svg+xml"* where it had
previously routed. Re-enabling restored the menu entry, the command, and the routing.

Disabling an **active** plugin runs the normal disposal path, so "disabled" and "never
activated" look identical to everything downstream.

**This also closes a known gap.** Menus were built once at startup — a documented limitation
since M0. Enable/disable needed a rebuild anyway, so `buildMenu` is now called on change rather
than only at boot.

---

## 17 · The error card finally has the button it promised

**Feature:** plugin manager · **Verdict:** promise kept

Architecture §4.4 specifies "a failure card with the stack trace and a **Reload plugin**
button". Since M0 the card has had the stack trace and no button — the reload path existed
(`host.reload`) but nothing in the failure UI reached it.

`PanelHost` now passes an `onReload` callback into `renderErrorCard`, so a plugin that throws
during `mount` can be fixed and reloaded without touching the app. The plugin manager lists
every plugin's state with its stack trace and offers the same action, plus its declared
permissions — which is the first time `permissions` has been *shown* anywhere, four milestones
after being declared.

**Contract impact:** none.

---

## 18 · Overrides are a diff, never a snapshot

**Feature:** keybindings · **Verdict:** SDK 1.4 → 1.5, additive

Architecture §6 asks for "user overrides stored separately from defaults so plugin updates
never clobber them". The word doing the work is **separately**.

The tempting implementation is to seed `keybindings.json` with the resolved set at first run and
edit it in place. That breaks in one of two ways depending on merge order: either a plugin's
new default is permanently ignored because the snapshot shadows it, or re-seeding overwrites
the user's rebind. Both are silent.

So `keybindings.json` holds **only** what the user changed. Anything absent falls through to
whatever the plugin currently declares, which makes updating a default just work.

An empty string is a real value meaning "deliberately unbound", distinct from "not overridden":
`{...defaults, ...overrides}` cannot express that, which is why `resolveBindings` is explicit
about the three states. Setting `null` deletes the override and restores the default.

Verified across the full lifecycle — plugin default fires → override fires and the old chord is
dead → unbind kills both → `null` restores the default and empties the file.

**Shell shortcuts went through the same registry.** ⌘K had been hardcoded since M2; it is now a
row in `SHELL_KEYS` resolved by the same function as plugin defaults, so it is reboundable and
there is no second dispatch path to drift.

**Contract impact:** additive — `contributes.keybindings` and `KeybindingContribution`. Chords
are normalized at manifest-validation time, so `Shift+Cmd+F` and `cmd+shift+f` compare equal and
the matcher never has to care.

---

## 19 · Two bugs in one guard

**Feature:** keybindings · **Verdict:** my bugs, worth recording

The dispatcher ignored every keypress, twice over, for two different reasons in the same line.

**Inverted condition.** `closest()` returns `null` when there is no match, so
`if (target?.closest('.keys-recording') !== null) return;` bails on every *normal* keypress —
exactly backwards. It reads as "skip while recording"; it means "skip unless recording".

**`e.target` is not always an Element.** After fixing the logic it threw
`target.closest is not a function`: a synthetic `window.dispatchEvent` sets `target` to
`window`, and `document` appears in other paths. `target instanceof Element` is the check.

Neither surfaced as a visible error at first — the handler returned early, so shortcuts simply
did nothing, which reads as "the registry isn't wired up" rather than "the guard is wrong". The
second only became visible once the first was fixed. Worth remembering that a silent
no-op keyboard handler is almost always a guard, not the registry.

---

## 20 · The template that stops three bugs being rediscovered

**Feature:** `tools/create-plugin` · **Verdict:** the log paid for itself

Three entries — 6, 13 and 15 — describe traps that are *inherent to the contract* rather than
defects in it, and each was rediscovered in a different plugin before this existed:

| trap | entries | why it is not a host bug |
|---|---|---|
| async restore races the first save | 6, 13 | every `PluginContext` method is async by invariant 1 |
| `onChange` returns a `Disposable`, not a cleanup function | 15 | invariant 8 — the host must be able to track and unwind it |
| routed content arrives as a `Content` object, not a bare value | 9 | the bus is typed; unwrapping is the plugin's job |

`npm run create-plugin <id>` emits a plugin with all three pre-solved and commented in place,
plus a manifest, a panel, a command, a declared setting, and persistence. It also adds the
package to the solution `tsconfig.json` — a package missing from that file silently never
typechecks, which is its own small trap.

Generated output typechecks, bundles, and runs with **zero edits**: verified mounting as
`active` with its declared setting rendered by the shell's settings sheet and live-updating the
panel.

This was not in any milestone. It earned its place because the log made the pattern visible —
three separate entries pointing at the same missing artifact is an argument that no single
plugin could have made.

---

# M4

## 21 · The production CSP had never once applied

**Feature:** `app://` scheme · **Verdict:** CONTRACT GAP — the oldest one in the project

Since M0 step 10 the shell has set a strict production CSP through
`session.webRequest.onHeadersReceived`, and it has **never had any effect**. A packaged build
loads via `loadFile()`, which gives the renderer a `file://` origin, and `file://` emits no
header events — so the handler simply never ran. Dev was protected because the dev server
speaks HTTP. Production was not protected at all.

This was recorded as a known gap in M0 and carried forward through three milestones, which is
the right call — it costs nothing until you ship — but M4 is the milestone where "we will fix
it at packaging" comes due.

**Fix.** The shell is served over a custom `app://` scheme, exactly as plugins are served over
`plugin://`, and the policy is set **on the response** rather than through `webRequest`. That
removes the failure mode entirely: a scheme that emits no header events cannot silently skip a
policy that is part of the response it returns.

Verified in a real production run — no dev server, no `VITE_DEV_SERVER_URL`:

| check | result |
|---|---|
| origin | `app://shell` — a real origin, not `file://` |
| policy present | full CSP on the document response |
| plugin code still loads | `mermaid-viewer` active, SVG rendered |
| **policy actually blocks** | `fetch('https://example.com')` → *"Refused to connect because it violates the document's Content Security Policy"* |
| traversal guard | `app://shell/%2e%2e%2f…/etc/passwd` → 403 |

The fourth row is the one that matters. A CSP that is present but permissive is
indistinguishable from one that is absent until something tries to escape; asserting a *block*
is the only way to know it is live.

`object-src 'none'`, `base-uri 'none'` and `frame-ancestors 'none'` were added while writing a
policy that would finally be enforced — cheap, and awkward to add once something depends on the
looser version.

**Contract impact:** none. No SDK change, no manifest change, no plugin change.

---

## 22 · Restoring a panel is not invoking a command

**Feature:** session restore · **Verdict:** host gained a method — no contract change

The obvious way to reopen last session's panel is to invoke the command that opens it. That is
wrong twice over: a plugin may contribute a panel with **no command at all**, and a command may
do more than open a panel (`json.format` reformats, then opens). Restore has to address the
panel directly.

`host.restorePanel(panelId)` finds the owning plugin from the manifests, activates it, and
opens the panel — returning `false` rather than throwing when it cannot. Four ways it fails,
and **all four are normal after an update**, not errors:

- the plugin was removed
- the plugin is disabled
- the plugin no longer contributes that panel id
- the plugin threw during activation

The shell clears the stored panel on a failed restore, so a plugin removed while its panel was
open does not leave a session that fails forever.

**The same async trap, a fourth time.** The effect that persists the active panel had to be
gated on a `booted` flag, or the initial `undefined` overwrites the very panel being restored —
identical in shape to change log entries 6 and 13, this time in the shell rather than a plugin.
It is genuinely inherent to async state restoration, not a plugin-authoring mistake.

## 23 · Restored window bounds have to be re-validated

**Feature:** session restore · **Verdict:** correctness detail worth stating

Saved bounds are meaningless on their own: a window last positioned on an external monitor that
is no longer attached would be restored entirely offscreen, with no way to drag it back and no
error to explain why the app "did not start".

`initialBounds()` re-checks the saved rectangle against the *current* displays and requires a
real overlap (>120×80px), not merely a touching corner. On failure it keeps the saved **size**
and lets the platform place the window. Verified by planting `{-9000, -9000}` — the guard fires,
logs, and the window comes back visible at its saved size.

One observed quirk, left alone: macOS adjusts `x` once on first restore (120 → 218 here). It is
stable and non-cumulative — the adjusted value round-trips exactly on every subsequent launch —
so it is platform placement, not drift.

Panel *contents* are deliberately not part of this. `json-tools` already persists its document
through `ctx.storage`, so restoring the panel restores the work as a consequence. The session
file stays a pointer, not a snapshot.
