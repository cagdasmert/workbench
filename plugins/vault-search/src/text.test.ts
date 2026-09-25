import { describe, expect, it } from 'vitest';
import { excerpt, highlight, progressOf, wikilink } from './text.js';

describe('wikilink', () => {
  it('is the note name, the way Obsidian links it', () => {
    expect(wikilink('02_Projects/Local-Desktop-Util/architecture.md')).toBe('[[architecture]]');
    expect(wikilink('Kısa not.md')).toBe('[[Kısa not]]');
  });
});

describe('highlight', () => {
  const hits = (text: string, q: string) => highlight(text, q).filter((s) => s.hit).map((s) => s.text);

  it('matches Turkish case-insensitively', () => {
    expect(hits('İstanbul ve istanbul', 'İSTANBUL')).toEqual(['İstanbul', 'istanbul']);
    expect(hits('IŞIK ışık', 'ışık')).toEqual(['IŞIK', 'ışık']);
  });

  it('ignores words shorter than three letters', () => {
    expect(hits('ve bu da bir not', 've bu da')).toEqual([]);
  });

  it('keeps every character of the text, in order', () => {
    const text = 'Kavram araması, kavramlar arasında.';
    expect(highlight(text, 'kavram').map((s) => s.text).join('')).toBe(text);
    expect(hits(text, 'kavram')).toEqual(['Kavram', 'kavram']);
  });

  it('treats regex characters in the query as text', () => {
    expect(hits('a (c++) b', 'c++ (x')).toEqual(['c++']);
  });
});

describe('excerpt', () => {
  it('returns short text unchanged', () => {
    expect(excerpt('kısa metin', 'metin')).toBe('kısa metin');
  });

  it('centres a long text on the first match', () => {
    const text = `${'a '.repeat(300)}hedef${' b'.repeat(300)}`;
    const out = excerpt(text, 'hedef', 120);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toContain('hedef');
    expect(out.length).toBeLessThanOrEqual(122);
  });

  it('starts at the top when nothing matches', () => {
    const out = excerpt('x'.repeat(500), 'yok', 100);
    expect(out.startsWith('x')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('progressOf', () => {
  it('reads the indexer\'s own progress line', () => {
    expect(progressOf({ last_line: 'Calismalar: 32/319 files 10%' })).toEqual({ done: 32, total: 319 });
    expect(progressOf({ log: ['loading', 'V: 1/2 files 50%', 'V: 2/2 files 100%'] })).toEqual({ done: 2, total: 2 });
  });

  it('is null before the first progress line', () => {
    expect(progressOf({ last_line: 'loading model' })).toBeNull();
    expect(progressOf({})).toBeNull();
  });
});
