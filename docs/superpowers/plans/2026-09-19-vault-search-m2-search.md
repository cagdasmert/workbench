# Vault search M2 — search: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the app, choose a folder, watch it index, type a Turkish concept, and get note
cards back in well under a second on a warm worker.

**Architecture:** `embed.py serve` is a persistent JSON-lines worker that holds the model and
the vector matrix. `modelctld` supervises it (lazy spawn, respawn on death). The worker exits
itself after 10 idle minutes. `/v1/search` and `/v1/embed` are plain requests proxied to it. The
plugin is a panel over `VaultClient`, following transcribe's shape: its own wire types, a
poller, a mailbox for commands, and the disposal test.

**Tech Stack:** Python 3.12 plus numpy (worker only), unittest; TypeScript, React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-vault-search-design.md`

## Global Constraints

- The daemon never imports numpy, torch, or sentence_transformers. Only `embed.py serve` / `embed.py index` do.
- Worker protocol: one JSON object per line on stdin, one reply line on stdout. Library noise goes to stderr.
- Worker idle exit: 600 s, overridable with `MODELCTL_EMBED_IDLE` (seconds).
- Hits are **one per note**: the best-scoring chunk of each file, top `limit` notes (default 8, max 50).
- Every hit carries `folder`.
- Plugin: no `any`, no Node builtins, no SDK change. Every command has an `args` schema (C5).
- The plugin id is `vault-search`, the panel `vault.main`, and the keybinding `cmd+shift+v`.
- `ctx.storage` holds `lastQuery` only in M2. Note text never goes there.
- Tests: daemon `cd ~/work/tools/huggingface && .venv/bin/python -m unittest discover -s tests -q`;
  workbench `npm test && npm run typecheck`.

---

### Task 1: Search core and the worker loop (`embed.py`)

**Files:**
- Modify: `~/work/tools/huggingface/embed.py`
- Test: `~/work/tools/huggingface/tests/test_embed_search.py`

**Interfaces:**
- Produces:
  - `class Searcher(conn, embed_fn)` with `.search(query:str, limit:int, folders:list[str]|None) -> dict`
    returning `{"hits": [...], "model": str, "took_ms": int}`. It reloads its matrix when
    `meta.generation` changes.
  - `serve_loop(lines: Iterable[str], write: Callable[[str], None], handle: Callable[[dict], dict]) -> None`
  - `handle_request(req: dict, get_searcher, get_embed) -> dict`: ops `search` and `embed`.
    Returns `{"ok": true, ...}` or `{"ok": false, "error": str, "status": int}`.
  - CLI `embed.py serve [--db PATH]`.
- Hit shape: `{folder, path (absolute), rel_path, title, heading, chunk, score (float, 4 dp), start_line}`.

- [ ] **Step 1: Failing tests.** Build a store with `index_folder` and a fake embedder that maps
  a text to a fixed 3-d vector keyed on words (`"kedi"` → `[1,0,0]`, `"köpek"` → `[0,1,0]`,
  anything else → `[0,0,1]`, then normalized). Assert:
  - The top hit for `"kedi"` is the cat note, with `folder`, an absolute `path`, `score` ≈ 1.0 and `start_line`.
  - Two chunks of one note produce one hit.
  - `folders=["Other"]` filters.
  - An unknown folder returns `status 404`.
  - After re-indexing with an edit, the same Searcher sees the new text (the generation reload).
  - Folders with different models searched together return `status 409`.
  - `serve_loop` turns a bad JSON line into `{"ok": false, ...}` and keeps reading.
  - `handle_request({"op":"nope"})` returns `status 400`.

- [ ] **Step 2: Run, verify they fail.**

- [ ] **Step 3: Implement** (append to `embed.py`; numpy imported inside `Searcher.__init__`):

```python
class Searcher:
    """The in-memory side of search: every vector as one float32 matrix, rebuilt
    when the store's generation moves. Lives only in `embed.py serve`."""

    def __init__(self, conn: sqlite3.Connection,
                 embed_fn: Callable[[list[str]], list[list[float]]], model: str) -> None:
        import numpy as np
        self._np = np
        self.conn, self.embed_fn, self.model = conn, embed_fn, model
        self._generation: str | None = None
        self._ids = np.zeros(0, dtype=np.int64)
        self._file_ids = np.zeros(0, dtype=np.int64)
        self._folders: list[str] = []
        self._matrix = np.zeros((0, 0), dtype=np.float32)

    def _refresh(self) -> None:
        row = self.conn.execute("SELECT value FROM meta WHERE key = 'generation'").fetchone()
        gen = row[0] if row else "0"
        if gen == self._generation:
            return
        np = self._np
        rows = self.conn.execute(
            "SELECT c.id, c.file_id, f.folder, c.vector FROM chunks c "
            "JOIN files f ON f.id = c.file_id JOIN folders d ON d.name = f.folder "
            "WHERE d.model = ? ORDER BY c.id", (self.model,)).fetchall()
        self._ids = np.array([r[0] for r in rows], dtype=np.int64)
        self._file_ids = np.array([r[1] for r in rows], dtype=np.int64)
        self._folders = [r[2] for r in rows]
        self._matrix = (np.frombuffer(b"".join(r[3] for r in rows), dtype=np.float32)
                        .reshape(len(rows), -1) if rows else np.zeros((0, 0), dtype=np.float32))
        self._generation = gen

    def search(self, query: str, limit: int, folders: list[str] | None) -> dict:
        np = self._np
        t0 = time.perf_counter()
        self._refresh()
        q = np.asarray(self.embed_fn([query])[0], dtype=np.float32)
        q /= max(float(np.linalg.norm(q)), 1e-12)
        if len(self._ids) == 0:
            return {"hits": [], "model": self.model, "took_ms": 0}
        scores = self._matrix @ q
        if folders is not None:
            mask = np.fromiter((f in folders for f in self._folders), dtype=bool, count=len(self._folders))
            scores = np.where(mask, scores, -np.inf)
        best: dict[int, tuple[float, int]] = {}
        for i in np.argsort(-scores):
            if not np.isfinite(scores[i]) or len(best) >= limit:
                break
            fid = int(self._file_ids[i])
            if fid not in best:
                best[fid] = (float(scores[i]), int(self._ids[i]))
        hits = []
        for fid, (score, cid) in best.items():
            r = self.conn.execute(
                "SELECT d.name, d.path, f.rel_path, f.title, c.heading, c.text, c.start_line "
                "FROM chunks c JOIN files f ON f.id = c.file_id JOIN folders d ON d.name = f.folder "
                "WHERE c.id = ?", (cid,)).fetchone()
            if r is None:
                continue
            hits.append({"folder": r[0], "path": str(Path(r[1]) / r[2]), "rel_path": r[2],
                         "title": r[3], "heading": r[4], "chunk": r[5],
                         "score": round(score, 4), "start_line": r[6]})
        return {"hits": hits, "model": self.model,
                "took_ms": int((time.perf_counter() - t0) * 1000)}
