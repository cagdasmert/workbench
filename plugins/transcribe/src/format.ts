/**
 * Display formatting. Pure, so it is tested rather than eyeballed.
 */

/**
 * `mm:ss` under an hour, `h:mm:ss` past it. The daemon's `asr.format_timestamp`
 * writes the same string into saved markdown — the panel and the file must
 * agree, or a timestamp copied from one will not be found in the other.
 */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'unknown length';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

export function formatBytes(n: number): string {
  if (n < 1_000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)} KB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}
