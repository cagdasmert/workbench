# Transcribe (P1) — design deltas

**Date:** 2026-09-11 · **Source PRD:** vault `02_Projects/Huggingface/PRD/P1-transcribe.md`
(constraints C1–C5 in `PRD/README.md`) · **Status:** approved in session, implementing M1

The PRD is the spec. This file records only what was decided on top of it, so the PRD does not
have to be read side by side with a diff.

## Where the code lives

| Part | Location |
|---|---|
| Plugin (TypeScript) | `workbench/plugins/transcribe/` |
| Runtime script | `~/work/tools/huggingface/asr.py` (new) |
| Routes | `~/work/tools/huggingface/modelctld.py` (edited) |

## Decisions

1. **Result channel: an `--out` file.** The daemon passes `asr.py` a temp JSON path; on exit 0
   it loads that file into `job.result` and deletes it. The log stays human-readable, and a
   two-hour transcript never passes through the 400-line log deque. (Rejected: a sentinel
   stdout line — one enormous line through the char-at-a-time reader; in-process transcription
   — breaks "every generation runs as a subprocess".)
2. **`asr.py` is importable cheaply.** Top level holds the capability table and validation
   (`LANGUAGES`, `check_language`, `ffmpeg` presence); `mlx_whisper` / `parakeet_mlx` are
   imported inside the transcribe functions. The daemon imports it in-process to validate a
   request *before* starting a job, so a bad combination is a 400, not a failed job — and the
   table has one Python definition, mirrored once in TypeScript.
3. **Video input: accepted.** Both runtimes decode through `ffmpeg`, so video costs nothing
   extra. Missing `ffmpeg` is refused up front (503, hint `brew install ffmpeg`).
4. **Contention: 409, not a queue.** `job.repo` is the model repo, so the existing
   one-job-per-repo rule refuses a second run on the same model — and also refuses a run while
   that model is being pulled or moved, which is correct. "Queue the rest" (C4) is deferred.
5. **The save route renders the markdown** (as the PRD has it: `job_id`, not content). This
   keeps the daemon's write primitive narrow — it writes transcripts of its own jobs, never
   caller-supplied bytes. The plugin has a small second renderer for the bus only.
6. **`vaultPath` setting dropped.** Plugins cannot write settings, so the PRD's "set it by
   choosing a folder in the panel" cannot work. The destination is `ctx.storage.vaultDir`,
   set through `pickDirectory`. One owner.
7. **Criterion 5 is met through `ai-provider`.** Nothing accepts `text/markdown` today and the
   bus matches exact types only. `ai-provider` gains `text/markdown` in `accepts`. *As built:*
   ai-provider is text → mermaid, not a summariser, and its handler claimed content even with no
   panel listening — dropping it, since `handled` stops the host before it opens the panel. It
   now declines when no panel is mounted, so the host opens the AI panel with the transcript as
   its payload (prefilled, not auto-run). P2 becomes a second target when it exists.
8. **Auto-save deferred.** Done properly it needs a `save_dir` on the POST so the daemon saves
   with the panel closed. Add it if losing a finished transcript to a daemon restart bites.
9. **Re-attach by asking the daemon.** On mount the panel reads `GET /v1/jobs` for a running
   `asr` job; no job id is stored. The daemon is the only thing that knows the truth.
10. **Received content.** A payload with a string `meta.path` preselects that file. A
    byte-only payload gets a notice — C2 says paths, not bytes.
11. **`recent` entries gain `savedPath`** (`string | null`), so a recent whose job the daemon
    has forgotten can still point at the file on disk. Still metadata only.

## Wire contract (as built)

Additions to the PRD §7 contract are marked ★.

```
★ GET  /v1/generate/asr/probe?path=<abs>
    → { path, name, size, duration, has_audio }        # ffprobe; 400 if missing / no audio

  POST /v1/generate/asr
    { path, model?, language? }                         # language: ISO code or 'auto'
    → Job                                               ★ the job dict, like pull/mv/rm
    400 path not absolute / not a file · 400 model does not support language (hint names one
    that does) · 404 model not downloaded (hint: pull) · 409 model busy (hint: job id) ·
    503 ffmpeg missing

  GET  /v1/jobs/<id>
    → Job + { params: {path, language}, result? }
       result: { text, segments: [{start, end, text}], language, duration, model }
  GET  /v1/jobs                                         # list: params, no result, no log

  POST /v1/generate/asr/save
    { job_id, dir, filename?, frontmatter?, timestamps? = true }
    → { path }
    400 job not a finished asr job · 400 dir not an absolute existing directory.
    Never overwrites: `name.md`, `name-2.md`, … via exclusive create.
```

`timestamps` and `vad` are **not** on the POST: segments are always returned, and timestamps
are a rendering choice made at save time. VAD has no runtime behind it yet.

**Saved markdown:** YAML front matter (`title`, `source`, `model`, `language`, `duration`,
`transcribed`, then caller `frontmatter` keys — fixed keys win on conflict; every value
JSON-quoted, which is valid YAML), then `# <title>`, then one paragraph per segment,
prefixed `[mm:ss]` (`[h:mm:ss]` past an hour) when `timestamps` is true. Default filename
`YYYY-MM-DD <input stem>.md`; `/` and `:` in a caller filename are replaced.

## Plugin layout

```
plugins/transcribe/
  plugin.json          PRD §5 minus vaultPath
  src/client.ts        AsrClient — CatalogClient's shape; errors name the fix
  src/capabilities.ts  model → languages mirror, checkLanguage()
  src/markdown.ts      timestamp formatting, bus rendering
  src/poller.ts        poll loop as a start/stop object, testable without a DOM
  src/index.tsx        panel (empty / configured / running / done) + commands
  src/*.test.ts        pure tests + disposal test
```

`vitest.config.ts` `include` gains `plugins/*/src/**/*.test.ts`.

**Capability warnings.** Parakeet + an unsupported language (Turkish is the one that matters):
hard warning, Run disabled. Parakeet + `auto`: soft warning that Turkish audio will be
mistranscribed, Run enabled.

## Milestones and gates

Per PRD §11, stopping at each gate:

- **M1 wire** — `asr.py`, the routes. Gate: `curl` a real Turkish memo through probe → run →
  poll → save.
- **M2 panel** — pick, probe, run, poll, render. Gate: transcribe from the app.
- **M3 vault** — folder picker, save, `recent`. Gate: file lands in the vault.
- **M4 polish** — capability warning, cancel, bus emit, re-attach, disposal test. Gate: PRD §10.

Each milestone appends to `docs/m1-shell-change-log.md`.
