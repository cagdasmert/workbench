import type { Folder } from './client.js';

/**
 * The quiet line under each folder (PRD §4, "Staleness"). Pure: the daemon
 * already counted `changed` from a stat walk; this only words it.
 */

export type Tone = 'ok' | 'stale' | 'warn';

export interface Staleness {
  text: string;
  tone: Tone;
  /** The folder was built with other settings: only a full re-index can fix it, and it needs a confirm. */
  needsFull: boolean;
}

/** `seconds` ago, in words. Clock skew (a negative age) reads as "just now". */
export function age(seconds: number): string {
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) {
    const m = Math.floor(seconds / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3_600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(seconds / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function staleness(folder: Folder, now: number, settings: { model: string; chunkSize: number }): Staleness {
  if (folder.indexed_at === null) return { text: 'Not indexed yet', tone: 'warn', needsFull: false };
  if (folder.changed === null) {
    return { text: 'Folder unreachable — is the drive mounted?', tone: 'warn', needsFull: false };
  }
  if (folder.model !== settings.model || folder.chunk_size !== settings.chunkSize) {
    return { text: 'Settings changed — full re-index needed', tone: 'warn', needsFull: true };
  }
  const when = `Indexed ${age(now - folder.indexed_at)}`;
  if (folder.changed === 0) return { text: `${when} · up to date`, tone: 'ok', needsFull: false };
  const n = folder.changed;
  return { text: `${when} · ${n} file${n === 1 ? '' : 's'} changed`, tone: 'stale', needsFull: false };
}
