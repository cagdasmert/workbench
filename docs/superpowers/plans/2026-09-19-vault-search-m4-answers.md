# Vault search M4 — answers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An *Answer* toggle beside the search box. When on, the top passages go to a local
LLM and an answer appears above the cards, each claim followed by `[n]` pointing at its card.
The bus sends a paragraph in (use case 3) and the answer or hits out as markdown.

**Architecture:** The prompt is built once, in the plugin (`answer.ts`, pure). It goes to LM
Studio's OpenAI-compatible endpoint first. When LM Studio is unreachable, or has no model
loaded and none is named, it goes to the daemon's new `POST /v1/generate/text`: a `text` job
running `text.py` (mlx-lm) over a catalog model. The same prompt serves both backends.

**Spec:** `docs/superpowers/specs/2026-09-19-vault-search-design.md` (decision 8)

## Global Constraints

- Answer mode is off by default (PRD §4). The toggle is stored as `answerMode` in `ctx.storage`.
- At most 6 passages go to the model, each cut to 1,200 characters. The passage number is the card number.
- The system prompt: answer only from the numbered notes, cite `[n]` after each claim, say
  so when the notes do not contain the answer, answer in the question's language.
- `<think>…</think>` blocks are stripped from every answer. Several local models emit them.
- Settings:
  - `answerUrl` (default `http://localhost:1234/v1`).
  - `answerModel` (default `""`: the model LM Studio has loaded, read from its `/api/v0/models`).
  - `fallbackModel` (default `mlx-community/Qwen3-0.6B-4bit`, a catalog repo for `text.py`).
    The PRD's 27B is not downloaded, and a fallback that cannot run is not a fallback.
- Permissions gain `net:fetch:localhost:1234` and `net:fetch:127.0.0.1:1234`.
- Bus: `accepts: ["text/plain"]` → a search with that text as the query, capped at 2,000
  characters. `emits: ["text/markdown"]` → *Send* on the results.
- `text.py`'s top level is cheap to import. mlx_lm is imported inside `generate()`.

---

### Task 1: `text.py` and `POST /v1/generate/text` (daemon)

**Files:** Create `~/work/tools/huggingface/text.py` and `tests/test_text.py`. Modify
`modelctld.py` and add `tests/test_modelctld_text.py`.

**Interfaces:**
- `text.py`:
  - `validate_messages(raw) -> list[dict]` raises `TextError`. It accepts 1–50 items of
    `{role: system|user|assistant, content: str}`, 200 KB total.
  - `strip_think(s) -> str`.
  - `generate(messages, model_dir, *, repo, max_tokens) -> dict` returns `{text, model}`.
  - CLI: `text.py --model R --messages FILE --out FILE [--max-tokens N]`. It prints `loading`,
    `generating`, and `NN%` by tokens/max_tokens.
- Route: `POST /v1/generate/text {messages, model?, max_tokens? = 1024}` → the Job (`kind:
  'text'`, `repo` = model).
  - 400 on bad messages.
  - 404 when the model is not downloaded (with a pull hint).
  - 409 when that model is busy.
  - The messages go through a temp file; the result goes through `result_path` (the asr
    pattern), `{text, model}`.
- The 501 hint in `/v1/generate/*` names `asr` and `text` as live.

- [ ] Tests: `validate_messages` rejections (not a list, empty, a bad role, a non-string
  content, too large). `strip_think` handles a closed block, an unclosed leading block, and
  no block. The route: a 400, a 404 with `mc.resolve` stubbed to `None`, and a started job's
  argv and params with `start_job` stubbed.
- [ ] Implement. Run all daemon tests.
- [ ] Real run: after `curl` a Turkish question plus 2 passages through `mlx-community/Qwen3-0.6B-4bit`,
  poll to done, and read `result.text`.

### Task 2: `answer.ts` (pure)

**Interfaces:**
- `buildMessages(query: string, hits: Hit[]): ChatMessage[]` with `ChatMessage = {role: 'system'|'user'; content: string}`
- `parseAnswer(text: string, count: number): Array<{text: string} | {cite: number}>`
  - It strips `<think>`.
  - It splits `[1]`, `[2, 3]`, and `[1][3]` into cites.
  - It drops out-of-range numbers, keeping the brackets as text so nothing is silently rewritten.
- `pickLoadedModel(apiV0: unknown): string | null`: the first `type: 'llm'` with `state: 'loaded'`.
- `answerMarkdown(query, answer, hits): string` for *Send*. Cites become `[[wikilink]]`s and
  a `## Sources` list follows.
- `hitsMarkdown(query, hits): string` is the same without an answer.

- [ ] Tests for each. Implement. Run `npm test`.

### Task 3: Backends, panel, bus

**Files:** `plugins/vault-search/{plugin.json, src/client.ts, src/llm.ts, src/index.tsx, src/plugin.test.ts}`

- `VaultClient.generateText({messages, model, max_tokens}) → EmbedJob-shaped job`. The
  result is `{text, model}` (a `TextJob` type).
- `llm.ts` defines `answerWith(ctx, client, {answerUrl, answerModel, fallbackModel}, messages, onStage)`,
  which returns `{text, model, backend: 'lmstudio'|'daemon'}`.
  1. With `answerModel` empty, it reads `answerUrl`'s origin `/api/v0/models`. It uses
     `pickLoadedModel`, and with none loaded it goes to the fallback.
  2. It POSTs `chat/completions` (`temperature 0.2`, `max_tokens 1024`, 180 s timeout, since
     LM Studio may JIT-load).
  3. Network failure or no model → `generateText`, polled every 1 s until done, with
     `onStage('Answering with <fallbackModel> in modelctld…')`. An HTTP error *from* LM Studio
     is shown, not silently rerouted.
- The panel:
  - An *Answer* checkbox beside Search.
  - After hits arrive with answer on, the answer box shows its stage ("Asking LM Studio…"),
    then the parsed answer with `[n]` as small buttons that expand and scroll to card n. The
    footer reads "via LM Studio · glm-4.7-flash".
  - Cards show their number.
  - An answer error is shown in the box and never hides the hits.
  - A new search drops a stale answer (a sequence number, as for search).
- `vault.search(query, limit, answer)`: `answer: true` turns answer mode on for that search.
- The bus:
  - `ctx.bus.onReceive` for `text/plain`. When a panel is listening, send
    `{kind:'search', query: text.slice(0, 2000), limit: 8}` and return `{handled: true}`.
    Otherwise decline, so the host opens the panel with the payload (ai-provider's rule,
    change log 36).
  - On mount, a string `ctx.payload.data` becomes the query and runs once.
  - *Send* emits `text/markdown`.
- Disposal test: 5 disposables (+ onReceive). A received text with no panel is declined (the
  result is `undefined`). Activation still makes no network call.

- [ ] Update the disposal test and watch it fail. Implement. `npm test && npm run typecheck && npm run build:plugins`.

### Task 4: Gate — PRD §11

- [ ] Criterion 4: answer questions from the vault through LM Studio and through the fallback.
  Check every `[n]` against its passage.
- [ ] Criterion 5: send a paragraph over the bus (in the app, the user's check). Offline LM
  Studio → the fallback answers.
- [ ] Criterion 6: `ctx.storage` keys are `lastQuery`, `scope`, `answerMode`. Grep the
  storage writes.
- [ ] Change-log entry 40. Commit.
