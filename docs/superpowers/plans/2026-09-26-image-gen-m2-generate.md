# Images M2 — generate: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `image-gen` Workbench plugin. It has a Generate form over M1's daemon routes, a status that says "Loading model…" until the first step, a result view that shows the written path, and a history strip that survives restarts and re-attaches to a job still running.

**Architecture:** This is a new plugin in `plugins/image-gen/`, built on the transcribe plugin's patterns.
- `client.ts` is the only file that knows HTTP.
- `history.ts`, `form.ts` and `reattach.ts` are pure and unit-tested.
- `poller.ts` is copied verbatim from transcribe (spec decision 22).
- `index.tsx` holds the panel and the two commands.

The daemon is the only record of jobs. The panel asks `GET /v1/jobs` on mount, and the `imagegen.generate` command posts its own job, then nudges an already-open panel to look again.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), React 19, the Workbench plugin SDK 1.7 (no change), vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-25-image-gen-design.md`. The M2 row of the milestone table and decisions 3, 5, 7, 14–18, 21 and 22 apply. M1 (the daemon side) is `docs/superpowers/plans/2026-09-25-image-gen-m1-wire.md`.

**Order:** Tasks 1–5 need no models and can run before M1's gate. Task 6, the app gate, runs after M1's gate, on the models the user pulled.

## Global Constraints

- **The CLAUDE.md invariants hold.**
  - Every `PluginContext` call is async.
  - Nothing non-serializable crosses the plugin boundary.
  - The plugin imports no Node builtins and no Electron.
  - There is no `any`; use `unknown` and narrow.
  - The code is ESM, bundled by esbuild into one file.
- **No SDK change.** Only SDK 1.7's existing surface is used.
- **Ids, copied verbatim:**
  - plugin `image-gen`, name `Images`
  - panel `imagegen.main`
  - commands `imagegen.open` and `imagegen.generate`
  - keybinding `cmd+shift+g`
- **Default model, copied verbatim:** `mflux-community/z-image-turbo-mflux-q8`. A model is a repo id, or an absolute folder path starting with `/` or `~` (spec decision 5). A folder path is never marked "not downloaded".
- **Storage key `history`** holds `HistoryEntry[]` (spec decision 16), newest first, capped at the `historyLimit` setting, whose default is 200.
- **The daemon is the only record of jobs.** No pointer to a running job is ever stored: the panel works it out from `GET /v1/jobs` (spec decision 17). A finished history entry does carry its job id, as its key (decision 16).
- **Status wording:** `percent === null` shows `Loading model…`; otherwise the status is `Generating N%` (spec decision 7).
- **The written path is always shown under the result** (spec decision 21, PRD criterion 5).
- **Commands carry a complete `args` block** (C5). Their positional args arrive in schema order.
- **No agent downloads models.** The user pulls them with `modelctl`.
- **Tests:** `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen` while working, then `npm test` and `npm run typecheck` before each commit. Before this plan the suite passes 173 vitest tests and `tsc -b` is clean.
- Work on branch `image-gen`. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `plugins/image-gen/package.json`, `tsconfig.json`, `plugin.json` | the workspace package, the TS project, and the manifest |
| `plugins/image-gen/src/client.ts` | `ImageClient`: wire types and the HTTP errors that name the fix |
| `plugins/image-gen/src/poller.ts` (+ test) | transcribe's poller, copied verbatim |
| `plugins/image-gen/src/history.ts` | `HistoryEntry`, `fromJob`, `addHistory`, `parseHistory`, `historyLimit`, `shortModel`, `describeEntry` |
| `plugins/image-gen/src/form.ts` | the Generate form, the request it becomes, command args, model options, seed, placeholders, status |
| `plugins/image-gen/src/reattach.ts` | what a freshly mounted panel adopts from `GET /v1/jobs` |
| `plugins/image-gen/src/index.tsx` | the panel, the two commands, and the `jobStarted` nudge |
| `plugins/image-gen/src/*.test.ts` | one test file per module, plus `plugin.test.ts`, the disposal test |
| `tsconfig.json` (root), `package-lock.json` | the project reference, and the workspace link |

---

### Task 1: The plugin package, its manifest, the client, and the poller

**Files:**
- Create: `plugins/image-gen/package.json`, `plugins/image-gen/tsconfig.json`, `plugins/image-gen/plugin.json`
- Create: `plugins/image-gen/src/client.ts`, `plugins/image-gen/src/client.test.ts`
- Create: `plugins/image-gen/src/poller.ts`, `plugins/image-gen/src/poller.test.ts` (copies)
- Modify: `tsconfig.json` (root), `package-lock.json` (via `npm install`)

**Interfaces:**
- Produces:
  - Types: `Role`, `ImageModel`, `ImageResult`, `JobState`, `ImageJob`, `GenerateRequest`
  - `DEFAULT_DAEMON_URL`, `START_COMMAND`
  - `DaemonError(message, hint, kind)` with `kind: 'offline' | 'denied' | 'protocol' | 'api'`, and `asDaemonError(err)`
  - `ImageClient(ctx: Pick<PluginContext, 'net'>, baseUrl?, token?)`, with methods `health()`, `models()`, `generate(req)`, `job(id)`, `jobs()` and `cancel(id)`
  - `startPoller<T>(opts)` and `Poller`, identical to transcribe's

- [ ] **Step 1: The package, TS project and manifest**

Create `plugins/image-gen/package.json`:

```json
{
  "name": "@workbench-plugin/image-gen",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@workbench/plugin-sdk": "*",
    "react": "*",
    "react-dom": "*"
  },
  "devDependencies": {
    "@workbench/plugin-host": "*"
  }
}
```

Create `plugins/image-gen/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "../../.tsbuild/plugin-image-gen",
    "rootDir": "src",
    "lib": [
      "ES2022",
      "DOM"
    ],
    "jsx": "react-jsx"
  },
  "include": [
    "src"
  ],
  "references": [
    {
      "path": "../../packages/plugin-sdk"
    },
    {
      "path": "../../packages/plugin-host"
    }
  ]
}
```

Create `plugins/image-gen/plugin.json`. The fs permissions, `accepts`/`emits`, and the edit and upscale settings arrive with the milestones that use them (M3, M4):

```json
{
  "id": "image-gen",
  "name": "Images",
  "version": "1.0.0",
  "apiVersion": "1.0",
  "main": "./dist/index.js",
  "activationEvents": [
    "onCommand:imagegen.open",
    "onCommand:imagegen.generate"
  ],
  "contributes": {
    "panels": [
      {
        "id": "imagegen.main",
        "title": "Images"
      }
    ],
    "menu": [
      {
        "command": "imagegen.open",
        "label": "Images",
        "group": "tools"
      }
    ],
    "commands": [
      {
        "id": "imagegen.open",
        "title": "Open Images",
        "args": {
          "type": "object",
          "properties": {},
          "required": []
        }
      },
      {
        "id": "imagegen.generate",
        "title": "Generate an Image",
        "args": {
          "type": "object",
          "properties": {
            "prompt": {
              "type": "string",
              "description": "What to draw"
            },
            "model": {
              "type": "string",
              "description": "Repo id or absolute folder path; empty uses the configured default",
              "default": ""
            },
            "steps": {
              "type": "number",
              "description": "Sampling steps; 0 uses the model default",
              "default": 0
            },
            "seed": {
              "type": "number",
              "description": "Seed; 0 means random",
              "default": 0
            }
          },
          "required": ["prompt"]
        }
      }
    ],
    "settings": {
      "daemonUrl": {
        "type": "string",
        "default": "http://127.0.0.1:8077",
        "description": "Where `modelctl serve` is listening. Only 127.0.0.1:8077 and localhost:8077 are reachable — a different port needs a matching net:fetch permission in plugin.json."
      },
      "token": {
        "type": "string",
        "default": "",
        "description": "Sent as X-Modelctl-Token. Leave empty unless the daemon was started with --token."
      },
      "model": {
        "type": "string",
        "default": "mflux-community/z-image-turbo-mflux-q8",
        "description": "Text-to-image model: a repo id pulled with modelctl, or an absolute folder path whose name contains the model family (e.g. z-image-turbo)."
      },
      "outputDir": {
        "type": "string",
        "default": "",
        "description": "Folder generated images are written to. Empty uses ~/Pictures/Workbench. Must already exist."
      },
      "historyLimit": {
        "type": "number",
        "default": 200,
        "description": "How many past generations the history strip keeps."
      }
    },
    "keybindings": [
      {
        "command": "imagegen.open",
        "key": "cmd+shift+g"
      }
    ]
  },
  "permissions": [
    "net:fetch:127.0.0.1:8077",
    "net:fetch:localhost:8077"
  ]
}
```

In the root `tsconfig.json`, add after the `plugins/vault-search` reference:

```json
    {
      "path": "plugins/image-gen"
    }
```

Link the workspace: `cd /Users/cagdasmert/work/WS/workbench && npm install --no-audit --no-fund`. Expected: `package-lock.json` gains an `@workbench-plugin/image-gen` entry, and nothing else changes.

- [ ] **Step 2: Copy the poller and its test verbatim**

```bash
cd /Users/cagdasmert/work/WS/workbench
cp plugins/transcribe/src/poller.ts plugins/image-gen/src/poller.ts
cp plugins/transcribe/src/poller.test.ts plugins/image-gen/src/poller.test.ts
```

This is the third identical copy, and spec decision 22 says so. Extracting all three is a separate follow-up.

- [ ] **Step 3: Write the failing client tests**

Create `plugins/image-gen/src/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { NetRequestInit, NetResponse } from '@workbench/plugin-sdk';
import { DaemonError, ImageClient, START_COMMAND } from './client.js';

function make(answer: (url: string, init?: NetRequestInit) => Promise<NetResponse>, token = '') {
  const fetch = vi.fn(answer);
  return { fetch, client: new ImageClient({ net: { fetch } }, 'http://127.0.0.1:8077/', token) };
}

const ok = (body: unknown): NetResponse => ({ status: 200, ok: true, headers: {}, body: JSON.stringify(body) });

describe('ImageClient', () => {
  it('posts a generate request as JSON, with the token when one is set', async () => {
    const { fetch, client } = make(async () => ok({ id: 'j1', kind: 'image' }), 's3cret');
    await client.generate({ prompt: 'a gate', model: 'm/x' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8077/v1/generate/image');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body ?? '')).toEqual({ prompt: 'a gate', model: 'm/x' });
    expect(init?.headers?.['x-modelctl-token']).toBe('s3cret');
  });

  it('unwraps the models list', async () => {
    const row = {
      repo: 'm/x', family: 'z-image-turbo', role: 'generate', negative: false,
      defaults: { steps: 9, width: 1024, height: 1024 },
    };
    const { client } = make(async () => ok({ models: [row] }));
    expect(await client.models()).toEqual([row]);
  });

  it('names plugin.json when the host is not in the permissions', async () => {
    const { client } = make(async () => { throw new Error('net:fetch denied for http://127.0.0.1:9000'); });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).kind).toBe('denied');
    expect((err as DaemonError).hint).toContain('plugins/image-gen/plugin.json');
  });

  it('reports an unreachable daemon as offline, with the command that starts it', async () => {
    const { client } = make(async () => { throw new Error('ECONNREFUSED'); });
    const err = (await client.health().catch((e: unknown) => e)) as DaemonError;
    expect([err.kind, err.hint]).toEqual(['offline', START_COMMAND]);
  });

  it("passes the daemon's own error and hint through", async () => {
    const { client } = make(async () => ({
      status: 409, ok: false, headers: {},
      body: JSON.stringify({ error: 'another image job is running (m/x)', hint: 'poll /v1/jobs/abc' }),
    }));
    const err = (await client.generate({ prompt: 'x', model: 'm/x' }).catch((e: unknown) => e)) as DaemonError;
    expect([err.kind, err.message, err.hint]).toEqual(['api', 'another image job is running (m/x)', 'poll /v1/jobs/abc']);
  });

  it('calls a non-JSON answer a protocol error', async () => {
    const { client } = make(async () => ({ status: 200, ok: true, headers: {}, body: '<html>' }));
    expect(((await client.jobs().catch((e: unknown) => e)) as DaemonError).kind).toBe('protocol');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen`
Expected: `client.test.ts` fails because `./client.js` cannot be resolved; the 4 `poller.test.ts` tests pass.

- [ ] **Step 5: Create `plugins/image-gen/src/client.ts`**

```ts
import type { PluginContext } from '@workbench/plugin-sdk';

/**
 * The only file in this plugin that knows HTTP exists.
 *
 * Same shape as transcribe's `AsrClient`, deliberately not shared with it:
 * each plugin owns its wire types, and a plugin importing another plugin's
 * source would be a dependency the host knows nothing about. The panel talks
 * to `ImageClient` and would not notice if the transport changed.
 */

