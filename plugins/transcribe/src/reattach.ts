import type { AsrJob } from './client.js';

export type Reattach = { kind: 'running' | 'done'; job: AsrJob };

/**
 * What a freshly mounted panel should show, decided from the daemon's job list
 * (newest first) — never from a remembered id, because only the daemon knows
 * whether the job is still there.
 *
 * A running transcription wins. Otherwise the newest one, if it finished while
 * no panel was watching and is not in `recent` yet: that is the result the user
 * closed the panel waiting for. A failure is not reopened — it would greet every
 * later visit with an old error.
 */
export function pickReattach(jobs: readonly AsrJob[], seen: ReadonlySet<string>): Reattach | null {
  const asr = jobs.filter((j) => j.kind === 'asr');
  const running = asr.find((j) => j.state === 'running');
  if (running !== undefined) return { kind: 'running', job: running };
  const newest = asr[0];
  if (newest !== undefined && newest.state === 'done' && !seen.has(newest.id)) {
    return { kind: 'done', job: newest };
  }
  return null;
}
