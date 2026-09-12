import { describe, expect, it } from 'vitest';
import type { AsrJob, JobState } from './client.js';
import { pickReattach } from './reattach.js';

const job = (id: string, state: JobState, kind = 'asr'): AsrJob => ({
  id, kind, repo: 'mlx-community/whisper-large-v3-turbo', state,
  started: 0, finished: null, elapsed: 0, exit_code: null, percent: null, error: null, params: {},
});

describe('pickReattach — what a freshly mounted panel should show (C4)', () => {
  it('attaches to a running transcription', () => {
    expect(pickReattach([job('a', 'running')], new Set())).toEqual({ kind: 'running', job: job('a', 'running') });
  });

  it('prefers a running job over a finished one', () => {
    expect(pickReattach([job('b', 'done'), job('a', 'running')], new Set())?.job.id).toBe('a');
  });

  it('opens a transcript that finished while the panel was closed', () => {
    expect(pickReattach([job('b', 'done'), job('a', 'done')], new Set()))
      .toEqual({ kind: 'done', job: job('b', 'done') });   // list is newest first
  });

  it('does not reopen one the user has already seen', () => {
    expect(pickReattach([job('b', 'done')], new Set(['b']))).toBeNull();
  });

  it('does not nag about failures or cancellations', () => {
    expect(pickReattach([job('b', 'failed'), job('c', 'cancelled')], new Set())).toBeNull();
  });

  it('ignores other kinds of job on the same daemon', () => {
    expect(pickReattach([job('p', 'running', 'pull')], new Set())).toBeNull();
  });
});