// ─── wire types (mirror daemon/modelctld.py and daemon/image.py) ───
export type Role = 'generate' | 'edit' | 'upscale';

/** One row of GET /v1/generate/image/models: a downloaded repo and how to run it. */
export interface ImageModel {
  repo: string;
  family: string;
  role: Role;
  negative: boolean;
  defaults: { steps: number | null; width: number | null; height: number | null };
}

/** A finished job's result. Keys the request did not use are absent: image.py drops nulls. */
export interface ImageResult {
  mode: Role;
  model: string;
  seed: number;
  steps?: number;
  prompt?: string;
  negative?: string;
  instruction?: string;
  source?: string;
  factor?: number;
  width: number;
  height: number;
  path: string;
  preview_b64: string;
  load_s: number;
  gen_s: number;
  peak_gb: number | null;
}

export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

export interface ImageJob {
  id: string;
  kind: string;
  /** For an image job, the model's catalog repo (or its folder, outside the catalog). */
  repo: string;
  state: JobState;
  started: number;
  finished: number | null;
  elapsed: number;
  exit_code: number | null;
  /** null while the model loads: image.py prints no '%' before the first step. */
  percent: number | null;
  error: string | null;
  params: { mode?: Role; model?: string; prompt?: string; seed?: number; steps?: number };
  /** Only on `job(id)`. */
  log?: string[];
  /** Only on `jobs()`. */
  last_line?: string;
  /** Only on `job(id)`, once done. */
  result?: ImageResult | null;
}

/** POST /v1/generate/image. Absent fields take the model's defaults; an absent seed is random. */
export interface GenerateRequest {
  prompt: string;
  model: string;
  negative?: string;
  steps?: number;
  seed?: number;
  width?: number;
  height?: number;
  out_dir?: string;
}

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8077';

/** What starts the daemon: the `modelctl` shim runs daemon/modelctl.py with the venv's Python. */
export const START_COMMAND = 'modelctl serve';

/**
 * Why a request failed, as the one fact the panel branches on. Only `offline`
 * gets the full "start the daemon" view; everything else is an error bar,
 * because the daemon is up and said something specific.
 */
export type DaemonErrorKind = 'offline' | 'denied' | 'protocol' | 'api';

export class DaemonError extends Error {
  constructor(message: string, readonly hint: string | undefined, readonly kind: DaemonErrorKind) {
    super(message);
    this.name = 'DaemonError';
  }
}

export function asDaemonError(err: unknown): DaemonError {
  return err instanceof DaemonError ? err : new DaemonError(String(err), undefined, 'api');
}

interface ErrorBody { error?: unknown; hint?: unknown }

export class ImageClient {
  constructor(
    private readonly ctx: Pick<PluginContext, 'net'>,
    private readonly baseUrl: string = DEFAULT_DAEMON_URL,
    private readonly token: string = '',
  ) {}

  get url(): string { return this.baseUrl; }

  health(): Promise<{ ok: boolean; version: string }> { return this.get('/v1/health', 5_000); }

  /** Downloaded image models and their per-family defaults (spec decision 4). */
  async models(): Promise<ImageModel[]> {
    const r = await this.get<{ models: ImageModel[] }>('/v1/generate/image/models', 30_000);
    return r.models;
  }

  generate(req: GenerateRequest): Promise<ImageJob> {
    return this.post('/v1/generate/image', req, 30_000);
  }

  job(id: string): Promise<ImageJob> { return this.get(`/v1/jobs/${encodeURIComponent(id)}`); }
  jobs(): Promise<{ jobs: ImageJob[] }> { return this.get('/v1/jobs'); }

  /** Terminates the image.py subprocess; the next poll sees `cancelled`. */
  cancel(id: string): Promise<{ cancelling: string }> {
    return this.post(`/v1/jobs/${encodeURIComponent(id)}/cancel`, {});
  }

  private get<T>(path: string, timeoutMs = 15_000): Promise<T> {
    return this.request<T>('GET', path, undefined, timeoutMs);
  }

  private post<T>(path: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    return this.request<T>('POST', path, JSON.stringify(body), timeoutMs);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token !== '') headers['x-modelctl-token'] = this.token;

    let res;
    try {
      res = await this.ctx.net.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        timeoutMs,
      });
    } catch (err: unknown) {
      // The broker throws for two very different reasons and the difference is
      // the whole diagnosis: a denied host is a manifest bug Settings cannot
      // fix, an unreachable one is just a daemon that isn't up.
      const message = err instanceof Error ? err.message : String(err);
      if (/denied/i.test(message)) {
        throw new DaemonError(
          `${this.baseUrl} is not in this plugin's net:fetch permissions.`,
          'Settings can only point at 127.0.0.1:8077 or localhost:8077 — anything else '
          + 'needs a new entry in plugins/image-gen/plugin.json.',
          'denied',
        );
      }
      throw new DaemonError("The image daemon isn't running.", START_COMMAND, 'offline');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new DaemonError(
        `${this.baseUrl} answered ${res.status} with a non-JSON body.`,
        `Is something other than modelctld listening there? ${res.body.slice(0, 120)}`,
        'protocol',
      );
    }

    if (!res.ok) {
      const e = parsed as ErrorBody;
      throw new DaemonError(
        typeof e.error === 'string' ? e.error : `HTTP ${res.status}`,
        typeof e.hint === 'string' ? e.hint : undefined,
        'api',
      );
    }
    return parsed as T;
  }
}
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen && npm run typecheck && npm test`
Expected: `client.test.ts` 6 and `poller.test.ts` 4 pass; `tsc -b` is clean; the full suite passes with 183 tests.

- [ ] **Step 7: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add plugins/image-gen tsconfig.json package-lock.json
git commit -m "image-gen: the plugin package, its manifest, the client, the poller

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: History — the strip's entries, as stored

**Files:**
- Create: `plugins/image-gen/src/history.ts`
- Test: `plugins/image-gen/src/history.test.ts`

**Interfaces:**
- Consumes: `ImageJob`, `ImageResult`, `Role` (Task 1)
- Produces:
  - `HistoryEntry` (a type alias; its fields are listed below)
  - `DEFAULT_HISTORY_LIMIT = 200`
  - `fromJob(job: ImageJob): HistoryEntry | null`
  - `addHistory(list, entry, limit): HistoryEntry[]`
  - `parseHistory(raw: unknown, limit: number): HistoryEntry[]`
  - `historyLimit(raw: unknown): number`
  - `shortModel(model: string): string`
  - `describeEntry(e: HistoryEntry): string`

- [ ] **Step 1: Write the failing tests**

Create `plugins/image-gen/src/history.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ImageJob } from './client.js';
import {
  addHistory, DEFAULT_HISTORY_LIMIT, describeEntry, fromJob, historyLimit, parseHistory, shortModel,
  type HistoryEntry,
} from './history.js';

