import type { Transcript } from './client.js';
import { formatTimestamp } from './format.js';

/**
 * The transcript as markdown for the content bus.
 *
 * Deliberately the second renderer: the saved file is rendered by the daemon
 * (`asr.render_markdown`), which keeps its write primitive narrow — it writes
 * transcripts of its own jobs, never caller-supplied text. This one produces
 * the same body without the front matter, which is metadata for a vault, not
 * content for whoever receives it.
 */
export function transcriptMarkdown(result: Transcript, opts: { title: string; timestamps: boolean }): string {
  const paragraphs = result.segments
    .map((s) => ({ start: s.start, text: s.text.trim() }))
    .filter((s) => s.text !== '')
    .map((s) => (opts.timestamps ? `[${formatTimestamp(s.start)}] ${s.text}` : s.text));
  return [`# ${opts.title}`, ...paragraphs].join('\n\n') + '\n';
}
