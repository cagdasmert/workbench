import type { Hit, Passage } from './client.js';
import { wikilink } from './text.js';

/**
 * Answer mode's prompt and its reading, in one place for both backends (LM
 * Studio and the daemon's text.py). Pure: no network, no DOM.
 *
 * The passage number *is* the card number, so a `[2]` in the answer and the
 * second card are the same note by construction — that is the whole of the
 * "every claim carries its source" mitigation (PRD §10).
 */

/** Notes sent to the model — and so the highest card number a citation can name. */
export const MAX_PASSAGES = 6;
/**
 * The whole prompt's passage text. LM Studio often runs a model with a 4k-token
 * context; ~9,000 characters of mixed Turkish and English stays well inside
 * it with room for the answer.
 */
export const PROMPT_CHARS = 9_000;
const PASSAGE_CHARS = 1_200;
/** A leftover budget smaller than this buys a fragment, not a passage. */
const MIN_PIECE = 300;
/** How many passages per note answer mode asks the daemon for. */
export const ANSWER_PER_NOTE = 3;

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

// Measured on the vault (change log 40): without the "leave it out" line a
// 30B model padded answers with what it knew and cited a note that only
// mentioned the topic. A citation is only worth its passage.
const SYSTEM = [
  'You answer questions from the user\'s own notes.',
  'Use only the numbered notes below — not what you otherwise know.',
  'After every claim, cite the note it came from as [n], for example [2] or [1][3].',
  'Every claim must be stated in the note you cite. If it is not written there, leave it out — even if you know it to be true.',
  'If the notes do not contain the answer, say so in one sentence instead of guessing.',
  'Answer in the language of the question. Be brief.',
].join('\n');

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function passagesOf(h: Hit): Passage[] {
  return h.passages !== undefined && h.passages.length > 0
    ? h.passages
    : [{ heading: h.heading, chunk: h.chunk, start_line: h.start_line, score: h.score }];
}

/** The part of a heading path the note's title does not already say. */
function section(title: string, heading: string): string {
  if (heading === '' || heading === title) return '';
  return heading.startsWith(`${title} › `) ? heading.slice(title.length + 3) : heading;
}

/**
 * One numbered block per note — its passages share the note's number, so a
 * citation still names a card — with passages in reading order. The budget is
 * spent by rank: every note's best passage first, then second-best passages,
 * and so on, so a long note cannot crowd out the sixth note's only passage.
 */
export function buildMessages(query: string, hits: Hit[]): ChatMessage[] {
  const notes = hits.slice(0, MAX_PASSAGES).map((h) => ({ h, ranked: passagesOf(h) }));
  const chosen: Array<Array<{ p: Passage; text: string }>> = notes.map(() => []);
  let budget = PROMPT_CHARS;
  const depth = Math.max(0, ...notes.map((n) => n.ranked.length));
  for (let rank = 0; rank < depth; rank++) {
    notes.forEach((n, i) => {
      const p = n.ranked[rank];
      if (p === undefined) return;
      if (rank > 0 && budget < MIN_PIECE) return;
      const text = cut(p.chunk, rank === 0 ? Math.min(PASSAGE_CHARS, Math.max(budget, MIN_PIECE)) : Math.min(PASSAGE_CHARS, budget));
      chosen[i]?.push({ p, text });
      budget -= text.length;
    });
  }
  const passages = notes.map((n, i) => {
    const pieces = [...(chosen[i] ?? [])]
      .sort((a, b) => a.p.start_line - b.p.start_line)
      .map(({ p, text }) => {
        const sec = section(n.h.title, p.heading);
        return sec === '' ? text : `§ ${sec}\n${text}`;
      });
    return `[${i + 1}] ${n.h.title}\n${pieces.join('\n\n')}`;
  });
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Notes:\n\n${passages.join('\n\n')}\n\nQuestion: ${query}\n` },
  ];
}

export type AnswerPart = { text: string } | { cite: number };

/** Mirrors text.py's strip_think: several local models reason aloud first. */
export function stripThink(s: string): string {
  let out = s.replace(/<think>[\s\S]*?<\/think>/g, '');
  const close = out.lastIndexOf('</think>');
  if (close !== -1) out = out.slice(close + '</think>'.length);
  if (out.trimStart().startsWith('<think>')) return '';
  return out.trim();
}

/**
 * The answer text a user should see: reasoning dropped, and the reply cut at
 * the first leaked chat-template token (`<|user|>`, `<|im_end|>`, …). A model
 * whose template has no working stop token writes the next turn itself until
 * max_tokens — GLM-4.7-flash under LM Studio does — and everything after its
 * own turn is invention.
 */
export function cleanAnswer(raw: string): string {
  const text = stripThink(raw);
  const leak = text.search(/<\|[a-z_]+\|>/i);
  return (leak === -1 ? text : text.slice(0, leak)).trim();
}

/**
 * The answer as text and citations. `[2, 3]` and `[1][3]` become one cite per
 * number; a number with no card behind it stays as the characters the model
 * wrote, because rewriting it would hide exactly the error worth seeing.
 */
export function parseAnswer(raw: string, count: number): AnswerPart[] {
  const text = cleanAnswer(raw);
  const parts: AnswerPart[] = [];
  const pushText = (t: string) => {
    if (t === '') return;
    const last = parts[parts.length - 1];
    if (last !== undefined && 'text' in last) last.text += t;
    else parts.push({ text: t });
  };
  let at = 0;
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    const nums = (m[1] ?? '').split(',').map((n) => Number(n.trim()));
    const idx = m.index ?? 0;
    pushText(text.slice(at, idx));
    if (nums.every((n) => n >= 1 && n <= count)) nums.forEach((n) => parts.push({ cite: n }));
    else pushText(m[0]);
    at = idx + m[0].length;
  }
  pushText(text.slice(at));
  return parts;
}

/** LM Studio's `/api/v0/models`: the first loaded chat model, or null. */
export function pickLoadedModel(apiV0: unknown): string | null {
  const data = (apiV0 as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  for (const m of data) {
    const e = m as { id?: unknown; type?: unknown; state?: unknown };
    if (typeof e.id === 'string' && e.type !== 'embeddings' && e.state === 'loaded' && (e.type === 'llm' || e.type === 'vlm')) {
      return e.id;
    }
  }
  return null;
}

function sources(hits: Hit[]): string {
  return hits.map((h, i) => `${i + 1}. ${wikilink(h.rel_path)} — ${h.folder}`).join('\n');
}

/** What *Send* emits with an answer: the question, the answer with links in place of numbers, the sources. */
export function answerMarkdown(query: string, answer: string, hits: Hit[]): string {
  const shown = hits.slice(0, MAX_PASSAGES);
  const body = parseAnswer(answer, shown.length)
    .map((p) => ('cite' in p ? wikilink(shown[p.cite - 1]?.rel_path ?? '') : p.text))
    .join('');
  return `> ${query}\n\n${body}\n\n## Sources\n\n${sources(shown)}\n`;
}

/** What *Send* emits without an answer: the notes that match, as links. */
export function hitsMarkdown(query: string, hits: Hit[]): string {
  const list = hits.map((h) => `- ${wikilink(h.rel_path)} — ${h.folder}`).join('\n');
  return `> ${query}\n\n${list}\n`;
}
