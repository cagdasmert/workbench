import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, LANGUAGES, OTHER_LANGUAGES, PINNED_LANGUAGES, checkLanguage } from './capabilities.js';

const PARAKEET = 'mlx-community/parakeet-tdt-0.6b-v3';

describe('checkLanguage — the Parakeet trap (PRD §6)', () => {
  it('blocks Parakeet with Turkish, before a run', () => {
    const w = checkLanguage(PARAKEET, 'tr');
    expect(w?.level).toBe('block');
    expect(w?.message).toMatch(/Turkish/);
  });

  it('cautions Parakeet with auto-detect — it cannot know the audio is Turkish', () => {
    expect(checkLanguage(PARAKEET, 'auto')?.level).toBe('caution');
  });

  it('lets Parakeet run its own languages', () => {
    expect(checkLanguage(PARAKEET, 'en')).toBeNull();
    expect(checkLanguage(PARAKEET, 'de')).toBeNull();
  });

  it('never second-guesses Whisper, or a model it has no table for', () => {
    expect(checkLanguage(DEFAULT_MODEL, 'tr')).toBeNull();
    expect(checkLanguage(DEFAULT_MODEL, 'auto')).toBeNull();
    expect(checkLanguage('someone/whisper-small-mlx', 'tr')).toBeNull();
  });
});

describe('the language picker and the table agree', () => {
  it('offers every language Parakeet supports', () => {
    const offered = new Set([...PINNED_LANGUAGES, ...OTHER_LANGUAGES].map((l) => l.code));
    for (const code of LANGUAGES[PARAKEET] ?? []) expect(offered).toContain(code);
  });

  it('matches the 25 in asr.py', () => {
    expect(LANGUAGES[PARAKEET]?.size).toBe(25);
  });
});
