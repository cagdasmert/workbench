# Transcribe M3 — the vault — Implementation Plan

> Executed inline in the session that wrote it; tasks carry interfaces and test cases, the
> source files are the code. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** *Save to vault* writes the transcript as markdown through the daemon (C1) and shows the
written path; the destination folder is chosen once with `pickDirectory` and remembered; the
empty state lists the last five transcriptions, each reopening its text.

**Architecture:** Plugin-only. The daemon's `POST /v1/generate/asr/save` (M1) already renders
front matter and refuses to overwrite. `recent.ts` holds the list logic as pure functions over a
JSON-safe type, so the storage round trip is narrowed in one tested place.

**Spec:** `docs/superpowers/specs/2026-09-11-transcribe-design.md` (decisions 6, 11).

## Global Constraints

- Nothing but metadata in `ctx.storage` (PRD §8): `vaultDir`, `recent` — never transcript text.
- `recent` holds at most 5 `{jobId, filename, when, model, chars, savedPath}`; newest first.
- The plugin never writes a file; it sends `job_id` + `dir`, the daemon writes (C1).
- No reveal-in-Finder: the SDK has no `openPath`, and adding one is a capability change. The
  written path is shown and copyable.
- The gate writes into a scratch folder, never the user's real vault.

## Tasks

### Task 1: `recent.ts` (pure, TDD)
- `type RecentEntry = { jobId: string; filename: string; when: number; model: string; chars: number; savedPath: string | null }`
- `parseRecent(raw: unknown): RecentEntry[]` — drops malformed entries, caps at 5.
- `addRecent(list, entry): RecentEntry[]` — newest first, replaces an entry with the same
  `jobId` (keeping its `savedPath` if the new one has none), caps at 5.
- `markSaved(list, jobId, path): RecentEntry[]`.
- `timeAgo(when, now): string` — `just now`, `5 min ago`, `3 h ago`, `2 d ago`.

### Task 2: `client.save`
`save({ job_id, dir, timestamps }): Promise<{ path: string }>`, 30 s timeout.

### Task 3: panel
- Load `vaultDir`, `recent`, and the `timestamps` setting with the rest (TRAP 1).
- A job reaching `done` is added to `recent` once (effect keyed on job id).
- **Done header:** *Save to vault* (primary) → folder is `vaultDir`, or `pickDirectory()` the
  first time (cancel = no save) → `client.save` → button replaced by `Saved to <path>` + copy
  path. A `folder: <name> · change` link re-picks. A daemon 400 (folder gone) is an error bar.
- **Empty state:** "Recent" list — filename, model, chars, time ago, `saved` marker. Click →
  `client.job(id)`: done → the Done view; running → the Running view; 404 → an error bar saying
  the daemon forgot it, naming `savedPath` if there is one.

### Task 4: gate
Daemon + app up. Transcribe the Turkish memo → Save → pick a scratch folder → path shown, file
has front matter and `[00:00]` lines; save a second job → `-2` or its own dated name; close and
reopen the panel → Recent lists both, reopening shows the text; restart the daemon → reopening
says it is gone and names the saved file. `tsc -b`, `npm test`. Change log entry 34.
