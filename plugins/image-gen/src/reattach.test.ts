import { describe, expect, it } from 'vitest';
import type { ImageJob, JobState } from './client.js';
import { planReattach } from './reattach.js';

const job = (id: string, state: JobState, kind = 'image'): ImageJob => ({
  id, kind, repo: 'mflux-community/z-image-turbo-mflux-q8', state,
  started: 0, finished: null, elapsed: 0, exit_code: null, percent: null, error: null, params: {},
});

describe('planReattach — what a freshly mounted panel adopts (C4, spec decision 17)', () => {
  it('attaches to the running image job', () => {
    expect(planReattach([job('b', 'done'), job('a', 'running')], new Set(['b'])))
      .toEqual({ running: job('a', 'running'), unrecorded: [] });
  });

  it('records image jobs that finished while no panel was watching, and only those', () => {
    const jobs = [job('d', 'done'), job('c', 'done'), job('f', 'failed'), job('x', 'cancelled')];
    expect(planReattach(jobs, new Set(['c']))).toEqual({ running: null, unrecorded: ['d'] });
  });

  it('ignores other kinds of job on the same daemon', () => {
    expect(planReattach([job('p', 'running', 'pull'), job('t', 'done', 'asr')], new Set()))
      .toEqual({ running: null, unrecorded: [] });
  });

  it('has nothing to do on an empty daemon', () => {
    expect(planReattach([], new Set())).toEqual({ running: null, unrecorded: [] });
  });
});
