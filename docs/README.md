# Local Desktop Util (codename: Workbench)

> A single local macOS app that hosts a growing set of small utilities behind one
> window, one command palette, and one set of keybindings.
> **Status:** design complete, pre-M0 · **Stack:** Electron + TypeScript + React

**Docs:** [[architecture|Architecture Blueprint]] · [[m0-build-guide|M0 Build Guide]] · [[claude-md-for-repo|CLAUDE.md for the repo]] · [[ai-layer-options|AI Layer Options (decided)]] · [[project description|Original brief]]

---

## The Idea in One Paragraph

Not an app with features — a **host shell plus a plugin contract**. Each plugin
contributes a menu entry and a main panel that the shell mounts. The viewers
(mermaid, image, JSON) are deliberately disposable; the contract is the asset.
A typed content bus lets plugins hand data to each other, so each new plugin makes
every existing plugin more useful instead of just adding another tab.

---

## Roadmap

| Milestone | Deliverable | Status |
|---|---|---|
| **M0** | Shell + `hello` plugin + hot reload | ☐ not started |
| **M1** | Plugin API v1 + mermaid / image / JSON viewers | ☐ |
| **M2** | Command palette + typed content bus | ☐ |
| **M3** | Settings, keybindings, plugin manager | ☐ |
| **M4** | Packaging, ad-hoc signing, session restore | ☐ |

**M1 is the real test of the design.** If any of the three viewers forces a change to
the shell, the contract is wrong — fix it there rather than after M2.

---

## Plugin Backlog

Priority: **P1** = build early · **P2** = clear value · **P3** = someday

### Viewers

| Plugin | Priority | Notes |
|---|---|---|
| Mermaid diagram viewer | **P1** | M1. mermaid.js; live preview + SVG/PNG export |
| Image viewer | **P1** | M1. Zoom/pan, EXIF panel via exifr, basic format conversion |
| JSON formatter / visualizer | **P1** | M1. Tree view, JSONPath query, format/minify, diff two docs |
| Markdown preview | **P2** | Shares the render pipeline with mermaid |
| CSV / Parquet table viewer | **P2** | Sort, filter, column stats — the natural sink for JSON output |
| Diff viewer | **P2** | Text and image diff; universal sink for two-payload routing |
| Log tailer | **P2** | Follow file, regex highlight, level filtering |
| SQLite browser | **P3** | Schema tree, query editor, results into the table viewer |
| PDF viewer | **P3** | pdf.js; page extract, text extract |
| YAML viewer | **P3** | Mostly free once the JSON tree component exists |

### Converters

| Plugin | Priority | Notes |
|---|---|---|
| JSON ↔ YAML ↔ TOML | **P2** | Small, and immediately useful with the content bus |
| Base64 / hash / JWT decode | **P2** | One plugin, three panels |
| Epoch & timezone converter | **P2** | |
| Image resize / format convert | **P3** | Feeds the image viewer |
| Unit converter | **P3** | |

### Dev Tools

| Plugin | Priority | Notes |
|---|---|---|
| Regex tester | **P2** | Live match highlighting, capture group table |
| HTTP client | **P3** | Needs the `net:` permission story to be real |
| Cron expression parser | **P3** | Next-N-runs preview |
| SQL formatter | **P3** | |
| Clipboard history | **P3** | Universal sink (`accepts: ["*"]`) — good bus stress test |

### Local AI

| Plugin | Priority | Notes |
|---|---|---|
| Ollama chat panel | **P2** | Connects to existing local-inference work |
| Text → mermaid | **P2** | Emits `text/vnd.mermaid` straight into the mermaid viewer — the clearest demo of why the bus exists |
| "Explain this JSON/log" | **P3** | Accepts from any structured-data plugin |

### Personal

| Plugin | Priority | Notes |
|---|---|---|
| Obsidian vault quick-search | **P2** | Search + append-to-daily-note against `Calismalar`. Turns the app into a daily driver rather than an occasional utility |
| Scratchpad | **P3** | Universal sink; persistent |

---

## Key Decisions

Full rationale in [[architecture#11-decision-log|the decision log]].

- **Electron + TypeScript** — every target plugin is a rendering problem, and the
  rendering libraries live in JS
- **In-process plugins, async-only API** — simple now, and isolation stays buyable
  later because nothing crosses the boundary that can't be serialized
- **Typed content bus from v1** — composition can't be retrofitted without rewriting
  every manifest
- **Lazy activation** — plugins load on their activation events, not at startup
- **Permissions declared, not enforced** — documents reach, marks the seam
- **No DeepSeek Harness, no Cordis** — kernel stays hand-rolled; the AI layer is a thin
  `AiProvider` plugin against an OpenAI-compatible endpoint at M2

---

## Next Actions

- [ ] Pick a real name
- [ ] Decide: React components as panels, vs framework-agnostic `mount(el, ctx)`
- [ ] Scaffold the workspace (`packages/`, `plugins/`, `tools/create-plugin`)
- [ ] Build M0: shell + `hello` plugin + hot reload loop
- [ ] Freeze `@workbench/plugin-sdk` v1 types before starting M1
