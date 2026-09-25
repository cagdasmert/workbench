/**
 * Pure text helpers for the result cards. No DOM, no React: everything here is
 * tested directly.
 */

/** `sub/Note name.md` → `[[Note name]]` — in a plain-markdown vault, that is what a link is. */
export function wikilink(relPath: string): string {
  const name = relPath.split('/').pop() ?? relPath;
  return `[[${name.replace(/\.md$/i, '')}]]`;
}

export interface Span {
  text: string;
  hit: boolean;
}

const EDGE_PUNCT = /^[\s()[\]{}.,;:!?"'«»“”‘’…-]+|[\s()[\]{}.,;:!?"'«»“”‘’…-]+$/gu;

/** Query words worth marking: three letters or more, punctuation trimmed from the ends. */
function queryWords(query: string): string[] {
  const words = query
    .split(/\s+/u)
    .map((w) => fold(w.replace(EDGE_PUNCT, '')))
    .filter((w) => [...w].length >= 3);
  return [...new Set(words)];
}

/**
 * Turkish-aware lower case that never changes length, so an index into the
 * folded string is an index into the original. `'İ'.toLowerCase()` is two code
 * units outside the `tr` locale; any character whose fold changes length is
 * kept as it is.
 */
function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    const low = ch.toLocaleLowerCase('tr');
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

/**
 * The text cut into spans, with every occurrence of a query word marked. The
 * match is literal (no stemming), which is the point: it shows *where* the
 * words are, while the ranking itself is semantic.
 */
export function highlight(text: string, query: string): Span[] {
  const words = queryWords(query);
  if (words.length === 0) return [{ text, hit: false }];
  const folded = fold(text);
  const ranges: Array<[number, number]> = [];
  for (const w of words) {
    for (let i = folded.indexOf(w); i !== -1; i = folded.indexOf(w, i + w.length)) {
      ranges.push([i, i + w.length]);
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const spans: Span[] = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) spans.push({ text: text.slice(at, s), hit: false });
    spans.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) spans.push({ text: text.slice(at), hit: false });
  return spans;
}

/** At most `max` characters of `text`, around the first query word when there is one. */
export function excerpt(text: string, query: string, max = 320): string {
  if (text.length <= max) return text;
  let first = 0;
  let pos = 0;
  for (const span of highlight(text, query)) {
    if (span.hit) {
      first = pos;
      break;
    }
    pos += span.text.length;
  }
  const start = Math.max(0, Math.min(first - Math.floor(max / 3), text.length - max));
  const end = start + max;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** `{done, total}` from the indexer's own `name: N/M files P%` line, or null before the first one. */
export function progressOf(job: { last_line?: string; log?: string[] }): { done: number; total: number } | null {
  const lines = job.log ?? (job.last_line === undefined ? [] : [job.last_line]);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /(\d+)\/(\d+) files/.exec(lines[i] ?? '');
    if (m !== null) return { done: Number(m[1]), total: Number(m[2]) };
  }
  return null;
}
