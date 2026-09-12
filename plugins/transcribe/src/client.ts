import type { PluginContext } from '@workbench/plugin-sdk';

/**
 * The only file in this plugin that knows HTTP exists.
 *
 * Same shape as model-manager's `CatalogClient`, deliberately not shared with
 * it: each plugin owns its wire types (PRD README, "shared manifest
 * boilerplate"), and a plugin importing another plugin's source would be a
 * dependency the host knows nothing about. The panel talks to `AsrClient` and
 * would not notice if the transport changed.
 */

// ─── wire types (mirror modelctld.py / asr.py) ───────────────
export interface Probe {
  path: string;
  name: string;
  size: number;
  duration: number | null;
  has_audio: boolean;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  segments: Segment[];
  language: string | null;
  duration: number;
  model: string;
}

export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

export interface AsrJob {
  id: string;
  kind: string;
  /** For an asr job, the model. */
  repo: string;
  state: JobState;
  started: number;
  finished: number | null;
  elapsed: number;
  exit_code: number | null;
  percent: number | null;
  error: string | null;
  params: { path?: string; language?: string };
  /** Only on `job(id)`. */
  log?: string[];
  /** Only on `jobs()`. */
  last_line?: string;
  /** Only on `job(id)`, once done. */
  result?: Transcript | null;
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
  constructor(message: string, readonly hint: string | undefined, readonly kind: DaemonErrorKind) {
    super(message);
    this.name = 'DaemonError';
  }
}

export function asDaemonError(err: unknown): DaemonError {
  return err instanceof DaemonError ? err : new DaemonError(String(err), undefined, 'api');
}

interface ErrorBody { error?: unknown; hint?: unknown }

export class AsrClient {
  constructor(
    private readonly ctx: PluginContext,
    private readonly baseUrl: string = DEFAULT_DAEMON_URL,
    private readonly token: string = '',
  ) {}

  get url(): string { return this.baseUrl; }

  health(): Promise<{ ok: boolean; version: string }> { return this.get('/v1/health', 5_000); }

  /** Repos on either drive. Used to mark models that would 404. */
  async installed(): Promise<string[]> {
    const inv = await this.get<{ models: Array<{ repo: string }> }>('/v1/catalog/models', 30_000);
    return inv.models.map((m) => m.repo);
  }

  probe(path: string): Promise<Probe> {
    return this.get(`/v1/generate/asr/probe?path=${encodeURIComponent(path)}`, 30_000);
  }

  start(req: { path: string; model: string; language: string }): Promise<AsrJob> {
    return this.post('/v1/generate/asr', req);
  }

  /**
   * C1: the daemon writes, the plugin only names the folder. It renders the
   * front matter, refuses to overwrite, and answers with the path it chose.
   */
  save(req: { job_id: string; dir: string; timestamps: boolean }): Promise<{ path: string }> {
    return this.post('/v1/generate/asr/save', req, 30_000);
  }

  job(id: string): Promise<AsrJob> { return this.get(`/v1/jobs/${encodeURIComponent(id)}`); }
  jobs(): Promise<{ jobs: AsrJob[] }> { return this.get('/v1/jobs'); }

  /** Terminates the asr.py subprocess; the next poll sees `cancelled`. */
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
          + 'needs a new entry in plugins/transcribe/plugin.json.',
          'denied',
        );
      }
      throw new DaemonError("The transcription daemon isn't running.", START_COMMAND, 'offline');
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
