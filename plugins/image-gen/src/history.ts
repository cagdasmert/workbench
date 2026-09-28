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

const ROLES = ['generate', 'edit', 'upscale'] as const satisfies readonly Role[];
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown): boolean => v === null || isStr(v);
const numOrNull = (v: unknown): boolean => v === null || isNum(v);

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return isStr(e['id']) && isStr(e['mode']) && (ROLES as readonly string[]).includes(e['mode'])
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
