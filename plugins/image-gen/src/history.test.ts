import { describe, expect, it } from 'vitest';
import type { ImageJob } from './client.js';
import {
  addHistory, DEFAULT_HISTORY_LIMIT, describeEntry, fromJob, historyLimit, parseHistory, shortModel,
  type HistoryEntry,
} from './history.js';

const REPO = 'mflux-community/z-image-turbo-mflux-q8';

const done = (id: string, finished: number): ImageJob => ({
  id, kind: 'image', repo: REPO, state: 'done', started: finished - 14, finished, elapsed: 14.2,
  exit_code: 0, percent: 100, error: null, params: {},
  result: {
    mode: 'generate', model: REPO, seed: 42, steps: 9, prompt: 'a gate', width: 1024, height: 1024,
    path: '/pics/20260926-120000_generate_42.png', preview_b64: 'AAAA', load_s: 5.1, gen_s: 9.0, peak_gb: 12.3,
  },
});

function entry(id: string, whenSeconds: number): HistoryEntry {
  const e = fromJob(done(id, whenSeconds));
  if (e === null) throw new Error('fixture must be a finished job');
  return e;
}

describe('fromJob', () => {
  it('turns a finished job into an entry, with nulls for what the request did not use', () => {
    expect(fromJob(done('a', 1_758_880_000))).toEqual({
      id: 'a', mode: 'generate', model: REPO, seed: 42, steps: 9, width: 1024, height: 1024,
      prompt: 'a gate', negative: null, instruction: null, source: null, factor: null,
      path: '/pics/20260926-120000_generate_42.png', thumb_b64: 'AAAA',
      when: 1_758_880_000_000, elapsed: 14.2,
    });
  });

  it('gives nothing for a job that is running, failed, or finished without a result', () => {
    const base = done('a', 100);
    expect(fromJob({ ...base, state: 'running' })).toBeNull();
    expect(fromJob({ ...base, state: 'failed' })).toBeNull();
    expect(fromJob({ ...base, result: null })).toBeNull();
  });
});

describe('addHistory', () => {
  it('keeps the newest first and replaces an entry with the same id', () => {
    let list: HistoryEntry[] = [];
    list = addHistory(list, entry('a', 1), 10);
    list = addHistory(list, entry('c', 3), 10);
    list = addHistory(list, entry('b', 2), 10);
    list = addHistory(list, entry('c', 3), 10);
    expect(list.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('prunes the oldest past the limit', () => {
    let list: HistoryEntry[] = [];
    for (const [id, t] of [['a', 1], ['b', 2], ['c', 3]] as const) list = addHistory(list, entry(id, t), 2);
    expect(list.map((e) => e.id)).toEqual(['c', 'b']);
  });
});

describe('parseHistory', () => {
  it('keeps only well-formed entries, and nothing from a non-array', () => {
    const good = entry('a', 1);
    expect(parseHistory('x', 10)).toEqual([]);
    expect(parseHistory([good, { ...good, id: 'b', path: 5 }, { ...good, id: 'c', mode: 'draw' }], 10)).toEqual([good]);
  });

  it('truncates to the limit, keeping the newest (F2)', () => {
    const list = [entry('a', 1), entry('b', 2), entry('c', 3)];
    expect(parseHistory(list, 2).map((e) => e.id)).toEqual(['c', 'b']);
  });

  it('re-sorts an unsorted list, newest first (F2)', () => {
    const list = [entry('a', 1), entry('c', 3), entry('b', 2)];
    expect(parseHistory(list, 10).map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('historyLimit', () => {
  it('falls back to the default for anything that is not a positive number', () => {
    for (const raw of [undefined, 0, -3, 'x', Number.NaN]) expect(historyLimit(raw)).toBe(DEFAULT_HISTORY_LIMIT);
    expect(historyLimit(50)).toBe(50);
    expect(historyLimit(12.7)).toBe(12);
  });
});

describe('shortModel', () => {
  it("names a repo, a modelctl snapshot folder, and any other folder by its model", () => {
    expect(shortModel(REPO)).toBe('z-image-turbo-mflux-q8');
    expect(shortModel('/Volumes/Kingston/hf-cache/models--mflux-community--z-image-turbo-mflux-q8/snapshots/abc'))
      .toBe('z-image-turbo-mflux-q8');
    expect(shortModel('/Users/me/models/z-image-turbo-q8/')).toBe('z-image-turbo-q8');
    expect(shortModel('~/models/zit')).toBe('zit');
  });
});

describe('describeEntry', () => {
  it('says what produced the image in one line', () => {
    expect(describeEntry(entry('a', 1))).toBe('seed 42 · 9 steps · 1024×1024 · 14.2 s · z-image-turbo-mflux-q8');
  });
});