const REPO = 'mflux-community/z-image-turbo-mflux-q8';

const done = (id: string, finished: number): ImageJob => ({
  id, kind: 'image', repo: REPO, state: 'done', started: finished - 14, finished, elapsed: 14.2,
  exit_code: 0, percent: 100, error: null, params: {},
  result: {
    mode: 'generate', model: REPO, seed: 42, steps: 9, prompt: 'a gate', width: 1024, height: 1024,
    path: '/pics/20260926-120000_generate_42.png', preview_b64: 'AAAA', load_s: 5.1, gen_s: 9.0, peak_gb: 12.3,
  },
});

function entry(id: string, whenSeconds: number): HistoryEntry {
  const e = fromJob(done(id, whenSeconds));
  if (e === null) throw new Error('fixture must be a finished job');
  return e;
}

describe('fromJob', () => {
  it('turns a finished job into an entry, with nulls for what the request did not use', () => {
    expect(fromJob(done('a', 1_758_880_000))).toEqual({
      id: 'a', mode: 'generate', model: REPO, seed: 42, steps: 9, width: 1024, height: 1024,
      prompt: 'a gate', negative: null, instruction: null, source: null, factor: null,
      path: '/pics/20260926-120000_generate_42.png', thumb_b64: 'AAAA',
      when: 1_758_880_000_000, elapsed: 14.2,
    });
  });

  it('gives nothing for a job that is running, failed, or finished without a result', () => {
    const base = done('a', 100);
    expect(fromJob({ ...base, state: 'running' })).toBeNull();
    expect(fromJob({ ...base, state: 'failed' })).toBeNull();
    expect(fromJob({ ...base, result: null })).toBeNull();
  });
});

