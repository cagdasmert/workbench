import type { Hit } from './client.js';
import { wikilink } from './text.js';

/**
 * Answer mode's prompt and its reading, in one place for both backends (LM
 * Studio and the daemon's text.py). Pure: no network, no DOM.
 *
 * The passage number *is* the card number, so a `[2]` in the answer and the
 * second card are the same note by construction — that is the whole of the
 * "every claim carries its source" mitigation (PRD §10).
 */

export const MAX_PASSAGES = 6;
const PASSAGE_CHARS = 1_200;

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

export function buildMessages(query: string, hits: Hit[]): ChatMessage[] {
  const passages = hits.slice(0, MAX_PASSAGES).map((h, i) => {
    const label = h.heading !== '' ? h.heading : h.title;
    const body = h.chunk.length > PASSAGE_CHARS ? `${h.chunk.slice(0, PASSAGE_CHARS)}…` : h.chunk;
    return `[${i + 1}] ${label}\n${body}`;
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
