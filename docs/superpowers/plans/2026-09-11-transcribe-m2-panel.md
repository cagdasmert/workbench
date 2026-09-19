# Transcribe M2 — the panel — Implementation Plan

> Executed inline in the session that wrote it, so tasks carry interfaces and test cases; the
> source files are the code. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pick a file, see its duration and size, pick model and language, run, watch progress,
read the timestamped transcript. No saving (M3), no capability warning / cancel / bus emit /
re-attach (M4).

**Architecture:** A new workbench plugin `plugins/transcribe`, scaffolded with
`npm run create-plugin`. `client.ts` is the only file that knows HTTP; `poller.ts` is the poll
loop as a start/stop object; the panel is one component with an explicit view state machine.

**Spec:** `docs/superpowers/specs/2026-09-11-transcribe-design.md` · M1 wire is live on the daemon.

## Global Constraints

- Branch `transcribe`. No commits unless asked. `plugins/model-manager` is untouched.
- SDK frozen: no change to `packages/plugin-sdk`, `packages/shell`, `packages/main`.
- No `any`; no Node builtins in the plugin; every `PluginContext` call is async.
- Manifest is the PRD §5 manifest minus `vaultPath`, declared in full now so it does not churn.
- Command args are positional, in schema property order (as `model-manager` does).

## Deviation found while planning

**No drop target.** A dropped `File` has no path in a sandboxed renderer (Electron ≥32 removed
`File.path`; `webUtils.getPathForFile` is preload-only). Exposing it would pass a `File` across
the plugin boundary — invariant 2. Bytes instead of a path is C2/C3's failure mode. So the empty
state is **Choose file…** only. Revisit only with a real SDK decision.

## Tasks

### Task 1: scaffold + manifest + vitest include
- `npm run create-plugin transcribe` (adds workspace + root tsconfig reference).
- Replace `plugin.json` with the PRD manifest minus `vaultPath`; `menu.group: "tools"`.
- `vitest.config.ts` include gains `plugins/*/src/**/*.test.ts`.
- Verify: `npm install`, `npm run typecheck`, `npm test` (29 existing still pass).

### Task 2: `format.ts` (pure, TDD)
- `formatTimestamp(s)` — mirrors `asr.format_timestamp`: `00:00`, `01:23`, `1:02:05`, negative → `00:00`.
- `formatDuration(s | null)` — `8 s`, `4 min 6 s`, `1 h 2 min`, `null` → `unknown length`.
- `formatBytes(n)` — `74 KB`, `3.4 MB`, `1.5 GB`.

### Task 3: `poller.ts` (TDD, fake timers)
`startPoller<T>({ fetch, onValue, onError, next, errorDelayMs = 3000 }) → { stop() }`
- polls immediately, then after `next(value)` ms; `next` returning `undefined` ends the loop;
- a fetch error calls `onError` and retries after `errorDelayMs` (the daemon may be restarting);
- `stop()` cancels the pending timer **and** drops the result of an in-flight fetch.

### Task 4: `client.ts` + `capabilities.ts`
- `AsrClient(ctx, baseUrl, token)`: `health()`, `installed()` (repos from `/v1/catalog/models`),
  `probe(path)`, `start({path, model, language})`, `job(id)`, `jobs()`.
- `DaemonError(message, hint?, kind)`, `kind: 'offline' | 'denied' | 'protocol' | 'api'` — the
  panel shows the Offline view for `offline` only (acceptance 4), an error bar otherwise.
- Denied-host message names `plugins/transcribe/plugin.json`.
- `capabilities.ts`: `DEFAULT_MODEL`, `MODELS` (the PRD §6 three, with a one-line note each),
  `PINNED_LANGUAGES` (auto, tr, en), `OTHER_LANGUAGES` (Parakeet's 25 plus ar, fa, ja, ko, zh).
  The language→model table itself lands in M4.

### Task 5: the panel (`index.tsx`)
View states: `empty → probing → configured → running → done | failed`, plus `offline`.
- **empty / configured:** Choose file… (`fs.pickFile` with audio and video filters); file name,
  duration, size; model select (default: storage `lastModel`, else the `model` setting; models not
  on disk marked "not downloaded"); language select (pinned first); Transcribe.
- **running:** progress bar from `job.percent` (indeterminate while `null`), elapsed, `last_line`
  monospace. Poller at 1 s.
- **done:** header with Copy all, model and elapsed; segments with a click-to-copy `[mm:ss]`
  (copies that segment's line); New transcription.
- **failed:** `job.error` and the log tail; Try again (back to configured).
- **offline:** "The transcription daemon isn't running", the exact start command, Retry.
- Storage: `lastModel`, `lastLanguage` (restore-before-save flag).
- Commands: `transcribe.open`; `transcribe.file(path, model, language)` opens the panel and runs
  it; with no path it opens the file picker. A request made before the panel mounts is held and
  consumed on mount (not dropped).
- Payload with string `meta.path` preselects that file.

### Task 6: gate
Daemon up → run the Turkish memo from the app → transcript renders with `[00:00]`. Daemon down →
Offline view names the fix, no spinner. `npm run typecheck`, `npm test`. Change log entry 33.
