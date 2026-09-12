import type { PluginContext } from '@workbench/plugin-sdk';

/**
 * The load-bearing part of this plugin — not the panel.
 *
 * `modelctl` is a Python CLI over two model caches. A plugin may not spawn a
 * process (invariant 3) and the SDK is frozen, so the reach has to be something
 * the host already brokers. `net.fetch` is that thing: `modelctl serve` puts a
 * loopback HTTP daemon in front of the same catalog, and this file is the only
 * place that knows it. The panel below talks to `CatalogClient` and would not
 * notice if the transport became a Unix socket, a `ctx.proc` capability, or an
 * in-process rewrite.
 *
 * Deliberately NOT in `@workbench/plugin-sdk`: the shell has no business
 * knowing what a model is. This is a plugin that happens to own a catalog, and
 * other plugins reach it through the content bus.
 */

// ─── wire types (mirror modelctld.py) ────────────────────────
export interface LocalModel {
  repo: string;
  location: string;
  task: string | null;
  library: string | null;
  revision: string | null;
  pulled_at: number | null;
  size: number;
  size_human: string;
  path: string;
}

export interface Inventory {
  models: LocalModel[];
  total_size: number;
  /** Drives that are configured but not mounted. Listed, never fatal. */
  unavailable_roots: string[];
}

export interface RootHealth {
  name: string;
  path: string;
  mounted: boolean;
  filesystem?: string;
  symlinks?: boolean;
  free?: number;
  free_human?: string;
  models?: number;
  is_default?: boolean;
}

export interface Doctor {
  config_path: string;
  roots: RootHealth[];
  problems: string[];
  system_ram: number | null;
  system_ram_human: string | null;
}

export type Fit = 'yes' | 'tight' | 'no' | '?';

export interface SearchHit {
  repo: string;
  task: string | null;
  downloads: number;
  likes: number;
  size: number | null;
  size_human: string | null;
  fits: Fit | null;
  /** Which drive it is already on, if any. */
  local: string | null;
}

export interface SearchResult {
  results: SearchHit[];
  system_ram: number | null;
  fits_note: string | null;
}

export interface ModelInfo {
  repo: string;
  task: string | null;
  library: string | null;
  downloads: number;
  gated: boolean;
  total_size: number;
  total_size_human: string;
  effective_size: number;
  effective_size_human: string;
  fits: Fit;
  file_count: number;
  largest_files: Array<{ name: string; size: number }>;
  local: { location: string; path: string } | null;
}

export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: 'pull' | 'mv' | 'rm';
  repo: string;
  state: JobState;
  started: number;
  finished: number | null;
  elapsed: number;
  exit_code: number | null;
  percent: number | null;
  error: string | null;
  log?: string[];
  last_line?: string;
}

export interface Health {
  ok: boolean;
  version: string;
  configured: boolean;
  config_path: string;
  roots: Record<string, string>;
  default: string | null;
}

export const TASKS = [
  { id: '', label: 'Any task' },
  { id: 'image', label: 'Text → image' },
  { id: 'image2image', label: 'Image → image' },
  { id: 'video', label: 'Text → video' },
  { id: 'tts', label: 'Text → speech' },
  { id: 'stt', label: 'Speech → text' },
  { id: 'text', label: 'Text generation' },
  { id: 'embed', label: 'Embeddings' },
] as const;

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8077';

/**
 * How to start the thing, in the words the error message needs. Every failure
 * path shows this, because "could not reach 127.0.0.1:8077" is only useful to
 * someone who already knows what is meant to be there.
 */
export const START_HINT = 'Start it with:  modelctl serve';

export class CatalogError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

interface ErrorBody { error?: unknown; hint?: unknown }

export class CatalogClient {
  constructor(
    private readonly ctx: PluginContext,
    private readonly baseUrl: string = DEFAULT_DAEMON_URL,
    private readonly token: string = '',
  ) {}

  get url(): string { return this.baseUrl; }

  health(): Promise<Health> { return this.get('/v1/health'); }
  inventory(): Promise<Inventory> { return this.get('/v1/catalog/models'); }
  doctor(): Promise<Doctor> { return this.get('/v1/catalog/doctor'); }
  info(repo: string): Promise<ModelInfo> {
    return this.get(`/v1/catalog/info?repo=${encodeURIComponent(repo)}`, 60_000);
  }

  search(q: { query: string; task?: string; library?: string; limit?: number; sizes?: boolean }):
  Promise<SearchResult> {
    const params = new URLSearchParams({ q: q.query });
    if (q.task) params.set('task', q.task);
    if (q.library) params.set('library', q.library);
    params.set('limit', String(q.limit ?? 20));
    // Size lookup is one Hub request per result. The CLI makes it opt-in for
    // the same reason, and the timeout below is generous for the same reason.
    if (q.sizes === true) params.set('fits', '1');
    return this.get(`/v1/catalog/search?${params.toString()}`, q.sizes === true ? 120_000 : 30_000);
  }

  pull(repo: string, to?: string): Promise<Job> {
    return this.post('/v1/catalog/pull', { repo, ...(to ? { to } : {}) });
  }

  move(repo: string, to: string, keep = false): Promise<Job> {
    return this.post('/v1/catalog/mv', { repo, to, keep });
  }

  remove(repo: string): Promise<Job> {
    return this.post('/v1/catalog/rm', { repo });
  }

  job(id: string): Promise<Job> { return this.get(`/v1/jobs/${id}`); }
  jobs(): Promise<{ jobs: Job[] }> { return this.get('/v1/jobs'); }
  cancel(id: string): Promise<{ cancelling: string }> {
    return this.post(`/v1/jobs/${id}/cancel`, {});
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
      // the whole diagnosis: a denied host is a manifest bug the user cannot
      // fix from Settings, an unreachable one is just a daemon that isn't up.
      const message = err instanceof Error ? err.message : String(err);
      if (/denied/i.test(message)) {
        throw new CatalogError(
          `${this.baseUrl} is not in this plugin's net:fetch permissions.`,
          'Settings can only point at 127.0.0.1:8077 or localhost:8077 — anything '
          + 'else needs a new entry in plugins/model-manager/plugin.json.',
        );
      }
      throw new CatalogError(`Can't reach the catalog daemon at ${this.baseUrl}.`, START_HINT);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new CatalogError(
        `${this.baseUrl} answered ${res.status} with a non-JSON body.`,
        // Almost always something else already owns the port.
        `Is something other than modelctld listening there? ${res.body.slice(0, 120)}`,
      );
    }

    if (!res.ok) {
      const e = parsed as ErrorBody;
      throw new CatalogError(
        typeof e.error === 'string' ? e.error : `HTTP ${res.status}`,
        typeof e.hint === 'string' ? e.hint : undefined,
      );
    }
    return parsed as T;
  }
}

export function fitColor(fit: Fit | null): string {
  if (fit === 'yes') return 'var(--ok-fg, #15803d)';
  if (fit === 'tight') return 'var(--warn-fg, #b45309)';
  if (fit === 'no') return 'var(--error-fg, #b91c1c)';
  return 'var(--chrome-muted, #71717a)';
}
