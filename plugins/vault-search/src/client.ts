import type { PluginContext } from '@workbench/plugin-sdk';

/**
 * The only file in this plugin that knows HTTP exists.
 *
 * Same shape as transcribe's `AsrClient` and model-manager's `CatalogClient`,
 * deliberately not shared with them: each plugin owns its wire types (PRD
 * README, "shared manifest boilerplate"). The panel talks to `VaultClient` and
 * would not notice if the transport changed.
 */

// ─── wire types (mirror modelctld.py / embed.py) ─────────────
export interface Folder {
  name: string;
  path: string;
  files: number;
  chunks: number;
  /** Unix seconds; null until the first index finishes. */
  indexed_at: number | null;
  model: string;
  chunk_size: number;
  /** Files added, removed or touched since the last index; null when the folder is unreachable. */
  changed: number | null;
}

export interface Hit {
  folder: string;
  /** Absolute. */
  path: string;
  rel_path: string;
  title: string;
  /** `Title › H2 › H3`; empty when the note is one chunk. */
  heading: string;
  chunk: string;
  score: number;
  start_line: number;
}

export interface SearchResult {
  hits: Hit[];
  model: string;
  took_ms: number;
}

export interface FolderResult {
  name: string;
  files: number;
  chunks: number;
  embedded: number;
  removed: number;
}

export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

export interface EmbedJob {
  id: string;
  kind: string;
  /** For an embed job, the model. */
  repo: string;
  state: JobState;
  started: number;
  finished: number | null;
  elapsed: number;
  percent: number | null;
  error: string | null;
  params: { folders?: string[]; full?: boolean };
  /** Only on `job(id)`. */
  log?: string[];
  /** Only on `jobs()`. */
  last_line?: string;
  /** Only on `job(id)`, once done. */
  result?: { folders: FolderResult[] } | null;
}

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8077';

/** The words every "can't reach it" message needs. Two lines: it is shown in a narrow box. */
export const START_COMMAND = 'cd ~/work/tools/huggingface\n.venv/bin/python modelctl.py serve';

/**
 * Why a request failed, as the one fact the panel branches on. Only `offline`
 * gets the full "start the daemon" view; everything else is an error bar,
 * because the daemon is up and said something specific.
 */
export type DaemonErrorKind = 'offline' | 'denied' | 'protocol' | 'api';

export class DaemonError extends Error {
  constructor(
    message: string,
    readonly hint: string | undefined,
    readonly kind: DaemonErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

export function asDaemonError(err: unknown): DaemonError {
  return err instanceof DaemonError ? err : new DaemonError(String(err), undefined, 'api');
}

interface ErrorBody { error?: unknown; hint?: unknown }

/** `net.fetch` speaks GET and POST only — which is why no route this plugin needs is a DELETE. */
type Method = 'GET' | 'POST';

export class VaultClient {
  constructor(
    private readonly ctx: PluginContext,
    private readonly baseUrl: string = DEFAULT_DAEMON_URL,
    private readonly token: string = '',
  ) {}

  health(): Promise<{ ok: boolean; version: string }> { return this.request('GET', '/v1/health', undefined, 5_000); }

  async folders(): Promise<Folder[]> {
    // `changed` walks every folder on disk; a large vault on a slow drive takes a moment.
    const res = await this.request<{ folders: Folder[] }>('GET', '/v1/index/folders', undefined, 30_000);
    return res.folders;
  }

  /** C2: the picker produced a path; the daemon does the reading. Starts an `embed` job. */
  addFolder(req: { path: string; name?: string; model?: string; chunk_size?: number }): Promise<EmbedJob> {
    return this.request('POST', '/v1/index/folders', req);
  }

  /**
   * Re-index one folder, or all of them with no name. Without `full` only
   * changed files are re-embedded, with the folder's own settings. `model` and
   * `chunk_size` only matter with `full`: the daemon refuses a settings change
   * without it (409).
   */
  refresh(req: { name?: string; full?: boolean; model?: string; chunk_size?: number }): Promise<EmbedJob> {
    return this.request('POST', '/v1/index/refresh', req);
  }

  /** Drops the folder from the index. The notes are never touched. POST, because net.fetch has no DELETE. */
  removeFolder(name: string): Promise<{ ok: true }> {
    return this.request('POST', `/v1/index/folders/${encodeURIComponent(name)}/remove`, {});
  }

  /** The first search after a cold start loads the model in the worker — seconds, not milliseconds. */
  search(req: { query: string; limit?: number; folders?: string[] }): Promise<SearchResult> {
    return this.request('POST', '/v1/search', req, 60_000);
  }

  job(id: string): Promise<EmbedJob> { return this.request('GET', `/v1/jobs/${encodeURIComponent(id)}`); }
  jobs(): Promise<{ jobs: EmbedJob[] }> { return this.request('GET', '/v1/jobs'); }

  cancel(id: string): Promise<{ cancelling: string }> {
    return this.request('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`, {});
  }

  private async request<T>(method: Method, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token !== '') headers['x-modelctl-token'] = this.token;

    let res;
    try {
      res = await this.ctx.net.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        timeoutMs,
      });
    } catch (err: unknown) {
      // A denied host is a manifest bug Settings cannot fix; an unreachable
      // one is just a daemon that isn't up. The difference is the diagnosis.
      const message = err instanceof Error ? err.message : String(err);
      if (/denied/i.test(message)) {
        throw new DaemonError(
          `${this.baseUrl} is not in this plugin's net:fetch permissions.`,
          'Settings can only point at 127.0.0.1:8077 or localhost:8077 — anything else '
          + 'needs a new entry in plugins/vault-search/plugin.json.',
          'denied',
        );
      }
      throw new DaemonError("The vault daemon isn't running.", START_COMMAND, 'offline');
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
        res.status,
      );
    }
    return parsed as T;
  }
}
