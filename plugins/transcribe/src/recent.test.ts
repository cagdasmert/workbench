import { describe, expect, it } from 'vitest';
import { addRecent, markSaved, parseRecent, timeAgo, type RecentEntry } from './recent.js';

const entry = (jobId: string, over: Partial<RecentEntry> = {}): RecentEntry => ({
  jobId,
  filename: `${jobId}.m4a`,
  when: 1_000,
  model: 'mlx-community/whisper-large-v3-turbo',
  chars: 100,
  savedPath: null,
  ...over,
});

describe('parseRecent — the storage boundary', () => {
  it('keeps well-formed entries', () => {
    expect(parseRecent([entry('a'), entry('b', { savedPath: '/v/b.md' })])).toEqual([
      entry('a'), entry('b', { savedPath: '/v/b.md' }),
    ]);
  });

  it('drops anything malformed instead of trusting it', () => {
    expect(parseRecent([entry('a'), { jobId: 3 }, null, 'x', { ...entry('b'), chars: '9' }]))
      .toEqual([entry('a')]);
  });

  it('treats a non-array as empty', () => {
    expect(parseRecent(undefined)).toEqual([]);
    expect(parseRecent({ a: 1 })).toEqual([]);
  });

  it('caps at five', () => {
    expect(parseRecent(['1', '2', '3', '4', '5', '6', '7'].map((id) => entry(id)))).toHaveLength(5);
  });
});

describe('addRecent', () => {
  it('puts the newest first and caps at five', () => {
    let list: RecentEntry[] = [];
    for (const id of ['1', '2', '3', '4', '5', '6']) list = addRecent(list, entry(id));
    expect(list.map((e) => e.jobId)).toEqual(['6', '5', '4', '3', '2']);
  });

  it('replaces the same job rather than listing it twice, keeping a known save', () => {
    const list = [entry('b'), entry('a', { savedPath: '/v/a.md' })];
    const next = addRecent(list, entry('a', { chars: 200 }));
    expect(next.map((e) => e.jobId)).toEqual(['a', 'b']);
    expect(next[0]).toEqual(entry('a', { chars: 200, savedPath: '/v/a.md' }));
  });
});

describe('markSaved', () => {
  it('records the written path on that job only', () => {
    const next = markSaved([entry('a'), entry('b')], 'b', '/v/b.md');
    expect(next[0]?.savedPath).toBeNull();
    expect(next[1]?.savedPath).toBe('/v/b.md');
  });
});

describe('timeAgo', () => {
  const now = 10 * 86_400_000;
  it('reads like a person', () => {
    expect(timeAgo(now - 20_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2 d ago');
  });
});
