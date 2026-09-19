/**
 * The last five transcriptions, as stored in `ctx.storage` (PRD §8).
 *
 * Metadata only. Storage is scoped, not isolated, so the transcript itself
 * never goes here — it lives in the daemon's job record until a restart, and
 * on disk once saved. `savedPath` is what makes a forgotten job still findable.
 */

/** A type alias, not an interface: `storage.set<T>` needs T to satisfy JsonValue. */
export type RecentEntry = {
  jobId: string;
  filename: string;
  /** Epoch millis. */
  when: number;
  model: string;
  chars: number;
  savedPath: string | null;
};

export const MAX_RECENT = 5;

function isEntry(v: unknown): v is RecentEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e['jobId'] === 'string'
    && typeof e['filename'] === 'string'
    && typeof e['when'] === 'number'
    && typeof e['model'] === 'string'
    && typeof e['chars'] === 'number'
    && (e['savedPath'] === null || typeof e['savedPath'] === 'string');
}

/** Whatever storage hands back, narrowed. A bad entry is dropped, not trusted. */
export function parseRecent(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isEntry).slice(0, MAX_RECENT);
}

export function addRecent(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  const previous = list.find((e) => e.jobId === entry.jobId);
  const merged = entry.savedPath === null && previous !== undefined
    ? { ...entry, savedPath: previous.savedPath }
    : entry;
  return [merged, ...list.filter((e) => e.jobId !== entry.jobId)].slice(0, MAX_RECENT);
}

export function markSaved(list: readonly RecentEntry[], jobId: string, path: string): RecentEntry[] {
  return list.map((e) => (e.jobId === jobId ? { ...e, savedPath: path } : e));
}

export function timeAgo(when: number, now: number): string {
  const s = Math.max(0, Math.round((now - when) / 1_000));
  if (s < 60) return 'just now';
  if (s < 3_600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
