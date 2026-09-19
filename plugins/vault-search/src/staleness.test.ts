import { describe, expect, it } from 'vitest';
import type { Folder } from './client.js';
import { age, staleness } from './staleness.js';

const NOW = 1_800_000_000;
const SETTINGS = { model: 'sentence-transformers/LaBSE', chunkSize: 512 };

function folder(over: Partial<Folder> = {}): Folder {
  return {
    name: 'Calismalar',
    path: '/v/Calismalar',
    files: 319,
    chunks: 5356,
    indexed_at: NOW - 2 * 86_400,
    model: SETTINGS.model,
    chunk_size: SETTINGS.chunkSize,
    changed: 0,
    ...over,
  };
}

describe('staleness', () => {
  it('says up to date when nothing changed', () => {
    expect(staleness(folder(), NOW, SETTINGS)).toEqual({
      text: 'Indexed 2 days ago · up to date', tone: 'ok', needsFull: false,
    });
  });

  it('counts changed files, singular and plural', () => {
    expect(staleness(folder({ changed: 41 }), NOW, SETTINGS).text).toBe('Indexed 2 days ago · 41 files changed');
    expect(staleness(folder({ changed: 1 }), NOW, SETTINGS)).toMatchObject({
      text: 'Indexed 2 days ago · 1 file changed', tone: 'stale',
    });
  });

  it('flags a folder that was never indexed', () => {
    expect(staleness(folder({ indexed_at: null }), NOW, SETTINGS)).toMatchObject({ text: 'Not indexed yet', tone: 'warn' });
  });

  it('flags an unreachable folder rather than calling it up to date', () => {
    expect(staleness(folder({ changed: null }), NOW, SETTINGS)).toMatchObject({
      text: 'Folder unreachable — is the drive mounted?', tone: 'warn', needsFull: false,
    });
  });

  it('asks for a full re-index when the model or chunk size moved', () => {
    for (const s of [{ ...SETTINGS, chunkSize: 256 }, { ...SETTINGS, model: 'google/embeddinggemma-300m' }]) {
      expect(staleness(folder({ changed: 5 }), NOW, s)).toEqual({
        text: 'Settings changed — full re-index needed', tone: 'warn', needsFull: true,
      });
    }
  });
});

describe('age', () => {
  it.each([
    [0, 'just now'],
    [59, 'just now'],
    [60, '1 minute ago'],
    [3_599, '59 minutes ago'],
    [3_600, '1 hour ago'],
    [86_399, '23 hours ago'],
    [86_400, 'yesterday'],
    [2 * 86_400, '2 days ago'],
    [-5, 'just now'],
  ])('%i seconds → %s', (seconds, text) => {
    expect(age(seconds)).toBe(text);
  });
});
