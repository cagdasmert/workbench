# AI Layer Options — DeepSeek Harness & Cordis

**Status:** ✅ **Decided — neither adopted**
**Decided:** 2026-08-19
**Recorded as:** [[architecture#11-decision-log|D7]]

> **Decision: Workbench uses neither DeepSeek Harness nor Cordis.**
>
> The plugin kernel stays hand-rolled per [[architecture|architecture.md]] §4. The AI layer,
> when it arrives at M2, is a thin `AiProvider` against an OpenAI-compatible endpoint
> (§4, Option C) — implemented as an ordinary plugin, reached through the content bus.
>
> **Still worth taking from this analysis, at no dependency cost:**
> - the three Cordis patterns in §3 — declarative `inject`-style service dependencies,
>   strict reversible effects, waterfall middleware for the content bus
> - the `AiProvider` interface in §4, which keeps a future agent backend a swap rather
>   than a rewrite
> - JSON-schema argument signatures on every command from day one (§5)
>
> The rest of this document is retained as the rationale, and as the thing to re-read if
> the revisit trigger in D7 ever fires.

---

## 0. The Question Is Actually Two Questions

The premise of the question — "DSH *or* Cordis as the AI layer" — needs correcting before
anything else, because the two are not alternatives at the same layer:

```
┌──────────────────────────────────────────────┐
│  DeepSeek Harness (DSH)                      │  ← agent framework
│  agent loop · tools · MCP client · sessions  │     "the AI layer"
│  provider catalog · sandbox policy           │
├──────────────────────────────────────────────┤
│  Cordis                                      │  ← plugin kernel
│  context · services · DI · effects · events  │     "the architecture"
└──────────────────────────────────────────────┘
```

**Cordis is the plugin kernel DSH is built on.** It predates DSH by roughly four years as
the foundation of Koishi, and DSH v4 adopted it rather than the reverse. DSH's own
architecture doc states that under Cordis "every part of the product is a plugin, including
the model adapter, the tool registry, the session log, and the agent loop itself."

So the real question splits in two, and they are **independently answerable**:

| | Question | Layer | Relevant milestone |
|---|---|---|---|
| **Q1** | Should Workbench use DSH as its AI layer? | feature | M2–M3 |
| **Q2** | Should Workbench use Cordis as its plugin kernel, replacing the hand-rolled host in §4 of the architecture? | architecture | M0 — decide before scaffolding |

You can end up with either, both, or neither. Q2 is the more consequential one and has the
earlier deadline, so it is treated separately in §3.

---

## 1. What Each Project Actually Is

### 1.1 DeepSeek Harness (`deepseek-ai/deepseek-harness`)

MIT-licensed TypeScript/Node agent framework from DeepSeek. Developer preview, breaking
changes expected. Requires Node 22.19+ or 24+.

What you would inherit by adopting it:

- **Agent loop** with a documented turn/step model:
  `turn/start → agent/pre-step → step/start → assistant/message → tool/call* → tools/execute → step/end → turn/end`
- **Provider abstraction** (`ctx.llm`) with a built-in catalog covering DeepSeek, OpenAI,
  Anthropic, Bedrock, Vertex, Azure — plus arbitrary OpenAI-compatible endpoints, which is
  the door through which **Ollama / LM Studio / vLLM** enter. Configured declaratively in
  `$DSH_HOME/settings.yaml`.
- **Tool registry** (`ctx.tools`) with built-ins: bash/PowerShell, file read/write with
  diff presentation, LSP over stdio, background jobs, goal stacks, filesystem skill discovery.
- **MCP client** (`@deepseek-ai/dsh-mcp-client`) — connects to MCP servers over spawned
  stdio or streaming HTTP, namespacing tools as `mcp__<server>__<tool>`.
- **Sandbox policy** — `read-only` by default, `workspace-write`, `danger-full-access`,
  with approval workflows.
- **Session log** — append-only event log, JSONL or SQLite persistence.
- **Profiles/bundles** — `dsh-base`, `dsh-web-app`, `dsh-headless`, composed as ordered
  configuration layers.
- **Transports** — web UI on `127.0.0.1:3080`, headless one-shot CLI, and ACP (Agent Client
  Protocol) over JSON-RPC/stdio, the protocol Zed uses to talk to coding agents.

One detail worth flagging: DSH's monorepo is split into **Host** and **Client** TypeScript
aggregates, with business services exposing methods via `@Remote` / `@RemoteScope`
annotations that generate a gateway the browser client consumes as `ctx.remote`. That is
structurally the same problem Electron solves with main/preload/renderer — noted again in
§2.2 because it cuts both ways.

### 1.2 Cordis (`cordiverse/cordis`)

MIT-licensed meta-framework — "A Meta-Framework of Spatiotemporal Composability", with an
accompanying academic paper. Four years in production behind Koishi (~6k stars).

Core model, in the vocabulary of the [[architecture]] doc:

| Cordis concept | Workbench equivalent in §4 |
|---|---|
| `Context` — repository of services, claimed at stable `ctx.<key>` | `PluginContext` |
| Plugin = object with `apply(ctx)` + optional `inject` | `Plugin.activate(ctx)` |
| `inject` — declarative service dependency; plugin waits until services exist | *nothing — load order was going to be manual* |
| `ctx.effect()` — reversible side effect, unwound on teardown | `Disposable` registry |
| `ctx.on()` + fork/scope lifecycle | per-plugin disposal on deactivate |
| Events: `emit` / `waterfall` / `parallel` / `serial` | event bus + content bus |
| `waterfall` — around-middleware, `(...args, next)`, short-circuit by not calling `next()` | *nothing — the bus was a plain router* |
| `@cordisjs/plugin-hmr` | **the entire M0 hot-reload deliverable** |

**The README carries an explicit warning: the API is not stable and may change without
notice.** That single sentence dominates the Q2 analysis.

---

## 2. Q1 — Options for the AI Layer

### Option A — Side-by-side: DSH as a sidecar process

Workbench spawns `dsh` as a child process and talks to it over ACP JSON-RPC/stdio (or its
local HTTP endpoint). An `ai-agent` plugin in Workbench owns the process handle.

```
┌─────────────────────┐        ┌──────────────────────┐
│ Workbench (Electron)│        │ dsh (Node subprocess)│
│  ai-agent plugin ───┼───────▶│  agent loop, tools,  │
│                     │ JSON-  │  MCP, sandbox        │
│  ◀── stream/events ─┼─ RPC ──│                      │
└─────────────────────┘ stdio  └──────────────────────┘
```

**For**

- Cheapest possible coupling to a *developer-preview* framework — the blast radius of a
  breaking change is one plugin, not the app.
- Everything heavy stays outside the renderer: DSH's dependency tree, its Node 22+
  requirement, its sandboxed bash, its file writes.
- A wedged or runaway agent is `kill -9`, not an app restart.
- You inherit the entire capability set (MCP, providers, sandbox, session log) for the cost
  of a process spawn and a JSON-RPC client.
- The transport is already proven — third parties ship `dsh-acp` for Zed today.

**Against**

- Heavyweight for the actual near-term need. The AI plugins on the backlog — Ollama chat,
  text→mermaid, explain-this-JSON — are one-shot completions. This is an agent harness.
- Two configuration surfaces: `$DSH_HOME/settings.yaml` and Workbench's own settings.
- Process startup latency on first use; requires Node 22+ present on the machine or bundled.
- ACP's vocabulary is coding-agent-shaped (workspace, file edits, permission prompts). It
  fits "refactor this repo" far better than "render this text as a diagram."
- Packaging: shipping a `.app` that depends on an external Node runtime, or bundling one.

**Verdict:** the right answer *if and when* Workbench genuinely wants tool-using agents.

### Option B — Embed DSH in-process (Electron main as the DSH Host)

Import DSH packages directly into the Electron main process, treat main as the DSH Host and
the renderer as its Client.

**For**

- The architectural fit is uncanny. DSH's Host/Client split with `@Remote`-generated gateway
  and `ctx.remote` in the browser is *exactly* the main/preload/renderer problem the
  architecture doc solves by hand with typed IPC. Adopting it would mean not writing that
  layer twice.
- No subprocess, no second config root, no IPC serialization written by hand.
- Full access to `ctx.tools`, `ctx.agents`, `ctx.sessions` as first-class services.

**Against**

- You inherit DSH's entire dependency tree, its Cordis version, and its API churn **into
  your main process**. A developer-preview framework becomes load-bearing for an app whose
  primary job is displaying PNGs.
- Node version coupling: DSH wants 22.19+/24+; Electron's bundled Node has to match, which
  constrains your Electron version.
- Crash surface: the app's stability is now the agent framework's stability.
- Packaging a pnpm-workspace monorepo framework into a signed `.app` bundle is real,
  unglamorous work.
- Hardest option to back out of.

**Verdict:** only if the AI layer becomes the app's centre of gravity — i.e. if Workbench is
really "an agent with viewers" rather than "viewers with an assistant." That is not what the
brief describes.

### Option C — Thin provider of your own

An `ai` plugin holding ~200 lines: an `AiProvider` interface, one OpenAI-compatible HTTP
client, SSE stream parsing. Points at Ollama on `localhost:11434` by default.

**For**

- Proportionate to the actual backlog. Ollama chat, text→mermaid, and explain-this-JSON are
  single completions with a prompt template. None needs a turn/step loop, a tool registry,
  a sandbox policy, or a session event log.
- Zero new heavyweight dependencies; nothing to package; no version drift.
- Keeps the offline-first non-functional requirement trivially true.
- Fits the existing design with no shell changes — it is just another plugin.

**Against**

- No tool use, no MCP, no multi-step reasoning. If the app later wants "find every mermaid
  file in this folder and re-render the stale ones," you are building an agent loop yourself,
  badly.

**Verdict:** correct for M2.

### Option D — Neither, and defer

Skip AI entirely until a plugin genuinely demands it.

**For:** the backlog has ~20 non-AI plugins with clearer value. **Against:** text→mermaid is
one of the strongest demos of why the content bus exists, and it is cheap under Option C.

---

## 3. Q2 — Cordis as the Plugin Kernel

This deserves separate treatment because it is an M0 decision and because, on inspection,
**Cordis implements a large fraction of what §4 of the architecture doc says you will
hand-roll.**

Specifically it already provides: the context/service repository, declarative dependency
injection via `inject` (which removes manual boot ordering entirely — something the current
design does not even address), `ctx.effect()` reversible effects (the `Disposable` registry),
scope/fork lifecycle (per-plugin teardown), a four-mode typed event bus, and
`@cordisjs/plugin-hmr` — which is the M0 hot-reload deliverable, shipped.

There is also a fit argument specific to you: Cordis's model is essentially a Spring
`ApplicationContext` with reversible bean scopes and an event bus. `inject` is
`@Autowired`-with-waiting; `ctx.effect()` is `@PreDestroy` that actually composes. Coming
from Spring, this will read as familiar rather than exotic.

**Against adopting it:**

1. **"The API is not yet stable and may change without notice."** For a dependency you call
   from a plugin, that is an annoyance. For the kernel every plugin is written against, it
   is the thing that forces the rewrite the architecture doc exists to prevent. This is the
   whole argument.
2. **It solves the half you weren't worried about.** Cordis has no opinion on panels, menus,
   command palettes, tabs, or content types. The UI contribution layer — arguably the harder
   and more app-specific half of §4 and all of §6 — is still yours to write.
3. **Conceptual weight.** Fibers, scopes, effects, waterfall dispatch, spatiotemporal
   composability. For a single-author personal utility app with maybe 15 plugins, the ceiling
   this raises may never be reached.
4. **It contradicts D2's spirit.** Decision D2 chose in-process plugins specifically to keep
   the shell small and the escape hatch open. Adopting an explicitly unstable kernel trades
   that for a larger, faster-moving surface.

**Middle path — steal the ideas, defer the dependency.** Three Cordis concepts are worth
importing into the hand-rolled host at essentially zero cost, and they are all things the
current design is weaker on:

- **`inject`-style declarative dependencies.** Let a plugin manifest declare which services
  it needs; the host activates it when they exist. Removes boot-order logic before it is
  written.
- **`ctx.effect()` discipline.** Every registration returns a disposal handle and the host
  unwinds them in reverse. The design has this as a `Disposable` registry — Cordis's version
  is stricter and worth copying exactly.
- **Waterfall events for the content bus.** `(...args, next)` middleware means a plugin can
  intercept, transform, and delegate a payload, or short-circuit it. That is strictly more
  expressive than the plain routing table in §5.2, for about the same code.

Doing this keeps the option open: if the host later starts feeling like a worse Cordis, the
migration is mechanical because the concepts already line up.

---

## 4. Recommendation

**Staged, with the insulation built first.**

| Phase | Action |
|---|---|
| **M0** | Do **not** adopt Cordis as the kernel. Hand-roll per the architecture doc, but import the three ideas in §3 (declarative `inject`, strict reversible effects, waterfall content bus). |
| **M2** | **Option C.** Ship `ai-provider` as a normal plugin exposing a narrow `AiProvider` interface, backed by an OpenAI-compatible client pointed at Ollama. Build text→mermaid and explain-this-JSON on top of it. |
| **M3+** | If — and only if — a plugin needs tool use, file operations, or MCP: **Option A**, DSH as a sidecar behind the *same* `AiProvider` interface plus an `AgentSession` extension. C→A becomes a provider swap, not a rewrite. |
| **Never (probably)** | Option B. The entanglement is only justified if the agent becomes the product. |

The load-bearing part of this recommendation is not the phase order — it is the
`AiProvider` interface. Sketch:

```typescript
export interface AiProvider {
  readonly id: string;
  complete(req: CompletionRequest): Promise<Completion>;
  stream(req: CompletionRequest): AsyncIterable<CompletionChunk>;
  capabilities(): { tools: boolean; vision: boolean; streaming: boolean };
}

// M3+ only, implemented by the DSH sidecar, absent under Option C
export interface AgentProvider extends AiProvider {
  startSession(opts: SessionOptions): Promise<AgentSession>;
}
```

If every AI-consuming plugin talks only to this, then Ollama-direct, a DSH sidecar, a cloud
API, or something that doesn't exist yet are all interchangeable. Without it, the choice
made at M2 is the choice forever.

**Two further constraints, both cheap now and expensive later:** AI must be a *plugin*, never
a shell service — the moment the shell imports it, the app stops working offline and every
plugin can reach a model implicitly. And it must arrive through the content bus, not a
special path: an AI plugin declaring `accepts: ["*"]` and emitting `text/vnd.mermaid`,
`application/json`, `text/markdown` makes "explain this JSON" and "diagram this text" fall
out of existing routing rather than needing new machinery.

---

## 5. The Long Game (why this might matter more later)

One observation worth recording, because it inverts the whole framing.

§6 of the architecture doc says **every action in the app is a registered command** — shell
and plugin alike, no exceptions. DSH's tool registry takes tools with JSON schemas and feeds
them into prompt assembly.

Those are the same data structure.

Which means a mature Workbench command registry is, mechanically, an agent tool manifest.
Expose it and you get: *"open every `.mmd` in this folder, render it, export the ones that
changed, and put a summary in my daily note"* — executed through the app's own plugins,
composed by a model, with the sandbox and approval policy DSH already implements.

That is a genuinely interesting destination, and it costs nothing to preserve today: keep
command IDs stable and give every command a JSON-schema-typed argument signature from the
start. Retrofitting schemas onto 60 commands later is the kind of tedium that kills the idea.

---

## 6. Open Questions & Things to Verify

| # | Question | Why it matters | How to check |
|---|---|---|---|
| V1 | Does `@cordisjs/core` run in a browser context, or is it Node-only? | DSH ships a Client aggregate whose plugins produce browser bundles, which implies yes — but if the kernel is Node-only, Option C-with-Cordis-ideas is the only viable form anyway | Import it into a bare Vite page |
| V2 | Electron's bundled Node vs DSH's 22.19+/24+ requirement | Hard blocker for Option B | Check Electron release notes against the target version |
| V3 | Cold-start time and memory footprint of a `dsh` sidecar | Decides whether Option A is spawn-on-demand or always-on | Time `npx @deepseek-ai/dsh --profile headless` |
| V4 | Is ACP expressive enough for non-coding tasks? | ACP is coding-agent-shaped; if it can't carry arbitrary typed payloads, Option A needs the HTTP transport instead | Read the ACP schema |
| V5 | How stable is `$DSH_HOME/settings.yaml` across preview releases? | Config churn is the likeliest source of breakage under Option A | Watch the repo between two releases |
| V6 | Does Ollama's OpenAI-compatible endpoint cover streaming + tool calls adequately? | Determines whether Option C can stretch further than expected | Direct `curl` against `localhost:11434/v1` |

**Suggested spikes, both timeboxed to an afternoon, both after M0 and before committing:**

- **Spike 1 (Option C):** minimal `AiProvider` against Ollama, wired to a text→mermaid
  plugin. Success = a diagram appears in the mermaid viewer via the content bus.
- **Spike 2 (Option A):** spawn `dsh --profile headless`, send one request over stdio, render
  the response in a panel. Success = round-trip works and you have a real number for V3.

Run Spike 1 first. If it satisfies every AI use case actually on the backlog, Spike 2 becomes
research rather than a decision.

---

## 7. Summary Table

| | Effort | Capability | Coupling to preview software | Fits current backlog |
|---|---|---|---|---|
| **A** DSH sidecar | Medium | High — tools, MCP, sandbox | Low (process boundary) | Overshoots |
| **B** DSH embedded | High | High + main/renderer gateway for free | **High** (in your main process) | Overshoots badly |
| **C** Thin provider | Low | Completions only | None | **Yes** |
| **D** Defer | None | None | None | Leaves the bus's best demo unbuilt |
| **Cordis as kernel** | Medium | Solves DI, effects, HMR — not UI contributions | **High** (unstable API, and it's the kernel) | Premature; steal the ideas instead |

---

## Sources

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — repo & README
- [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) — turn/step model, capability seams, profiles
- [DSH architecture reference](https://deepseek-harness.github.io/deepseek-harness/en/reference/) — core packages, bundles
- [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md) — context, inject, effects, event dispatch modes
- [DSH development guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/development.md) — Host/Client split, `@Remote`, Node requirements, headless & ACP
- [DSH config catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md) — plugin list, MCP client, sandbox policies
- [Configure models](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers) — provider catalog, OpenAI-compatible config
- [cordiverse/cordis](https://github.com/cordiverse/cordis) — README, API-stability warning, MIT
- [cordiverse/cordis on DeepWiki](https://deepwiki.com/cordiverse/cordis) — context, services, DI, HMR
- [openma-ai/deepseek-harness-acp](https://github.com/openma-ai/deepseek-harness-acp) — ACP JSON-RPC over stdio
- [Cordis — The Plugin Kernel Behind DeepSeek Harness](https://floatboat.ai/blog/cordis-plugin-framework) — Koishi provenance, effect model
