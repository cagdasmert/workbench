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
