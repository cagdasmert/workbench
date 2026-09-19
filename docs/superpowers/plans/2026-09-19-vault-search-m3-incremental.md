# Vault search M3 — incremental: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The panel says how stale each folder is, refreshes only what changed, holds more
than one folder, lets a search target some of them, and removes a folder. The daemon already
does all of this except removal over POST (M1).

**Architecture:** One daemon route is added: `POST /v1/index/folders/<name>/remove`, because
`net.fetch` cannot send DELETE (change log 38). The rest is plugin work: a pure `staleness.ts`,
a folder list with per-folder actions, a scope filter, a settings-mismatch notice, and
`vault.reindex`.

**Spec:** `docs/superpowers/specs/2026-09-19-vault-search-design.md`

## Global Constraints

- Everything in M2's constraints holds.
- `ctx.storage` gains `scope`: the folder names a search is limited to. `[]` means all. These are names only.
- A settings mismatch (`embedModel` or `chunkSize` differs from a folder's) is never
  re-indexed without a confirming click. The daemon's 409 guards the same line server-side.
- `autoRefresh` (default true): when the panel connects and some folder with matching settings
  has `changed > 0`, the panel starts one refresh on its own. Off, it only shows the line.
  This is the setting's meaning, since `changed` is always computed.

---

### Task 1: `POST /v1/index/folders/<name>/remove`

**Files:** Modify `~/work/tools/huggingface/modelctld.py`. Test in `tests/test_modelctld_index.py`.

- [ ] Test: the route table maps `POST ["index","folders",name,"remove"]` to `h_index_delete`
  (call `Handler._route` on a bare instance, via `object.__new__(d.Handler)`). A second remove
  is a 404. The URL-quoted name `Not%20lar` resolves to `Not lar`.
- [ ] Implement: add the route beside the DELETE one, sharing `h_index_delete`. Put it in the
  banner.
- [ ] Run all daemon tests.

### Task 2: `staleness.ts`

**Files:** Create `plugins/vault-search/src/staleness.ts` and `staleness.test.ts`.

**Interface:** `staleness(folder: Folder, now: number, settings: {model: string; chunkSize: number}):
{ text: string; tone: 'ok' | 'stale' | 'warn'; needsFull: boolean }`, where `now` is in unix seconds.

| Case | text | tone |
|---|---|---|
| `indexed_at === null` | `Not indexed yet` | warn |
| `changed === null` | `Folder unreachable — is the drive mounted?` | warn |
| model/chunk_size ≠ settings | `Settings changed — full re-index needed` (`needsFull: true`) | warn |
| `changed === 0` | `Indexed 2 days ago · up to date` | ok |
| `changed > 0` | `Indexed 2 days ago · 41 files changed` (`1 file changed`) | stale |

Age: `just now` under 60 s, then `N minutes ago`, `N hours ago`, `yesterday`, `N days ago`.
Singulars are `1 minute`, `1 hour`.

- [ ] Tests for every row above, the age boundaries (59 s, 60 s, 3599 s, 1 day, 2 days), and the singular.
- [ ] Implement. Run `npm test`.

### Task 3: Client, commands, panel

**Files:** Modify `plugins/vault-search/{plugin.json,src/client.ts,src/index.tsx,src/plugin.test.ts}`.

**Interfaces:**
- `VaultClient.refresh(req: {name?: string; full?: boolean; model?: string; chunk_size?: number}): Promise<EmbedJob>`
- `VaultClient.removeFolder(name: string): Promise<{ok: true}>` (POST `/remove`)
- The mailbox becomes `Request = {kind:'search'; query; limit} | {kind:'reindex'; full: boolean}`.
- `vault.reindex(full = false)`: opens the panel and queues `{kind:'reindex', full}`. Its
  manifest entry comes from PRD §5, as does `autoRefresh`.

Panel changes:
- **Folders section** (a collapsible row under the search box, open when there are no
  results). For each folder:
  - the name, `N notes`, and the staleness line in its tone;
  - *Refresh*: `refresh({name})`, or, when `needsFull`, *Re-index* with an inline
    "Re-embed all N notes? This takes a while. [Re-index] [Cancel]";
  - *Remove*: an inline "Remove *name* from the index? Notes are not touched. [Remove] [Cancel]".
  - At the end, *Add folder* (the M2 pick flow).
- **Scope:** with two or more folders, each folder name above the results is a toggle chip.
  None selected means all. The selection is saved as `scope` and sent as `folders`. A folder
  that no longer exists is dropped from `scope` on load.
- **A refresh that 409s on settings** shows the same inline confirm as `needsFull`.
- **Refresh all** (the command, or a link when more than one folder is stale):
  `refresh({full})` with no name. When the folders' models differ, it refreshes each folder in
  turn instead. One job runs at a time, and the next starts when the last finishes.
- **After any index job finishes**, reload the folders. That clears the "changed" count.
- **autoRefresh** as in the Global Constraints: it runs once per mount and never overlaps a running job.

Disposal test: 4 disposables (panel + 3 commands). `vault.reindex(true)` queues
`{kind:'reindex', full: true}`. The search expectations become `{kind:'search', …}`.

- [ ] Update the disposal test. Watch it fail.
- [ ] Implement. `npm test && npm run typecheck && npm run build:plugins`.
- [ ] Commit.

### Task 4: Gate — edit one note, Refresh re-embeds one file

- [ ] `curl`: add a second folder (the scratch copy) to the real index. Edit one note there.
  `GET /v1/index/folders` shows `changed: 1`. `POST /refresh` for that name gives `embedded: 1`.
  `POST /remove` removes it.
- [ ] In the app (the user's check): the staleness line, Refresh, scope chips, Remove.
- [ ] Change-log entry 39. Commit.