describe('addHistory', () => {
  it('keeps the newest first and replaces an entry with the same id', () => {
    let list: HistoryEntry[] = [];
    list = addHistory(list, entry('a', 1), 10);
    list = addHistory(list, entry('c', 3), 10);
    list = addHistory(list, entry('b', 2), 10);
    list = addHistory(list, entry('c', 3), 10);
    expect(list.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('prunes the oldest past the limit', () => {
    let list: HistoryEntry[] = [];
    for (const [id, t] of [['a', 1], ['b', 2], ['c', 3]] as const) list = addHistory(list, entry(id, t), 2);
    expect(list.map((e) => e.id)).toEqual(['c', 'b']);
  });
});

describe('parseHistory', () => {
  it('keeps only well-formed entries, and nothing from a non-array', () => {
    const good = entry('a', 1);
    expect(parseHistory('x', 10)).toEqual([]);
    expect(parseHistory([good, { ...good, id: 'b', path: 5 }, { ...good, id: 'c', mode: 'draw' }], 10)).toEqual([good]);
  });
});

describe('historyLimit', () => {
  it('falls back to the default for anything that is not a positive number', () => {
    for (const raw of [undefined, 0, -3, 'x', Number.NaN]) expect(historyLimit(raw)).toBe(DEFAULT_HISTORY_LIMIT);
    expect(historyLimit(50)).toBe(50);
    expect(historyLimit(12.7)).toBe(12);
  });
});

describe('shortModel', () => {
  it("names a repo, a modelctl snapshot folder, and any other folder by its model", () => {
    expect(shortModel(REPO)).toBe('z-image-turbo-mflux-q8');
    expect(shortModel('/Volumes/Kingston/hf-cache/models--mflux-community--z-image-turbo-mflux-q8/snapshots/abc'))
      .toBe('z-image-turbo-mflux-q8');
    expect(shortModel('/Users/me/models/z-image-turbo-q8/')).toBe('z-image-turbo-q8');
    expect(shortModel('~/models/zit')).toBe('zit');
  });
});

describe('describeEntry', () => {
  it('says what produced the image in one line', () => {
    expect(describeEntry(entry('a', 1))).toBe('seed 42 · 9 steps · 1024×1024 · 14.2 s · z-image-turbo-mflux-q8');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen/src/history.test.ts`
Expected: FAIL, because `./history.js` cannot be resolved.

- [ ] **Step 3: Create `plugins/image-gen/src/history.ts`**

```ts
import type { ImageJob, Role } from './client.js';

/**
 * The history strip, as stored in `ctx.storage` under 'history' (PRD §8,
 * spec decision 16).
 *
 * This is the one plugin where storage carries content, a thumbnail, and that
 * is deliberate (PRD §8): a preview of your own generation is not sensitive the
 * way a transcript is. The full image never goes here; it is a file on disk,
 * referenced by path.
 *
 * A type alias with nulls, not an interface with optional fields:
 * `storage.set<T>` needs T to satisfy JsonValue.
 */
export type HistoryEntry = {
  /** The job id. */
  id: string;
  mode: Role;
  model: string;
  seed: number;
  steps: number | null;
  width: number;
  height: number;
  prompt: string | null;
  negative: string | null;
  instruction: string | null;
  source: string | null;
  factor: number | null;
  path: string;
  /** The result's preview_b64, stored unchanged: a JPEG no larger than 512 px. */
  thumb_b64: string;
  /** Epoch millis. */
  when: number;
  /** Seconds, from the job. */
  elapsed: number;
};

export const DEFAULT_HISTORY_LIMIT = 200;

const ROLES: readonly string[] = ['generate', 'edit', 'upscale'];
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown): boolean => v === null || isStr(v);
const numOrNull = (v: unknown): boolean => v === null || isNum(v);

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return isStr(e['id']) && isStr(e['mode']) && ROLES.includes(e['mode'])
    && isStr(e['model']) && isNum(e['seed']) && numOrNull(e['steps'])
    && isNum(e['width']) && isNum(e['height'])
    && strOrNull(e['prompt']) && strOrNull(e['negative']) && strOrNull(e['instruction'])
    && strOrNull(e['source']) && numOrNull(e['factor'])
    && isStr(e['path']) && isStr(e['thumb_b64']) && isNum(e['when']) && isNum(e['elapsed']);
}

const byNewest = (a: HistoryEntry, b: HistoryEntry): number => b.when - a.when;

/** Whatever storage hands back, narrowed. A bad entry is dropped, not trusted. */
export function parseHistory(raw: unknown, limit: number): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isEntry).sort(byNewest).slice(0, limit);
}

/** A finished job as an entry, or null when it has no result to show. */
export function fromJob(job: ImageJob): HistoryEntry | null {
  const r = job.result;
  if (job.state !== 'done' || r === null || r === undefined) return null;
  return {
    id: job.id,
    mode: r.mode,
    model: r.model,
    seed: r.seed,
    steps: r.steps ?? null,
    width: r.width,
    height: r.height,
    prompt: r.prompt ?? null,
    negative: r.negative ?? null,
    instruction: r.instruction ?? null,
    source: r.source ?? null,
    factor: r.factor ?? null,
    path: r.path,
    thumb_b64: r.preview_b64,
    when: Math.round((job.finished ?? job.started) * 1_000),
    elapsed: job.elapsed,
  };
}

/** Add, or replace by id; newest first; the oldest are pruned past `limit`. */
export function addHistory(list: readonly HistoryEntry[], entry: HistoryEntry, limit: number): HistoryEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].sort(byNewest).slice(0, Math.max(1, limit));
}

/** The `historyLimit` setting, or the default when it is not a positive number. */
export function historyLimit(raw: unknown): number {
  return isNum(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_HISTORY_LIMIT;
}

/**
 * A short label: a repo's name, or a folder's model name. A modelctl snapshot
 * folder (`.../models--org--name/snapshots/<hash>`) is named by its repo.
 */
export function shortModel(model: string): string {
  const cached = /models--[^/]+--([^/]+)/.exec(model);
  if (cached?.[1] !== undefined) return cached[1];
  const parts = model.split('/').filter((p) => p !== '');
  return parts[parts.length - 1] ?? model;
}

/** What produced the image, in one line under the result. */
export function describeEntry(e: HistoryEntry): string {
  const parts = [`seed ${e.seed}`];
  if (e.steps !== null) parts.push(`${e.steps} steps`);
  parts.push(`${e.width}×${e.height}`, `${e.elapsed.toFixed(1)} s`, shortModel(e.model));
  return parts.join(' · ');
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen && npm run typecheck && npm test`
Expected: `history.test.ts` 8 pass; `tsc -b` is clean; the full suite passes.

- [ ] **Step 5: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add plugins/image-gen/src/history.ts plugins/image-gen/src/history.test.ts
git commit -m "image-gen: history — entries as stored, newest first, capped

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The form — what the user typed, and the request it becomes

**Files:**
- Create: `plugins/image-gen/src/form.ts`
- Test: `plugins/image-gen/src/form.test.ts`

**Interfaces:**
- Consumes: `GenerateRequest`, `ImageModel` (Task 1); `shortModel` (Task 2)
- Produces:
  - Constants: `DEFAULT_GENERATE_MODEL`, `MAX_SEED`
  - `GenerateForm` (a type)
  - `emptyForm(model): GenerateForm`
  - `isPath(model): boolean`
  - `ModelOption` (a type), and `modelOptions(catalog, configured, role): ModelOption[]`
  - `FormResult` (a type)
  - `toGenerateRequest(form, { negative, outDir }): FormResult`
  - `commandRequest(args, { model, outDir }): FormResult`
  - `rollSeed(random?): number`
  - `afterRun(form, usedSeed): GenerateForm`
  - `placeholders(info): { steps; width; height }`
  - `runStatus(percent): string`

- [ ] **Step 1: Write the failing tests**

Create `plugins/image-gen/src/form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ImageModel } from './client.js';
import {
  afterRun, commandRequest, DEFAULT_GENERATE_MODEL, emptyForm, MAX_SEED, modelOptions, placeholders,
  rollSeed, runStatus, toGenerateRequest, type GenerateForm,
} from './form.js';

const Z: ImageModel = {
  repo: DEFAULT_GENERATE_MODEL, family: 'z-image-turbo', role: 'generate', negative: false,
  defaults: { steps: 9, width: 1024, height: 1024 },
};
const QWEN: ImageModel = {
  repo: 'mflux-community/qwen-image-edit-2511-mflux-q6', family: 'qwen-image-edit', role: 'edit', negative: false,
  defaults: { steps: 20, width: null, height: null },
};

const form = (patch: Partial<GenerateForm>): GenerateForm => ({ ...emptyForm(DEFAULT_GENERATE_MODEL), ...patch });
const opts = { negative: false, outDir: '' };

describe('toGenerateRequest', () => {
  it('sends only the prompt and model when nothing else is set, leaving steps to the model (criterion 1)', () => {
    expect(toGenerateRequest(form({ prompt: '  a green gate ' }), opts))
      .toEqual({ ok: true, req: { prompt: 'a green gate', model: DEFAULT_GENERATE_MODEL } });
  });

  it('sends every field that is set', () => {
    const f = form({ prompt: 'x', steps: '12', width: '768', height: '512', seed: '7', seedLocked: true, negative: 'blur' });
    expect(toGenerateRequest(f, { negative: true, outDir: ' /pics ' })).toEqual({
      ok: true,
      req: {
        prompt: 'x', model: DEFAULT_GENERATE_MODEL, negative: 'blur', steps: 12, width: 768, height: 512,
        seed: 7, out_dir: '/pics',
      },
    });
  });

  it('leaves an unlocked seed out, which the daemon reads as random', () => {
    expect(toGenerateRequest(form({ prompt: 'x', seed: '7', seedLocked: false }), opts))
      .toEqual({ ok: true, req: { prompt: 'x', model: DEFAULT_GENERATE_MODEL } });
  });

  it('drops a negative prompt the model cannot take', () => {
    expect(toGenerateRequest(form({ prompt: 'x', negative: 'blur' }), opts))
      .toEqual({ ok: true, req: { prompt: 'x', model: DEFAULT_GENERATE_MODEL } });
  });

  it('refuses what cannot be sent at all', () => {
    expect(toGenerateRequest(form({ prompt: '   ' }), opts)).toEqual({ ok: false, error: 'Write a prompt first.' });
    expect(toGenerateRequest(form({ prompt: 'x', steps: '9a' }), opts))
      .toEqual({ ok: false, error: 'Steps must be a whole number' });
  });
});

describe('commandRequest', () => {
  const settings = { model: DEFAULT_GENERATE_MODEL, outDir: '' };

  it('takes the configured model for an empty one, and treats 0 as not set (the manifest says so)', () => {
    expect(commandRequest(['a gate', '', 0, 0], settings))
      .toEqual({ ok: true, req: { prompt: 'a gate', model: DEFAULT_GENERATE_MODEL } });
    expect(commandRequest(['a gate'], settings))
      .toEqual({ ok: true, req: { prompt: 'a gate', model: DEFAULT_GENERATE_MODEL } });
  });

  it('passes a model, steps, seed and the output folder through', () => {
    expect(commandRequest(['a gate', '/m/z-image-turbo', 4, 9], { model: 'x', outDir: '/pics' })).toEqual({
      ok: true, req: { prompt: 'a gate', model: '/m/z-image-turbo', steps: 4, seed: 9, out_dir: '/pics' },
    });
  });

  it('needs a prompt', () => {
    expect(commandRequest([], settings)).toEqual({ ok: false, error: 'imagegen.generate needs a prompt.' });
  });
});

describe('modelOptions', () => {
  it('lists the downloaded models for the role', () => {
    expect(modelOptions([Z, QWEN], DEFAULT_GENERATE_MODEL, 'generate')).toEqual([
      { value: DEFAULT_GENERATE_MODEL, label: 'z-image-turbo-mflux-q8', info: Z, missing: false },
    ]);
  });

  it('puts a configured repo the catalog lacks first, marked not downloaded', () => {
    const [first] = modelOptions([Z], 'org/z-image-turbo-other', 'generate');
    expect(first).toEqual({ value: 'org/z-image-turbo-other', label: 'z-image-turbo-other — not downloaded', info: null, missing: true });
  });

  it('never marks a folder path missing: the catalog cannot know about it', () => {
    const [first] = modelOptions([Z], '/Users/me/models/z-image-turbo-q8', 'generate');
    expect(first).toEqual({ value: '/Users/me/models/z-image-turbo-q8', label: 'z-image-turbo-q8', info: null, missing: false });
  });
});

describe('seed, placeholders and status', () => {
  it('rolls a seed in 1..MAX_SEED', () => {
    expect(rollSeed(() => 0)).toBe(1);
    expect(rollSeed(() => 0.999_999_999)).toBeLessThanOrEqual(MAX_SEED);
  });

  it('shows the seed a run used when the seed is unlocked, and keeps a locked one', () => {
    expect(afterRun(form({ seed: '' }), 42).seed).toBe('42');
    expect(afterRun(form({ seed: '7', seedLocked: true }), 42).seed).toBe('7');
  });

  it("shows the model's own defaults as placeholders", () => {
    expect(placeholders(Z)).toEqual({ steps: '9', width: '1024', height: '1024' });
    expect(placeholders(null)).toEqual({ steps: 'default', width: 'default', height: 'default' });
  });

  it('says "Loading model…" exactly while percent is null (spec decision 7)', () => {
    expect(runStatus(null)).toBe('Loading model…');
    expect(runStatus(33.4)).toBe('Generating 33%');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen/src/form.test.ts`
Expected: FAIL, because `./form.js` cannot be resolved.

- [ ] **Step 3: Create `plugins/image-gen/src/form.ts`**

```ts
import type { GenerateRequest, ImageModel } from './client.js';
import { shortModel } from './history.js';

/** The manifest's default for the `model` setting, copied verbatim. */
export const DEFAULT_GENERATE_MODEL = 'mflux-community/z-image-turbo-mflux-q8';

export const MAX_SEED = 2 ** 31 - 1;

/**
 * The Generate form as the panel holds it. Numbers stay text as typed, so a
 * half-typed value is not lost; they become numbers only in the request.
 */
export type GenerateForm = {
  prompt: string;
  negative: string;
  model: string;
  steps: string;
  width: string;
  height: string;
  seed: string;
  /** Locked: every run sends `seed`. Unlocked: every run is random. */
  seedLocked: boolean;
};

export function emptyForm(model: string): GenerateForm {
  return { prompt: '', negative: '', model, steps: '', width: '', height: '', seed: '', seedLocked: false };
}

/** A model given as a folder, rather than a repo id modelctl finds (spec decision 5). */
export function isPath(model: string): boolean {
  return model.startsWith('/') || model.startsWith('~');
}

export type ModelOption = {
  value: string;
  label: string;
  /** How to run it; null for a folder path, or a repo that is not downloaded. */
  info: ImageModel | null;
  /** A repo id the catalog does not have: the daemon would answer 404. */
  missing: boolean;
};

/**
 * The model select: every downloaded model for `role`, plus the configured one
 * when the catalog does not list it. A folder path is never marked missing,
 * because the catalog cannot know about it (spec decision 5).
 */
export function modelOptions(catalog: readonly ImageModel[], configured: string, role: ImageModel['role']): ModelOption[] {
  const rows = catalog.filter((m) => m.role === role);
  const options: ModelOption[] = rows.map((m) => ({ value: m.repo, label: shortModel(m.repo), info: m, missing: false }));
  if (configured !== '' && !rows.some((m) => m.repo === configured)) {
    const missing = !isPath(configured);
    options.unshift({
      value: configured,
      label: missing ? `${shortModel(configured)} — not downloaded` : shortModel(configured),
      info: null,
      missing,
    });
  }
  return options;
}

type Parsed = { ok: true; value: number | undefined } | { ok: false; error: string };

function wholeNumber(name: string, text: string): Parsed {
  const t = text.trim();
  if (t === '') return { ok: true, value: undefined };
  if (!/^\d+$/.test(t)) return { ok: false, error: `${name} must be a whole number` };
  return { ok: true, value: Number(t) };
}

export type FormResult = { ok: true; req: GenerateRequest } | { ok: false; error: string };

/**
 * The form as a POST body. Ranges are the daemon's to check, and its 400 names
 * the limit, so this refuses only what cannot be sent at all. An unlocked seed
 * is left out, which the daemon reads as random.
 */
export function toGenerateRequest(form: GenerateForm, opts: { negative: boolean; outDir: string }): FormResult {
  const prompt = form.prompt.trim();
  if (prompt === '') return { ok: false, error: 'Write a prompt first.' };
  const steps = wholeNumber('Steps', form.steps);
  if (!steps.ok) return steps;
  const width = wholeNumber('Width', form.width);
  if (!width.ok) return width;
  const height = wholeNumber('Height', form.height);
  if (!height.ok) return height;
  const seed: Parsed = form.seedLocked ? wholeNumber('Seed', form.seed) : { ok: true, value: undefined };
  if (!seed.ok) return seed;
  const negative = opts.negative ? form.negative.trim() : '';
  const outDir = opts.outDir.trim();
  return {
    ok: true,
    req: {
      prompt,
      model: form.model,
      ...(negative === '' ? {} : { negative }),
      ...(steps.value === undefined ? {} : { steps: steps.value }),
      ...(width.value === undefined ? {} : { width: width.value }),
      ...(height.value === undefined ? {} : { height: height.value }),
      ...(seed.value === undefined ? {} : { seed: seed.value }),
      ...(outDir === '' ? {} : { out_dir: outDir }),
    },
  };
}

/**
 * imagegen.generate's positional args, in schema order: prompt, model, steps,
 * seed (C5). 0 and '' mean "not set", as the manifest declares.
 */
export function commandRequest(args: readonly unknown[], settings: { model: string; outDir: string }): FormResult {
  const [prompt, model, steps, seed] = args;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'imagegen.generate needs a prompt.' };
  }
  const positive = (v: unknown): number | undefined =>
    (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
  const stepsV = positive(steps);
  const seedV = positive(seed);
  const outDir = settings.outDir.trim();
  return {
    ok: true,
    req: {
      prompt: prompt.trim(),
      model: typeof model === 'string' && model.trim() !== '' ? model.trim() : settings.model,
      ...(stepsV === undefined ? {} : { steps: stepsV }),
      ...(seedV === undefined ? {} : { seed: seedV }),
      ...(outDir === '' ? {} : { out_dir: outDir }),
    },
  };
}

/** A random seed the daemon accepts: 1..MAX_SEED. */
export function rollSeed(random: () => number = Math.random): number {
  return 1 + Math.floor(random() * MAX_SEED);
}

/** After a run: an unlocked seed field shows the seed used, so it can be locked to reproduce the image. */
export function afterRun(form: GenerateForm, usedSeed: number): GenerateForm {
  return form.seedLocked ? form : { ...form, seed: String(usedSeed) };
}

/** The model's own defaults, shown as placeholders so an empty field is not a mystery (criterion 1). */
export function placeholders(info: ImageModel | null): { steps: string; width: string; height: string } {
  const show = (v: number | null | undefined): string => (v === null || v === undefined ? 'default' : String(v));
  return { steps: show(info?.defaults.steps), width: show(info?.defaults.width), height: show(info?.defaults.height) };
}

/** `percent` is null exactly while the model loads (spec decision 7). */
export function runStatus(percent: number | null): string {
  return percent === null ? 'Loading model…' : `Generating ${Math.round(percent)}%`;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen && npm run typecheck && npm test`
Expected: `form.test.ts` 15 pass; `tsc -b` is clean; the full suite passes.

- [ ] **Step 5: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add plugins/image-gen/src/form.ts plugins/image-gen/src/form.test.ts
git commit -m "image-gen: the form — request, command args, models, seed, status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Re-attach — what a mounted panel adopts from the daemon

**Files:**
- Create: `plugins/image-gen/src/reattach.ts`
- Test: `plugins/image-gen/src/reattach.test.ts`

**Interfaces:**
- Consumes: `ImageJob` (Task 1)
- Produces: `planReattach(jobs: readonly ImageJob[], known: ReadonlySet<string>): { running: ImageJob | null; unrecorded: string[] }`

- [ ] **Step 1: Write the failing tests**

Create `plugins/image-gen/src/reattach.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ImageJob, JobState } from './client.js';
import { planReattach } from './reattach.js';

const job = (id: string, state: JobState, kind = 'image'): ImageJob => ({
  id, kind, repo: 'mflux-community/z-image-turbo-mflux-q8', state,
  started: 0, finished: null, elapsed: 0, exit_code: null, percent: null, error: null, params: {},
});

describe('planReattach — what a freshly mounted panel adopts (C4, spec decision 17)', () => {
  it('attaches to the running image job', () => {
    expect(planReattach([job('b', 'done'), job('a', 'running')], new Set(['b'])))
      .toEqual({ running: job('a', 'running'), unrecorded: [] });
  });

  it('records image jobs that finished while no panel was watching, and only those', () => {
    const jobs = [job('d', 'done'), job('c', 'done'), job('f', 'failed'), job('x', 'cancelled')];
    expect(planReattach(jobs, new Set(['c']))).toEqual({ running: null, unrecorded: ['d'] });
  });

  it('ignores other kinds of job on the same daemon', () => {
    expect(planReattach([job('p', 'running', 'pull'), job('t', 'done', 'asr')], new Set()))
      .toEqual({ running: null, unrecorded: [] });
  });

  it('has nothing to do on an empty daemon', () => {
    expect(planReattach([], new Set())).toEqual({ running: null, unrecorded: [] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen/src/reattach.test.ts`
Expected: FAIL, because `./reattach.js` cannot be resolved.

- [ ] **Step 3: Create `plugins/image-gen/src/reattach.ts`**

```ts
import type { ImageJob } from './client.js';

/**
 * What a freshly mounted panel picks up from the daemon's job list: never from
 * a remembered id, because only the daemon knows (C4, spec decision 17).
 *
 * `running` is the image job in flight, if any. There is at most one: image
 * jobs run one at a time.
 *
 * `unrecorded` is the image jobs that finished while no panel was watching and
 * are not in the history yet. The list view carries no result, so the panel
 * fetches each by id. Failures and cancellations are not recorded, because the
 * strip is for images.
 */
export function planReattach(
  jobs: readonly ImageJob[],
  known: ReadonlySet<string>,
): { running: ImageJob | null; unrecorded: string[] } {
  const image = jobs.filter((j) => j.kind === 'image');
  return {
    running: image.find((j) => j.state === 'running') ?? null,
    unrecorded: image.filter((j) => j.state === 'done' && !known.has(j.id)).map((j) => j.id),
  };
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen && npm run typecheck && npm test`
Expected: `reattach.test.ts` 4 pass; `tsc -b` is clean; the full suite passes.

- [ ] **Step 5: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add plugins/image-gen/src/reattach.ts plugins/image-gen/src/reattach.test.ts
git commit -m "image-gen: re-attach — adopt the running job and record unseen results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The panel and the commands

**Files:**
- Create: `plugins/image-gen/src/index.tsx`
- Test: `plugins/image-gen/src/plugin.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4
- Produces:
  - `plugin: Plugin`, which registers the panel `imagegen.main` and the commands `imagegen.open` and `imagegen.generate`
  - `jobStarted`, a nudge with `subscribe(fn) => unsubscribe`, `notify()`, `clear()` and `size`

**The nudge, and how it relates to spec decision 18.** The command posts its own job and opens the panel, and a panel mounting later finds the job through `GET /v1/jobs`. A panel that is **already** mounted does not remount, though; `openPanel` on the active panel is a no-op. So the command calls `jobStarted.notify()`, and a mounted panel re-scans the daemon. The nudge carries no data and queues nothing, so the daemon stays the only record. `deactivate` clears it.

- [ ] **Step 1: Write the failing disposal and command tests**

Create `plugins/image-gen/src/plugin.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetRequestInit, NetResponse, PluginManifest } from '@workbench/plugin-sdk';
import { createPluginHost, type PluginHost, type WorkbenchHostBridge } from '@workbench/plugin-host';
import { jobStarted, plugin } from './index.js';

/**
 * The disposal test ("the highest-value test" since M0): the real plugin,
 * activated and torn down by the real host. The host's own tests prove it
 * unwinds whatever it is given; this proves Images gives it everything.
 */

const ID = 'image-gen';

const manifest: PluginManifest = {
  id: ID,
  name: 'Images',
  version: '1.0.0',
  apiVersion: '1.0',
  main: './dist/index.js',
  activationEvents: ['onCommand:imagegen.open', 'onCommand:imagegen.generate'],
  contributes: {
    panels: [{ id: 'imagegen.main', title: 'Images' }],
    commands: [
      { id: 'imagegen.open', title: 'Open Images' },
      { id: 'imagegen.generate', title: 'Generate an Image' },
    ],
  },
};

const RUNNING = JSON.stringify({ id: 'job1', kind: 'image', state: 'running' });
const netFetch = vi.fn(
  async (_pluginId: string, _url: string, _init?: NetRequestInit): Promise<NetResponse> =>
    ({ status: 200, ok: true, headers: {}, body: RUNNING }),
);
const notify = vi.fn(async (_message: string, _level?: string) => undefined);

const bridge: WorkbenchHostBridge = {
  listPlugins: async () => [],
  notify,
  pickFile: async () => undefined,
  pickDirectory: async () => undefined,
  pickDirectoryForWrite: async () => undefined,
  copyFile: async () => ({ name: '', renamed: false }),
  readDir: async () => [],
  readFile: async () => new Uint8Array(),
  netFetch,
  session: async () => ({}),
  setSessionPanel: async () => undefined,
  keyOverrides: async () => ({}),
  setKeyOverride: async () => undefined,
  onKeysChanged: () => () => undefined,
  disabledPlugins: async () => [],
  setPluginEnabled: async () => undefined,
  onPluginEnabledChanged: () => () => undefined,
  settingsGet: async () => undefined,
  settingsAll: async () => ({}),
  settingsSchemas: async () => ({}),
  settingsSet: async () => undefined,
  onSettingChanged: () => () => undefined,
  storageGet: async () => undefined,
  storageSet: async () => undefined,
  onCommand: () => () => undefined,
  onPluginChanged: () => () => undefined,
};

function host(): PluginHost {
  const h = createPluginHost({ bridge, importModule: async () => ({ plugin }) });
  h.load([manifest]);
  return h;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  netFetch.mockClear();
  notify.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  jobStarted.clear();
});

describe('image-gen disposal', () => {
  it('registers its panel and both commands through the context, and unwinds all of them', async () => {
    const h = host();
    await h.invokeCommand('imagegen.open');

    expect(h.get(ID)?.state).toBe('active');
    expect(h.getPanel('imagegen.main')).toBeDefined();
    // panel + imagegen.open + imagegen.generate. Anything more is a listener
    // registered around the host, which is exactly what would leak.
    expect(h.get(ID)?.disposables).toHaveLength(3);

    await h.deactivate(ID);

    expect(h.get(ID)?.state).toBe('disposed');
    expect(h.getPanel('imagegen.main')).toBeUndefined();
    expect(h.get(ID)?.disposables).toEqual([]);
  });

  it('forgets every panel subscription on deactivate', async () => {
    const h = host();
    await h.invokeCommand('imagegen.open');
    jobStarted.subscribe(() => undefined);
    await h.deactivate(ID);
    expect(jobStarted.size).toBe(0);
  });

  it('touches the network only when a command asks, never from activation', async () => {
    const h = host();
    await h.invokeCommand('imagegen.open');
    await h.deactivate(ID);
    expect(netFetch).not.toHaveBeenCalled();
  });
});

describe('imagegen.generate', () => {
  it('posts the job itself with the configured defaults, then opens the panel and nudges it', async () => {
    const h = host();
    const nudged = vi.fn();
    jobStarted.subscribe(nudged);

    await h.invokeCommand('imagegen.generate', 'a green gate', '', 0, 7);

    expect(netFetch).toHaveBeenCalledTimes(1);
    const [, url, init] = netFetch.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8077/v1/generate/image');
    expect(JSON.parse(init?.body ?? '')).toEqual({
      prompt: 'a green gate', model: 'mflux-community/z-image-turbo-mflux-q8', seed: 7,
    });
    expect(h.getActivePanelId()).toBe('imagegen.main');
    expect(nudged).toHaveBeenCalledTimes(1);
  });

  it('says what is missing instead of posting when there is no prompt', async () => {
    const h = host();
    await h.invokeCommand('imagegen.generate', '   ');
    expect(netFetch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('imagegen.generate needs a prompt.', 'warn');
  });

  it("shows the daemon's refusal and leaves the panel closed", async () => {
    netFetch.mockResolvedValueOnce({
      status: 409, ok: false, headers: {},
      body: JSON.stringify({ error: 'another image job is running (m/x)', hint: 'poll /v1/jobs/abc' }),
    });
    const h = host();
    await h.invokeCommand('imagegen.generate', 'a gate');
    expect(notify).toHaveBeenCalledWith('another image job is running (m/x) — poll /v1/jobs/abc', 'error');
    expect(h.getActivePanelId()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen/src/plugin.test.ts`
Expected: FAIL, because `./index.js` cannot be resolved.

- [ ] **Step 3: Create `plugins/image-gen/src/index.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelContext, Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';
import {
  asDaemonError, DaemonError, DEFAULT_DAEMON_URL, ImageClient, START_COMMAND,
  type ImageJob, type ImageModel,
} from './client.js';
import {
  addHistory, DEFAULT_HISTORY_LIMIT, describeEntry, fromJob, historyLimit, parseHistory, shortModel,
  type HistoryEntry,
} from './history.js';
import {
  afterRun, commandRequest, DEFAULT_GENERATE_MODEL, emptyForm, modelOptions, placeholders,
  rollSeed, runStatus, toGenerateRequest, type GenerateForm,
} from './form.js';
import { startPoller } from './poller.js';
import { planReattach } from './reattach.js';

const PANEL_ID = 'imagegen.main';

/**
 * A job was started outside the panel, by the imagegen.generate command. The
 * daemon stays the only record of it. This only tells an already-mounted panel
 * to look again, because `openPanel` on the active panel does not remount it.
 * A panel mounted later finds the job itself (spec decision 17), so nothing is
 * queued.
 */
function nudge() {
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    notify(): void { for (const fn of [...listeners]) fn(); },
    /** On deactivate: a panel from this activation must not hear the next one. */
    clear(): void { listeners.clear(); },
    get size(): number { return listeners.size; },
  };
}

export const jobStarted = nudge();

type Problem = { message: string; hint?: string | undefined };

function ImagesPanel({ ctx }: { ctx: PanelContext }) {
  const [daemonUrl, setDaemonUrl] = useState(DEFAULT_DAEMON_URL);
  const [token, setToken] = useState('');
  const [configuredModel, setConfiguredModel] = useState(DEFAULT_GENERATE_MODEL);
  const [outDir, setOutDir] = useState('');
  const [limit, setLimit] = useState(DEFAULT_HISTORY_LIMIT);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // TRAP 1 (change log 6, 13): storage and settings are async. Nothing is saved,
  // and the daemon is not contacted, until both have been read.
  const [loaded, setLoaded] = useState(false);

  const [offline, setOffline] = useState<DaemonError | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [catalog, setCatalog] = useState<ImageModel[]>([]);
  const [form, setForm] = useState<GenerateForm>(() => emptyForm(DEFAULT_GENERATE_MODEL));
  const [running, setRunning] = useState<ImageJob | null>(null);
  // null shows the newest entry.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Read inside callbacks that must not be rebuilt every time these change.
  const historyRef = useRef(history);
  historyRef.current = history;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const client = useMemo(() => new ImageClient(ctx.plugin, daemonUrl, token), [ctx, daemonUrl, token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [u, t, m, o, l, h] = await Promise.all([
        ctx.plugin.settings.get('daemonUrl'),
        ctx.plugin.settings.get('token'),
        ctx.plugin.settings.get('model'),
        ctx.plugin.settings.get('outputDir'),
        ctx.plugin.settings.get('historyLimit'),
        ctx.plugin.storage.get('history'),
      ]);
      if (cancelled) return;
      if (typeof u === 'string' && u !== '') setDaemonUrl(u);
      if (typeof t === 'string') setToken(t);
      const model = typeof m === 'string' && m.trim() !== '' ? m.trim() : DEFAULT_GENERATE_MODEL;
      setConfiguredModel(model);
      setForm((f) => ({ ...f, model }));
      if (typeof o === 'string') setOutDir(o);
      const lim = historyLimit(l);
      setLimit(lim);
      setHistory(parseHistory(h, lim));
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [ctx]);

  // TRAP 2 (change log 15): onChange returns a Disposable, not a cleanup function.
  useEffect(() => {
    const sub = ctx.plugin.settings.onChange((key, value) => {
      if (key === 'daemonUrl' && typeof value === 'string' && value !== '') setDaemonUrl(value);
      if (key === 'token' && typeof value === 'string') setToken(value);
      if (key === 'model' && typeof value === 'string' && value.trim() !== '') {
        const model = value.trim();
        setConfiguredModel(model);
        setForm((f) => ({ ...f, model }));
      }
      if (key === 'outputDir' && typeof value === 'string') setOutDir(value);
      if (key === 'historyLimit') {
        const lim = historyLimit(value);
        setLimit(lim);
        setHistory((list) => list.slice(0, lim));
      }
    });
    return () => { void sub.dispose(); };
  }, [ctx]);

  useEffect(() => {
    if (!loaded) return;
    void ctx.plugin.storage.set('history', history);
  }, [ctx, loaded, history]);

  const fail = useCallback((err: unknown) => {
    const e = asDaemonError(err);
    if (e.kind === 'offline') setOffline(e);
    else setProblem(e);
  }, []);

  /** Adds a finished job to the strip. `fresh`: it is the run this panel was watching. */
  const record = useCallback((job: ImageJob, fresh: boolean) => {
    const entry = fromJob(job);
    if (entry === null) return;
    setHistory((list) => addHistory(list, entry, limitRef.current));
    if (fresh) {
      setSelectedId(entry.id);
      setForm((f) => afterRun(f, entry.seed));
    }
  }, []);

  // C4 and spec decision 17: ask the daemon, the only thing that knows, what is
  // running and what finished while no panel was watching.
  const scan = useCallback(async () => {
    const { jobs } = await client.jobs();
    const plan = planReattach(jobs, new Set(historyRef.current.map((e) => e.id)));
    if (plan.running !== null) setRunning(plan.running);
    for (const id of plan.unrecorded) record(await client.job(id), false);
  }, [client, record]);

  const connect = useCallback(async () => {
    setOffline(null);
    try {
      await client.health();
      setCatalog(await client.models());
      await scan();
    } catch (err: unknown) {
      fail(err);
    }
  }, [client, scan, fail]);

  useEffect(() => { if (loaded) void connect(); }, [loaded, connect]);

  // A job the imagegen.generate command started while this panel was open.
  useEffect(() => jobStarted.subscribe(() => { void scan().catch(fail); }), [scan, fail]);

  // ─── polling ───────────────────────────────────────────────

  const runningId = running?.id ?? null;
  useEffect(() => {
    if (runningId === null) return undefined;
    const poller = startPoller<ImageJob>({
      fetch: () => client.job(runningId),
      onValue: (job) => {
        if (job.state === 'running') {
          setRunning(job);
          return;
        }
        setRunning(null);
        if (job.state === 'done') record(job, true);
        else if (job.state === 'failed') setProblem({ message: job.error ?? 'The generation failed.' });
      },
      onError: (err) => {
        const e = asDaemonError(err);
        // A 404 means the daemon restarted and forgot the job. Anything else
        // (offline included) may be a restart in progress: keep polling.
        if (e.kind !== 'api') return;
        setRunning(null);
        setProblem({ message: `${e.message} — the daemon forgets jobs when it restarts.` });
      },
      next: (job) => (job.state === 'running' ? 1_000 : undefined),
    });
    return () => poller.stop();
  }, [client, runningId, record]);

  // ─── actions ───────────────────────────────────────────────

  const options = useMemo(() => modelOptions(catalog, configuredModel, 'generate'), [catalog, configuredModel]);
  const option = options.find((o) => o.value === form.model) ?? null;
  const info = option?.info ?? null;
  const hints = placeholders(info);
  const selected = history.find((e) => e.id === selectedId) ?? history[0] ?? null;

  const run = useCallback(async () => {
    setProblem(null);
    const built = toGenerateRequest(form, { negative: info?.negative ?? false, outDir });
    if (!built.ok) {
      setProblem({ message: built.error });
      return;
    }
    try {
      setRunning(await client.generate(built.req));
    } catch (err: unknown) {
      fail(err);
    }
  }, [client, form, info, outDir, fail]);

  const cancel = useCallback(async () => {
    if (running === null) return;
    try {
      await client.cancel(running.id);
    } catch (err: unknown) {
      fail(err);   // most likely 409: it finished while the click was in flight
    }
  }, [client, running, fail]);

  const edit = (patch: Partial<GenerateForm>): void => setForm((f) => ({ ...f, ...patch }));

  // ─── render ────────────────────────────────────────────────

  if (!loaded) {
    return <div style={S.root}><div style={S.connecting}>Loading…</div></div>;
  }
  if (offline !== null) {
    return <div style={S.root}><Offline error={offline} url={daemonUrl} onRetry={() => void connect()} /></div>;
  }

  const busy = running !== null;
  const missing = option?.missing ?? false;
  const canRun = !busy && !missing && form.prompt.trim() !== '';

  return (
    <div style={S.root}>
      {problem !== null && <ErrorBar problem={problem} onDismiss={() => setProblem(null)} />}
      <div style={S.body}>
        <div style={S.column}>
          <textarea
            style={S.prompt}
            rows={3}
            placeholder="What to draw — ⌘↩ to generate"
            value={form.prompt}
            onChange={(e) => edit({ prompt: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey && canRun) void run(); }}
          />
          {info?.negative === true && (
            <textarea
              style={S.negative}
              rows={2}
              placeholder="Negative prompt (optional)"
              value={form.negative}
              onChange={(e) => edit({ negative: e.target.value })}
            />
          )}
          <div style={S.row}>
            <label style={S.field}>
              <span style={S.label}>Model</span>
              <select style={S.select} value={form.model} onChange={(e) => edit({ model: e.target.value })}>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <NumberField label="Steps" value={form.steps} placeholder={hints.steps} onChange={(v) => edit({ steps: v })} />
            <NumberField label="Width" value={form.width} placeholder={hints.width} onChange={(v) => edit({ width: v })} />
            <NumberField label="Height" value={form.height} placeholder={hints.height} onChange={(v) => edit({ height: v })} />
            <label style={S.field}>
              <span style={S.label}>Seed</span>
              <span style={S.seed}>
                <input
                  style={{ ...S.input, width: 110 }}
                  inputMode="numeric"
                  placeholder="random"
                  value={form.seed}
                  onChange={(e) => edit({ seed: e.target.value })}
                />
                <button
                  type="button"
                  style={S.iconButton}
                  title="Roll a new seed and lock it"
                  onClick={() => edit({ seed: String(rollSeed()), seedLocked: true })}
                >
                  🎲
                </button>
                <button
                  type="button"
                  style={form.seedLocked ? { ...S.iconButton, ...S.on } : S.iconButton}
                  title={form.seedLocked ? 'Seed locked: every run reuses it' : 'Seed unlocked: every run picks a new one'}
                  onClick={() => edit({ seedLocked: !form.seedLocked })}
                >
                  {form.seedLocked ? '🔒' : '🔓'}
                </button>
              </span>
            </label>
          </div>
          {missing && (
            <p style={S.warn}>
              {shortModel(form.model)} isn't downloaded. Pull it with modelctl:{' '}
              <code style={S.inlineCode}>modelctl pull {form.model}</code>
            </p>
          )}
          <div style={S.actions}>
            {busy
              ? <button type="button" style={S.button} onClick={() => void cancel()}>Cancel</button>
              : (
                <button
                  type="button"
                  style={canRun ? S.primary : { ...S.primary, ...S.disabled }}
                  disabled={!canRun}
                  onClick={() => void run()}
                >
                  Generate
                </button>
              )}
            {running !== null && <span style={S.status}>{runStatus(running.percent)}</span>}
          </div>
          <Result entry={selected} />
        </div>
      </div>
      <Strip entries={history} running={running} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
    </div>
  );
}

// ─── sub-views ───────────────────────────────────────────────

function NumberField({ label, value, placeholder, onChange }: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={S.field}>
      <span style={S.label}>{label}</span>
      <input
        style={{ ...S.input, width: 72 }}
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** The selected image, and always the path it was written to (criterion 5). */
function Result({ entry }: { entry: HistoryEntry | null }) {
  if (entry === null) {
    return <p style={S.muted}>Nothing generated yet. Write a prompt and press Generate.</p>;
  }
  return (
    <figure style={S.result}>
      <img
        style={S.preview}
        src={`data:image/jpeg;base64,${entry.thumb_b64}`}
        alt={entry.prompt ?? entry.instruction ?? entry.path}
      />
      <figcaption style={S.caption}>
        <div style={S.path} title={entry.path}>{entry.path}</div>
        <div style={S.mutedSmall}>{describeEntry(entry)}</div>
        {entry.prompt !== null && <div style={S.mutedSmall}>{entry.prompt}</div>}
      </figcaption>
    </figure>
  );
}

/** Persistent, newest first, with a placeholder tile while a job runs (PRD §4). */
function Strip({ entries, running, selectedId, onSelect }: {
  entries: HistoryEntry[];
  running: ImageJob | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (entries.length === 0 && running === null) return null;
  return (
    <div style={S.strip}>
      {running !== null && <div style={{ ...S.tile, ...S.pending }}>{runStatus(running.percent)}</div>}
      {entries.map((e) => (
        <button
          key={e.id}
          type="button"
          title={e.prompt ?? e.path}
          style={e.id === selectedId ? { ...S.tile, ...S.selected } : S.tile}
          onClick={() => onSelect(e.id)}
        >
          <img style={S.thumb} src={`data:image/jpeg;base64,${e.thumb_b64}`} alt="" />
          <span style={S.tileLabel}>{shortModel(e.model)}</span>
          <span style={S.tileLabel}>{e.seed}</span>
        </button>
      ))}
    </div>
  );
}

function Offline({ error, url, onRetry }: { error: DaemonError; url: string; onRetry: () => void }) {
  return (
    <div style={S.centered}>
      <h2 style={S.h2}>{error.message}</h2>
      <p style={S.muted}>Image generation runs in modelctld. Start it with:</p>
      <pre style={S.code}>{START_COMMAND}</pre>
      <p style={S.mutedSmall}>Expecting it at {url}.</p>
      <button type="button" style={S.button} onClick={onRetry}>Retry</button>
    </div>
  );
}

function ErrorBar({ problem, onDismiss }: { problem: Problem; onDismiss: () => void }) {
  return (
    <div style={S.errorBar}>
      <div>
        <strong>{problem.message}</strong>
        {problem.hint !== undefined && <div style={S.mutedSmall}>{problem.hint}</div>}
      </div>
      <button type="button" style={S.linkButton} onClick={onDismiss}>dismiss</button>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    font: '13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    background: 'var(--workspace-bg, #fff)',
    color: 'var(--chrome-fg, inherit)',
  },
  body: { flex: 1, overflow: 'auto', minHeight: 0 },
  column: { maxWidth: 820, margin: '0 auto', padding: '20px 20px 32px' },
  connecting: { padding: 24, color: 'var(--chrome-muted, #71717a)' },
  centered: { maxWidth: 520, margin: '12vh auto 0', padding: 24, textAlign: 'center' },
  h2: { fontSize: 15, fontWeight: 600, margin: '0 0 8px' },
  muted: { color: 'var(--chrome-muted, #71717a)', margin: '16px 0' },
  mutedSmall: { color: 'var(--chrome-muted, #71717a)', fontSize: 12, margin: 0 },
  warn: { color: 'var(--warn-fg, #d97706)', fontSize: 12, margin: '8px 0 0' },
  code: {
    textAlign: 'left',
    font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '10px 12px',
    borderRadius: 6,
    background: 'var(--chrome-bg, #f4f4f5)',
    border: '1px solid var(--chrome-border, #d4d4d8)',
    overflowX: 'auto',
    whiteSpace: 'pre',
  },
  inlineCode: { font: '12px ui-monospace, SFMono-Regular, Menlo, monospace' },
  button: {
    font: 'inherit',
    padding: '4px 12px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    cursor: 'pointer',
  },
  primary: {
    font: 'inherit',
    fontWeight: 500,
    padding: '5px 16px',
    borderRadius: 5,
    border: '1px solid #1d4ed8',
    background: '#2563eb',
    color: '#fff',
    cursor: 'pointer',
  },
  /** Inline styles have no :disabled; a disabled primary has to say so itself. */
  disabled: { opacity: 0.4, cursor: 'not-allowed' },
  linkButton: {
    font: 'inherit',
    fontSize: 12,
    padding: '2px 6px',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    opacity: 0.75,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  errorBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    padding: '8px 12px',
    background: 'var(--error-bg, #fef2f2)',
    color: 'var(--error-fg, #b91c1c)',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
  },
  prompt: {
    width: '100%',
    boxSizing: 'border-box',
    font: 'inherit',
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    resize: 'vertical',
  },
  negative: {
    width: '100%',
    boxSizing: 'border-box',
    font: 'inherit',
    fontSize: 12,
    marginTop: 8,
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    resize: 'vertical',
  },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12, marginTop: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  label: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--chrome-muted, #71717a)' },
  select: {
    font: 'inherit',
    padding: '4px 6px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    minWidth: 0,
    maxWidth: 280,
  },
  input: {
    font: 'inherit',
    padding: '4px 6px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
  },
  seed: { display: 'flex', alignItems: 'center', gap: 4 },
  iconButton: {
    font: 'inherit',
    padding: '3px 6px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    cursor: 'pointer',
  },
  on: { background: 'var(--chrome-bg, #f4f4f5)', borderColor: '#2563eb' },
  actions: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 },
  status: { color: 'var(--chrome-muted, #71717a)' },
  result: { margin: '20px 0 0', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 },
  preview: { maxWidth: '100%', width: 512, borderRadius: 6, border: '1px solid var(--chrome-border, #d4d4d8)' },
  caption: { display: 'flex', flexDirection: 'column', gap: 2, maxWidth: '100%' },
  path: {
    font: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
    userSelect: 'text',
    wordBreak: 'break-all',
  },
  strip: {
    display: 'flex',
    gap: 8,
    padding: '8px 12px',
    overflowX: 'auto',
    borderTop: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--chrome-bg, #f4f4f5)',
    flexShrink: 0,
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    width: 88,
    flexShrink: 0,
    padding: 4,
    borderRadius: 6,
    border: '2px solid transparent',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
  },
  pending: {
    justifyContent: 'center',
    height: 112,
    boxSizing: 'border-box',
    fontSize: 11,
    textAlign: 'center',
    color: 'var(--chrome-muted, #71717a)',
    border: '2px dashed var(--chrome-border, #d4d4d8)',
    cursor: 'default',
  },
  selected: { borderColor: '#2563eb' },
  thumb: { width: 76, height: 76, objectFit: 'cover', borderRadius: 4 },
  tileLabel: {
    fontSize: 10,
    maxWidth: 80,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--chrome-muted, #71717a)',
  },
};

// ─── plugin ──────────────────────────────────────────────────

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('image-gen activating');
    ctx.registerPanel(PANEL_ID, definePanel(ImagesPanel));
    ctx.registerCommand('imagegen.open', () => ctx.workspace.openPanel(PANEL_ID));

    // Positional args in schema order: prompt, model, steps, seed (C5). The
    // command posts the job itself (spec decision 18), so it works with no
    // panel at all, which the S2 MCP server will rely on.
    ctx.registerCommand('imagegen.generate', async (...args: unknown[]) => {
      const [url, token, model, outDir] = await Promise.all([
        ctx.settings.get('daemonUrl'),
        ctx.settings.get('token'),
        ctx.settings.get('model'),
        ctx.settings.get('outputDir'),
      ]);
      const built = commandRequest(args, {
        model: typeof model === 'string' && model.trim() !== '' ? model.trim() : DEFAULT_GENERATE_MODEL,
        outDir: typeof outDir === 'string' ? outDir : '',
      });
      if (!built.ok) {
        await ctx.ui.notify(built.error, 'warn');
        return;
      }
      const client = new ImageClient(
        ctx,
        typeof url === 'string' && url !== '' ? url : DEFAULT_DAEMON_URL,
        typeof token === 'string' ? token : '',
      );
      try {
        await client.generate(built.req);
      } catch (err: unknown) {
        const e = asDaemonError(err);
        await ctx.ui.notify(e.hint === undefined ? e.message : `${e.message} — ${e.hint}`, 'error');
        return;
      }
      await ctx.workspace.openPanel(PANEL_ID);
      jobStarted.notify();
    });
  },

  deactivate() {
    // Registrations are the host's to unwind (invariant 8). Module state is
    // ours: a panel subscription must not outlive this activation.
    jobStarted.clear();
  },
};
```

- [ ] **Step 4: Run the tests, the typecheck and the build**

Run: `cd /Users/cagdasmert/work/WS/workbench && npx vitest run plugins/image-gen && npm run typecheck && npm test && npm run build:plugins`
Expected:
- `plugin.test.ts` 6 pass, and every image-gen file passes (43 tests in the plugin);
- `tsc -b` is clean;
- the full suite passes (216 tests);
- the build prints `[plugins] built image-gen -> plugins/image-gen/dist/index.js`.

- [ ] **Step 5: Commit**

```bash
cd /Users/cagdasmert/work/WS/workbench
git add plugins/image-gen/src/index.tsx plugins/image-gen/src/plugin.test.ts
git commit -m "image-gen: the panel — generate, loading status, result with its path, history strip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The gate — generate from the app

**Runs after M1's gate** (plan `2026-09-25-image-gen-m1-wire.md`, Task 9). It needs Z-Image q8 pulled by the user and a daemon started from this branch. The steps in the app are the **user's**: an agent prepares the build and the checklist, and records what the user reports.

**Files:**
- Modify: `docs/m1-shell-change-log.md` (entry 43)

- [ ] **Step 1: Build, and check that the model is there**

```bash
cd /Users/cagdasmert/work/WS/workbench && npm run typecheck && npm test && npm run build:plugins
modelctl ls | grep z-image-turbo-mflux-q8
```

Expected: everything passes, and the model is listed at about 11.0 GB. If it isn't there, STOP and report NEEDS_CONTEXT with `modelctl pull mflux-community/z-image-turbo-mflux-q8 --to internal`.

- [ ] **Step 2: Hand the user this checklist, and wait for their answers**

Setup: run `modelctl serve` (restart it if it was started from another branch), then `npm run dev` in `~/work/WS/workbench`.

1. **Open.** `cmd+shift+g` opens **Images**. The model select shows `z-image-turbo-mflux-q8`, and the Steps placeholder says `9` (criterion 1).
2. **Generate.** Type a prompt and press Generate. The status reads `Loading model…`, then `Generating N%`. The image appears with **its file path under it**, and a tile joins the strip (criterion 5).
3. **Close mid-run.** Start another generation, and switch to a different panel while it says `Loading model…`. Come back to Images: the placeholder tile and the status are back, and the result lands in the strip.
4. **Restart.** Quit the app and run `npm run dev` again. The strip still shows both tiles, and clicking a tile shows that image and its path (criterion 2, first half).
5. **Seed.** Lock the seed (🔒) and generate twice with the same prompt. The two images look identical (criterion 3, by eye; M1's gate already checked it by pixel hash).
6. **Command.** From the palette, run *Generate an Image* with a prompt. The panel opens and the job runs.
7. **Offline.** Stop `modelctl serve`, then reopen the panel. It says the image daemon isn't running and shows `modelctl serve`.

Anything that fails is a bug. Fix it with a test, in its own commit, before recording.

- [ ] **Step 3: Record it**

Append entry 43 to `docs/m1-shell-change-log.md`, in the shape of entry 38:

```markdown
## 43 · Images M2: a panel over the wire, and a strip that remembers

**Plugin:** image-gen (vault PRD P4) · **Verdict:** PLUGIN ADAPTED — no shell change, no SDK change

**The daemon is the only record of a job; the panel only asks.** On mount it reads `GET /v1/jobs`: a running image job
gets its placeholder tile back, and one that finished while no panel watched joins the strip. `imagegen.generate` posts
its own job, so it works without a panel. It then nudges an already-open panel to look again, because `openPanel` on the
active panel does not remount it. The nudge carries no data and queues nothing.

**Loading is visible.** The status reads "Loading model…" while `percent` is null, which M1 made exactly the load phase,
and "Generating N%" after that.

**History is content, on purpose.** `ctx.storage.history` holds each result's 512 px JPEG preview (PRD §8), capped at
`historyLimit` (default 200). The full image is only ever a path on disk, shown under every result.

**A model setting can be a folder path.** The model select marks a repo the catalog lacks as "not downloaded" with the
pull command, but never a folder path, which the catalog cannot know about.

**Verified in the app** (<date>, by the user): <one line per checklist item, as reported>.

**Contract impact:** none.
```

Replace `<date>` and the verified line with what the user reported. Then commit:

```bash
cd /Users/cagdasmert/work/WS/workbench
git add docs/m1-shell-change-log.md
git commit -m "docs: change log 43 — images M2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: STOP at the gate**

Report to the user. The facade spike comes next, before M3.
