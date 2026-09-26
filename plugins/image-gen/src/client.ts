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
