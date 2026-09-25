# Vault search (P2) — design deltas

**Date:** 2026-09-19 · **Source PRD:** vault `02_Projects/Huggingface/PRD/P2-vault-search.md`
(constraints C1–C5 in `PRD/README.md`) · **Status:** approved in session, implementing M1

The PRD is the spec. This file records only what was decided on top of it.

## Where the code lives

| Part | Location |
|---|---|
| Plugin (TypeScript) | `workbench/plugins/vault-search/` |
| Chunking, store, indexer, search worker | `~/work/tools/huggingface/embed.py` (new) |
| Routes, worker supervision | `~/work/tools/huggingface/modelctld.py` (edited) |
| Answer fallback runtime (M4) | `~/work/tools/huggingface/text.py` (new) |

## Decisions

1. **The daemon never imports torch or numpy.** Embedding runs in two kinds of subprocess:
   - **Indexing** is a job, `kind: 'embed'`, `repo` = the embedding model, argv
     `embed.py index …`. Progress, cancel and the one-job-per-repo 409 come from the existing
     machinery. The script prints `n/total` lines, each carrying a percentage for `PERCENT_RE`.
   - **Search and `/v1/embed`** go to one persistent worker, `embed.py serve`, which the
     daemon starts lazily on the first request. JSON lines on stdin/stdout, one request at a
     time behind a lock. The worker holds the model and the vector matrix, and exits after 10
     minutes idle. A dead worker is respawned on the next request, so a torch crash costs one
     failed search, not the server. (Rejected: in-process, where a crash takes the daemon;
     subprocess per query, 3–6 s cold load on every search.)
   - While an index job runs, the model is in memory twice (~2 × 2 GB). Accepted.
2. **Store: one SQLite file**, `~/.local/share/modelctl/vault-index.sqlite` (overridable with
   `MODELCTL_VAULT_INDEX`). It lives beside the catalog, never in `ctx.storage`. Tables:
   - `folders(name PK, path, model, chunk_size, include, exclude, indexed_at)`
   - `files(id, folder, rel_path, mtime, sha256, title)`
   - `chunks(id, file_id, ord, heading, text, start_line, vector BLOB float32)`
   - `links(file_id, target)`: outgoing wikilinks. Filled from day one, not used for ranking
     yet, so link-graph weighting will not need a re-index.
   - `meta(key, value)`: holds `generation`, bumped on every committed write. The worker
     reloads its matrix when `generation` moves.
   Search is brute-force cosine over L2-normalised vectors. Revisit only if a measured search
   takes over ~200 ms.
3. **Chunking.** Front matter is stripped. A note up to `chunk_size` tokens (counted with the
   model's own tokenizer) is one chunk. A longer note is split on headings, then on blank-line
   paragraphs, then hard-split. Every split chunk's embedded text starts with its heading path
   (`Title › H2 › H3`). The stored `text` is the passage itself, and `heading` is stored
   separately. `start_line` is 1-based in the original file. The title is the first `# ` heading,
   else the file stem.
4. **Folder defaults.** Includes `**/*.md`. Excludes `.obsidian/`, `.trash/`, and any
   dot-directory. Symlinks are not followed.
5. **Change detection.** A file is re-embedded when its mtime changed *and* its sha256 differs.
   If only the mtime changed, the mtime is updated without re-embedding. Deleted files are
   removed. `full: true` re-embeds everything.
6. **Settings mismatch is surfaced, never silently fixed.** Each folder records the `model`
   and `chunk_size` it was built with. A non-full refresh with different values is a 409 with a
   hint to pass `full: true`. The panel shows "settings changed — full re-index needed" and
   asks before sending it.
7. **`GET /v1/index/folders` gains `changed`.** It is computed from a stat walk (mtimes plus
   added and removed files, no hashing), so it is cheap enough to call when the panel opens.
   A hash-only false positive is acceptable: Refresh then re-embeds nothing.
8. **Answer mode is plugin-side.** This drops `answer` from `/v1/search`. The panel calls
   `/v1/search`, builds a prompt with numbered passages, and sends it to the OpenAI-compatible
   endpoint (`answerUrl`, default `http://localhost:1234/v1`, LM Studio). If that endpoint is
   unreachable, the fallback is `POST /v1/generate/text` on the daemon (`text.py`, mlx-lm, a job
   like asr). The prompt is built once, in the plugin, for both backends. Citations are `[n]`
   markers, rendered as links to the matching result card. Plugins cannot call each other's
   commands (no `executeCommand` in the SDK), so this cannot go through `ai-provider`.
9. **Every hit carries `folder`**, so two vaults with overlapping ideas stay distinguishable
   (PRD §10).
10. **`vault.search` is a real command.** It opens the panel with the query as the payload and
    runs the search. `vault.reindex` refreshes every folder.

## Wire contract

Additions to the PRD §7 contract are marked ★, removals ✗.

```
POST   /v1/index/folders   { path, name?, include?, exclude?, model?, chunk_size? }
       → Job (kind 'embed')
       400 path not an absolute existing directory · 409 name exists with a different path ·
       409 model busy
GET    /v1/index/folders
       → { folders: [{ name, path, files, chunks, indexed_at, model, chunk_size,
                       ★ changed }] }
POST   /v1/index/refresh   { name?, full?, model?, chunk_size? }   → Job
       name omitted = every folder, one job
       ★ 409 model/chunk_size differ from the folder's and full is not set
DELETE /v1/index/folders/<name>                                    → { ok: true }
POST   /v1/embed           { texts: [...], model? }                → { vectors, model }
POST   /v1/search          { query, limit? = 8, folders? }  ✗ answer
       → { hits: [{ ★ folder, path, title, heading, chunk, score, start_line }], model,
           ★ took_ms }
       404 no folders indexed

★ M4: POST /v1/generate/text  { messages, model?, max_tokens? } → Job
       result: { text, model }
```

Job `params` for `embed`: `{ folders: [names], full }`. Job `result`:
`{ folders: [{ name, files, chunks, embedded, removed }] }`.

## Plugin layout

```
plugins/vault-search/
  plugin.json         PRD §5, plus answerUrl, and net:fetch:localhost:1234
  src/client.ts       VaultClient — CatalogClient's shape; errors name the fix
  src/answer.ts       prompt building, citation parsing, LM Studio → text.py fallback
  src/staleness.ts    "Indexed 2 days ago · 41 files changed"
  src/wikilink.ts     path → [[wikilink]]
  src/index.tsx       panel (first run / search / answer) + commands
  src/*.test.ts       disposal test first, then pure tests
```

`ctx.storage` holds `folders` (names only), `lastQuery`, and `answerMode`. Note text never
passes through it.

## Milestones and gates

- **M1 index.** `embed.py` (chunker, store, `index`) plus the folder routes. Gate: `curl`
  indexes `Calismalar` and reports files and chunks. A daemon restart plus a refresh
  re-embeds 0 files.
- **M2 search.** The worker, `/v1/search`, `/v1/embed`, the panel, the result cards. Gate: a
  Turkish conceptual query from the app.
- **M3 incremental.** `changed`, Refresh, the staleness line, multiple folders, delete. Gate:
  editing one note re-embeds one file.
- **M4 answers.** The answer toggle, LM Studio, `text.py` fallback, citations, bus
  `accepts`/`emits`, disposal test. Gate: PRD §11.

Each milestone appends to `docs/m1-shell-change-log.md`.