```

`handle_request` resolves the folder list:
- A folder not in `folders` is a 404.
- No folders at all is a 404 with the hint "POST /v1/index/folders first".
- The model is the selected folders' model. More than one model is a 409.
- `limit` is clamped to 1..50.
- `get_searcher(model)` returns a cached `Searcher`. When the model changes, the old one is
  dropped (one model resident).
- `op: "embed"` returns `{"ok": true, "vectors": [...], "model": m}` (model default
  `DEFAULT_MODEL`).

`serve_loop` (the stdin half is injectable for the tests):

```python
def serve_loop(lines, write, handle) -> None:
    for line in lines:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("request must be an object")
            reply = handle(req)
        except Exception as e:  # noqa: BLE001 -- a bad request must not end the worker
            reply = {"ok": False, "error": f"{type(e).__name__}: {e}", "status": 500}
        write(json.dumps(reply) + "\n")
```

`main` gets `serve`:
- Keep the protocol stream with `proto = os.fdopen(os.dup(1), "w", buffering=1)`, then point
  fd 1 at stderr (`os.dup2(2, 1)`), so a stray `print` from a library cannot corrupt the protocol.
- Read stdin with `select` and a timeout of `MODELCTL_EMBED_IDLE` (default 600). On timeout, exit 0.
- Loaded models live in a dict keyed by repo, holding at most one entry.

- [ ] **Step 4: Run, verify they pass.** Then commit nothing (the daemon repo is not under git).

---

### Task 2: Worker supervision and routes (`modelctld.py`)

**Files:**
- Modify: `~/work/tools/huggingface/modelctld.py`
- Test: `~/work/tools/huggingface/tests/test_modelctld_search.py`

**Interfaces:**
- Produces:
  - `class EmbedWorker(argv: list[str])` with `.call(req: dict) -> dict` and `.stop()`.
    `.call` is thread-safe (one lock). It spawns when there is no process or the process has
    exited. It writes one line and reads one line. EOF means the worker died: reset, and raise
    `ApiError(503, "the search worker exited: <last stderr line>", hint="retry — it restarts on the next request")`.
    Stderr is drained into a 50-line deque by a daemon thread.
  - `WORKER = EmbedWorker([sys.executable, EMBED_PY, "serve", "--db", str(embed.index_path())])`,
    created lazily at the first request, so the tests' env override applies.
  - `h_search(body)`: validates that `query` is a non-empty string, `limit` is an int, and
    `folders` is a list of strings or absent. Forwards `{"op":"search", ...}`. Maps
    `ok: false` to `ApiError(reply["status"], reply["error"], hint=reply.get("hint"))`.
  - `h_embed(body)`: validates `texts` as 1..256 strings, then forwards.
  - Routes: `POST /v1/search`, `POST /v1/embed`.
  - On shutdown (`serve()`'s `finally`), `WORKER.stop()`.

- [ ] **Step 1: Failing tests.** Use a fake worker script in a temp dir (the asr tests' pattern)
  that echoes `{"ok": true, "echo": req}` per line. Its `op: "die"` exits with a stderr line.
  Assert:
  - Two calls reuse one PID.
  - After `die`, the call raises 503 with that stderr text, and the next call spawns a new PID.
  - `h_search({"query": ""})` → 400.
  - `h_search({"query": "x", "folders": "a"})` → 400.
  - An `ok: false, status: 404` reply maps to `ApiError` 404.

- [ ] **Step 2: Run, verify failure. Step 3: Implement. Step 4: Run all daemon tests.**

- [ ] **Step 5: Real check.**
  - `curl -XPOST :8077/v1/search -d '{"query":"eklenti sözleşmesi neden dondurulmuş"}'` returns
    architecture/roadmap notes about the frozen plugin contract. Record `took_ms` for the cold
    first call and a warm second call.
  - Kill the worker PID; the next search answers 503, then the one after that succeeds.

---

### Task 3: Plugin scaffold, client, pure helpers

**Files:**
- Create: `plugins/vault-search/{package.json,tsconfig.json,plugin.json}`
- Create: `plugins/vault-search/src/client.ts`, `src/text.ts`, `src/text.test.ts`, `src/poller.ts`
- Modify: root `tsconfig.json` (add the reference). Run `npm install` to link the workspace.

**Interfaces:**
- `client.ts`: the wire types `Folder`, `Hit`, `SearchResult`, `EmbedJob` (the job shape from
  transcribe with `params: {folders?: string[]; full?: boolean}` and
  `result?: {folders: FolderResult[]} | null`).
  - `VaultClient`: `health()`, `folders()`, `addFolder({path, name?, model?, chunk_size?})`,
    `search({query, limit?, folders?})`, `job(id)`, `jobs()`, `cancel(id)`.
  - Error handling as `AsrClient`: `DaemonError` with kind `offline|denied|protocol|api`. The
    denied message names `plugins/vault-search/plugin.json`. The offline message is
    "The vault daemon isn't running."
  - `search` gets a 60 s timeout, because the first call loads LaBSE.
- `text.ts` (pure):
  - `wikilink(relPath: string): string`: `sub/Note name.md` → `[[Note name]]`.
  - `highlight(text: string, query: string): Array<{text: string; hit: boolean}>`: marks
    case-insensitive occurrences (Turkish-aware: `toLocaleLowerCase('tr')`) of query words of
    3 or more letters. It does not stem.
  - `excerpt(text: string, query: string, max = 320): string`: the window of `max` chars
    around the first highlighted word, with an ellipsis when cut. The whole text when it is
    shorter than `max`.
  - `progressOf(job: EmbedJob): {done: number; total: number} | null`: parses the last
    `N/M files` log line (`last_line` or `log`).
- `poller.ts`: a verbatim copy of transcribe's. Plugins do not import each other.

- [ ] **Step 1: Failing tests** in `text.test.ts`:
  - `wikilink('02_Projects/Local-Desktop-Util/architecture.md')` → `'[[architecture]]'`.
  - `highlight('İstanbul ve istanbul', 'İSTANBUL')` → two hits.
  - Words under 3 letters are never hit.
  - `excerpt` of a 1000-char text whose match sits at 600 starts with `…` and contains the match.
  - `progressOf` reads `"Calismalar: 32/319 files 10%"` → `{done: 32, total: 319}`. No line → `null`.
- [ ] **Step 2: Run, verify failure. Step 3: Implement. Step 4: `npm test` passes.**

`plugin.json`: PRD §5, minus `vault.reindex` (M3) and the answer settings (M4); M2 ships
`vault.open` and `vault.search`. `accepts`/`emits` land in M4 with their handlers. Settings:
`daemonUrl` and `token` verbatim from transcribe, plus `embedModel` and `chunkSize` with the
PRD's descriptions.

---

### Task 4: The panel and commands (`src/index.tsx`) and the disposal test

**Files:**
- Create: `plugins/vault-search/src/index.tsx`, `src/plugin.test.ts`

**Interfaces:**
- `export const plugin: Plugin`. `export const requests = mailbox<{query: string; limit: number}>()`,
  exported for the test only.
- Commands, with positional args in schema order:
  - `vault.open`: opens the panel.
  - `vault.search(query, limit=8, answer=false)`: opens the panel and sends to the mailbox.
    `answer` is accepted and ignored until M4.

Panel states:
1. **Loading.** Settings and storage are read first (TRAP 1). Nothing touches the net until
   they are loaded.
2. **Offline.** The `START_COMMAND` box and a Retry button (transcribe's view).
3. **No folders.** One button: *Choose a folder to index*. It calls `pickDirectory` →
   `addFolder({path, model: embedModel, chunk_size: chunkSize})` → **Indexing**.
4. **Indexing.** "Indexing *name* — 32 / 319 files", a progress bar, and Cancel. It polls
   `job(id)` every 1 s. On `done` it reloads folders. On `failed` it shows the error. On mount,
   a running `embed` job from `jobs()` is re-attached (DoD 3).
5. **Ready.** The search input (autofocus, Enter runs), under it the folder names with file
   counts, then the result cards.

Result card:
- Title, then the folder name as a small tag (PRD §10), then the score to 2 dp.
- `heading` in muted text when it is not empty.
- The passage `excerpt` with `<mark>` highlights. Clicking the card toggles between the excerpt
  and the full `chunk` with its `start_line`.
- `rel_path` in small type.
- Copy link, which writes `wikilink(rel_path)` to `navigator.clipboard` (as transcribe does).
- A search in flight shows "Searching…". The first search after a cold start can take several
  seconds, so the text changes to "Loading the model…" after 1.5 s.
- An empty result says "No notes matched".
- `lastQuery` is saved to storage when a search runs, and restored into the input on mount.
  The search is not re-run automatically.

The disposal test (transcribe's, adapted) asserts:
- `vault.open` leaves 3 disposables (panel + 2 commands), and all of them unwind.
- `vault.search('x')` with no panel mounted queues `{query: 'x', limit: 8}`, and deactivate clears it.
- Activation alone makes no network call.

- [ ] **Step 1: Write `plugin.test.ts`. Run it and verify it fails** (no `index.tsx`).
- [ ] **Step 2: Implement `index.tsx`. Step 3: `npm test && npm run typecheck && npm run build:plugins`.**
- [ ] **Step 4: Commit** the plugin.

---

### Task 5: Gate — a Turkish conceptual query from the app

- [ ] Start `modelctl serve` against the real index (`~/.local/share/modelctl/vault-index.sqlite`).
- [ ] Run `npm run dev`, open Vault (⌘⇧V), and choose `Calismalar`. The indexing progress runs to done.
- [ ] Search a Turkish concept whose words do not appear in the matching notes' filenames.
  Check that the top cards are relevant and that a literal filename search would not find
  them (PRD acceptance 2).
- [ ] Close the panel mid-index, reopen it, and check that the progress re-attaches.
- [ ] Check Copy link, card expand, and the offline view (stop the daemon).
- [ ] Append change-log entry 38. Commit.
